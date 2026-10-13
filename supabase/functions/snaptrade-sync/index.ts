// 定时同步 —— pg_cron 每 10 分钟调一次:用 SnapTrade Personal API key 拉最近 14 天的 Wealthsimple 活动
// 和最近 24 小时已成交的订单(当天的成交只有订单接口是实时的),
// 和库里配对,配不上的写进 stock_trades / stock_cash(同时同步收盘价、写 import_logs)。
// 逻辑和本地 `npm run snaptrade:sync -- --apply` 是同一份(supabase/functions/_shared/snaptradeSync.mjs)。
//
// 每次运行(不管有没有新记录)都在 sync_runs 记一行"上次检查",首页同步卡片读它。
//
// 鉴权(verify_jwt 关掉,在这里自己做):
//   - pg_cron:请求头 x-sync-secret,和 Vault 里的 snaptrade_sync_secret 比对(RPC 只有 service_role 能调,
//     secret 本身不出数据库)。
//   - 手动触发:Bearer 是本人(PORTFOLIO_OWNER_USER_ID)登录的 JWT。
//
// 不返回、不记录任何金额 / 持仓;日志只记笔数和脱敏后的错误。
//
// Secrets:SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY, PORTFOLIO_OWNER_USER_ID(和 snaptrade-portfolio 共用)

import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Snaptrade, SnaptradeAuth } from "npm:snaptrade-typescript-sdk@12.2.14";
import { runSnaptradeSync } from "../_shared/snaptradeSync.mjs";
import { syncPrices } from "../_shared/priceSync.mjs";
import { lastClosedEtDate } from "../_shared/marketTime.ts";

const SINCE_DAYS = 14;
// 没有新成交时收盘价也要补(否则收盘后没交易,当天就一直是实时价)。syncPrices 只拉落后的标的,
// 但还持有的票当天没K线(假日 / 雅虎还没出)会每次重拉,所以定时任务最多每小时跑一次;
// 例外:上次检查之后又过了一次收盘(美东 16:10),马上跑。手动触发不限。
const PRICE_SYNC_INTERVAL_MS = 55 * 60 * 1000;

const DEFAULT_ORIGINS = [
  "https://www.stzheng.com",
  "https://stzheng.com",
  "http://localhost:8888",
  "http://127.0.0.1:8888",
  "http://localhost:8890",
];

function corsHeaders(req: Request): Record<string, string> {
  const env = Deno.env.get("PORTFOLIO_ALLOWED_ORIGINS");
  const allowed = env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store, private" },
  });
}

function snapAdapter() {
  const clientId = Deno.env.get("SNAPTRADE_CLIENT_ID");
  const consumerKey = Deno.env.get("SNAPTRADE_CONSUMER_KEY");
  if (!clientId || !consumerKey) throw new Error("SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY not configured");
  const st = new Snaptrade({ auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }) });
  return {
    listAccounts: async () => (await st.accountInformation.listUserAccounts()).data,
    activitiesPage: async (accountId: string, startDate: string | undefined, offset: number, limit: number) =>
      (await st.accountInformation.getAccountActivities({ accountId, startDate, offset, limit })).data,
    recentOrders: async (accountId: string) =>
      (await st.accountInformation.getUserAccountRecentOrders({ accountId })).data.orders ?? [],
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function maybeSyncPrices(service: ReturnType<typeof createClient>, ownerId: string, trigger: "cron" | "manual") {
  if (trigger === "cron") {
    const { data } = await service.from("sync_runs").select("checked_at").eq("user_id", ownerId).eq("source", "prices").maybeSingle();
    const last = data ? new Date(data.checked_at) : null;
    const crossedClose = !last || lastClosedEtDate(last) < lastClosedEtDate();
    if (last && !crossedClose && Date.now() - last.getTime() < PRICE_SYNC_INTERVAL_MS) return;
  }
  let ok = true;
  let message = "";
  try {
    const r = await syncPrices({ client: service, userId: ownerId });
    message = r.missingTable
      ? "stock_prices 表不存在"
      : `拉取 ${r.fetched.length} 个标的 ${r.bars} 天,收盘价截至 ${r.lastClosed}` + (r.errors.length ? `,出错 ${r.errors.length}` : "");
  } catch (e) {
    ok = false;
    message = String((e as Error)?.message ?? e).slice(0, 200);
  }
  const { error } = await service
    .from("sync_runs")
    .upsert({ user_id: ownerId, source: "prices", checked_at: new Date().toISOString(), ok, message, trigger }, { onConflict: "user_id,source" });
  if (error) console.error(`snaptrade-sync: prices sync_runs upsert failed: ${error.message}`);
  if (!ok) console.error(`snaptrade-sync: price sync failed: ${message}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method not allowed" });

  const ownerId = Deno.env.get("PORTFOLIO_OWNER_USER_ID");
  if (!ownerId) {
    console.error("snaptrade-sync: PORTFOLIO_OWNER_USER_ID not configured");
    return json(req, 500, { error: "server not configured" });
  }
  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // ---- 鉴权:cron 的 secret,或者本人登录 ----
  let trigger: "cron" | "manual" | null = null;
  const secret = req.headers.get("x-sync-secret");
  if (secret) {
    const { data, error } = await service.rpc("snaptrade_sync_secret_ok", { candidate: secret });
    if (error) console.error(`snaptrade-sync: secret check failed: ${error.message}`);
    if (data === true) trigger = "cron";
  } else {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const { data } = await service.auth.getUser(authHeader.slice(7));
      if (data.user?.id === ownerId) trigger = "manual";
      else if (data.user) return json(req, 403, { error: "forbidden" });
    }
  }
  if (!trigger) return json(req, 401, { error: "unauthorized" });

  // ---- 同步 ----
  const started = Date.now();
  let ok = true;
  let message = "";
  let newTrades = 0;
  let newCash = 0;
  try {
    const plan = await runSnaptradeSync({
      snap: snapAdapter(),
      client: service,
      userId: ownerId,
      since: daysAgo(SINCE_DAYS),
      apply: true,
      // 收盘价同步的逐行日志(ticker 和收盘价)不打,只留结果
      log: () => {},
    });
    newTrades = plan.result?.tradesInserted ?? 0;
    newCash = plan.result?.cashInserted ?? 0;
    message = plan.result ? plan.result.summary : plan.empty ? "SnapTrade 没有返回活动" : "没有新记录";
  } catch (e) {
    ok = false;
    // snapError 已经脱敏(去掉回显的 clientId);其它错误只留前 200 个字
    message = String((e as Error)?.message ?? e).replace(/(provided)\s*-\s*\S+/gi, "$1").slice(0, 200);
  }

  // 有新记录时 applyToSupabase 已经顺带同步过收盘价
  if (ok && !newTrades && !newCash) await maybeSyncPrices(service, ownerId, trigger);

  const { error: runError } = await service.from("sync_runs").upsert(
    {
      user_id: ownerId,
      source: "snaptrade",
      checked_at: new Date().toISOString(),
      ok,
      message,
      new_trades: newTrades,
      new_cash: newCash,
      trigger,
    },
    { onConflict: "user_id,source" },
  );
  if (runError) console.error(`snaptrade-sync: sync_runs upsert failed: ${runError.message}`);

  const ms = Date.now() - started;
  if (ok) console.log(`snaptrade-sync (${trigger}): +${newTrades} trades, +${newCash} cash, ${ms}ms`);
  else console.error(`snaptrade-sync (${trigger}) failed after ${ms}ms: ${message}`);
  return json(req, ok ? 200 : 502, { ok, trigger, newTrades, newCash, message: ok ? undefined : message });
});
