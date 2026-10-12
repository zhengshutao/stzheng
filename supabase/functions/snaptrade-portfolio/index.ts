// 只读投资组合 —— 用 SnapTrade Personal API key 拉账户、余额、持仓、最近订单和活动,
// 整理成 view model 后返回给 /dashboard/portfolio 页面。
//
// 安全约束(改这个文件时保持):
//   - consumer key 只在这里(edge function secret),不进浏览器、不进日志、不进响应。
//   - Personal API key 代表本人:不调 registerSnapTradeUser,不传 userId / userSecret,不手写签名(用官方 SDK)。
//   - 只读:不调用任何下单 / 改单 / 撤单接口。
//   - 不落库、不缓存原始响应(Cache-Control: no-store);日志只记接口名和状态码,不记响应内容。
//   - 双重鉴权:Supabase JWT(平台 verify_jwt)+ 调用者必须是 PORTFOLIO_OWNER_USER_ID。
//     网站能注册账号的人不止你一个,只靠"已登录"不够。
//
// Secrets(Supabase Dashboard → Edge Functions → Secrets,或 `supabase secrets set`):
//   SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY, PORTFOLIO_OWNER_USER_ID
//   可选 PORTFOLIO_ALLOWED_ORIGINS(逗号分隔,默认 https://www.stzheng.com + 本地 vite 端口)

import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Snaptrade, SnaptradeAuth } from "npm:snaptrade-typescript-sdk@12.2.14";
import { ACTIVITY_PAGE_LIMIT, buildPortfolio, type PortfolioClient } from "../_shared/snaptradePortfolio.ts";

const DEFAULT_ORIGINS = [
  "https://www.stzheng.com",
  "https://stzheng.com",
  "http://localhost:8888",
  "http://127.0.0.1:8888",
  "http://localhost:8890",
];

function allowedOrigins(): string[] {
  const env = Deno.env.get("PORTFOLIO_ALLOWED_ORIGINS");
  return env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (allowedOrigins().includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store, private",
    },
  });
}

/** SDK → 只读的 PortfolioClient。SDK 实例只活在这个函数里,不会被序列化出去。 */
function snaptradeClient(): PortfolioClient {
  const clientId = Deno.env.get("SNAPTRADE_CLIENT_ID");
  const consumerKey = Deno.env.get("SNAPTRADE_CONSUMER_KEY");
  if (!clientId || !consumerKey) throw new Error("SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY not configured");
  const snaptrade = new Snaptrade({ auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }) });
  const info = snaptrade.accountInformation;
  return {
    listConnections: async () => (await snaptrade.connections.listBrokerageAuthorizations()).data,
    listAccounts: async () => (await info.listUserAccounts()).data,
    balances: async (accountId) => (await info.getUserAccountBalance({ accountId })).data,
    positions: async (accountId) => (await info.getAllAccountPositions({ accountId })).data,
    recentOrders: async (accountId) => (await info.getUserAccountRecentOrders({ accountId })).data.orders ?? [],
    activities: async (accountId, startDate) => {
      const page = (await info.getAccountActivities({ accountId, startDate, limit: ACTIVITY_PAGE_LIMIT })).data;
      return page.data ?? [];
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method not allowed" });

  // ---- 鉴权:必须是登录用户,且是本人 ----
  const ownerId = Deno.env.get("PORTFOLIO_OWNER_USER_ID");
  if (!ownerId) {
    console.error("snaptrade-portfolio: PORTFOLIO_OWNER_USER_ID not configured");
    return json(req, 500, { error: "server not configured" });
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json(req, 401, { error: "unauthorized" });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return json(req, 401, { error: "unauthorized" });
  if (userData.user.id !== ownerId) return json(req, 403, { error: "forbidden" });

  // ---- 拉数据 ----
  let client: PortfolioClient;
  try {
    client = snaptradeClient();
  } catch (e) {
    console.error(`snaptrade-portfolio: ${(e as Error).message}`);
    return json(req, 500, { error: "SnapTrade credentials are not configured on the server" });
  }

  const view = await buildPortfolio(client);

  // 只记哪些板块失败了(错误信息已经脱敏),不记任何金额/持仓
  const failures = [
    ...(view.connections.ok ? [] : [`connections: ${view.connections.error}`]),
    ...(view.accounts.ok ? [] : [`accounts: ${view.accounts.error}`]),
    ...(view.accounts.ok
      ? view.accounts.data.flatMap((a) =>
        (["balances", "positions", "orders", "activity"] as const)
          .filter((k) => a[k] && !a[k]!.ok)
          .map((k) => `${a.id.slice(0, 8)}/${k}`)
      )
      : []),
  ];
  if (failures.length) console.warn(`snaptrade-portfolio: partial failure — ${failures.join("; ")}`);

  return json(req, 200, view);
});
