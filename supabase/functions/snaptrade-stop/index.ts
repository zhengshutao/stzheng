// 止损单 —— K 线页左侧持仓的"止损 xx.xx / 更新"。
//
//   {action: "list"}                    → 所有账户里挂着的卖出止损(StopsByTicker)
//   {action: "set", ticker, stop, basis} → 每个持有该股票的账户:撤掉旧止损 → 按全部持仓挂 Stop GTC @ stop
//                                          basis(ema10 / ema20 / custom)只是记下来,价格由前端算好传进来
//
// Wealthsimple 经 SnapTrade:
//   - 不支持 replaceOrder(501),改价只能撤单再下单,中间一两秒没有止损保护。
//   - 订单不回报 stop_price,所以每下一笔就记进 stock_stop_orders,显示时按订单 ID 对回来。
//   - 不支持幂等下单:失败不自动重试,把状态原样报回页面。
//
// 安全约束(改这个文件时保持):
//   - 和 snaptrade-portfolio 一样双重鉴权:Supabase JWT + 调用者必须是 PORTFOLIO_OWNER_USER_ID。
//   - 只会下"卖出止损";触发价必须低于现价、且不低于现价一半(防手滑),股数 = 该账户持仓。
//     现价用券商实时报价(持仓里的 price 会滞后),并且在撤旧单之前校验 —— 不合格就一张单都不动。
//   - 新单被券商拒(REJECTED,Wealthsimple 不给原因)时,旧单已经撤了 → 报 unprotected。
//   - 日志不记金额、股数、触发价。
//
// Secrets:SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY, PORTFOLIO_OWNER_USER_ID(和 snaptrade-portfolio 共用)
// 表:supabase/2026-10-12-stop-orders.sql

import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { Snaptrade, SnaptradeAuth } from "npm:snaptrade-typescript-sdk@12.2.14";
import { STOP_BASES, type SetStopAccountResult, type SetStopResult, type StopBasis, type StopView, type StopsByTicker } from "../_shared/stopOrders.ts";

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
    headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store, private" },
  });
}

// deno-lint-ignore no-explicit-any
type Order = any;
// deno-lint-ignore no-explicit-any
type Account = any;

function snaptrade(clientId: string, consumerKey: string) {
  return new Snaptrade({ auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }) });
}
type St = ReturnType<typeof snaptrade>;

const orderSymbol = (o: Order): string | undefined => o.universal_symbol?.symbol ?? undefined;
const isSellStop = (o: Order) => o.action === "SELL" && /^Stop(Limit)?$/i.test(o.order_type ?? "");
/** 信用卡、加密账户没有股票订单/持仓,直接跳过 */
const isStockAccount = (a: Account) => !/crypto|credit/i.test(a.meta?.type ?? a.raw_type ?? "");
const errMsg = (e: unknown) => {
  const body = (e as { responseBody?: { detail?: string } }).responseBody;
  return body?.detail ?? (e as Error).message ?? String(e);
};

async function listStops(st: St, db: SupabaseClient, accounts: Account[]): Promise<StopsByTicker> {
  const found: { o: Order; a: Account }[] = [];
  await Promise.all(
    accounts.map(async (a) => {
      const orders = (await st.accountInformation.getUserAccountOrders({ accountId: a.id, state: "open" })).data as Order[];
      for (const o of orders) if (isSellStop(o) && orderSymbol(o)) found.push({ o, a });
    })
  );
  const ids = found.map(({ o }) => o.brokerage_order_id);
  const known = new Map<string, { stop: number; basis: StopBasis }>();
  if (ids.length) {
    const { data, error } = await db.from("stock_stop_orders").select("brokerage_order_id, stop_price, basis").in("brokerage_order_id", ids);
    if (error) throw new Error(`stock_stop_orders: ${error.message}`);
    for (const r of data ?? []) known.set(r.brokerage_order_id, { stop: Number(r.stop_price), basis: r.basis });
  }
  const out: StopsByTicker = {};
  for (const { o, a } of found) {
    const view: StopView = {
      orderId: o.brokerage_order_id,
      accountId: a.id,
      accountName: a.name ?? a.id.slice(0, 8),
      units: Number(o.total_quantity),
      stop: known.get(o.brokerage_order_id)?.stop ?? (o.stop_price != null ? Number(o.stop_price) : null),
      basis: known.get(o.brokerage_order_id)?.basis ?? null,
      status: o.status,
      placedAt: o.time_placed ?? null,
    };
    (out[orderSymbol(o)!] ??= []).push(view);
  }
  return out;
}

/** 券商实时报价里最低的那个(买价 / 最新成交价);拿不到就退回持仓里的价格 */
async function livePrice(st: St, accountId: string, ticker: string, fallback: number): Promise<number> {
  try {
    const quotes = (await st.trading.getUserAccountQuotes({ accountId, symbols: ticker, useTicker: true })).data as Order[];
    const q = quotes.find((x) => x.symbol?.symbol === ticker) ?? quotes[0];
    const prices = [q?.bid_price, q?.last_trade_price].map(Number).filter((v) => Number.isFinite(v) && v > 0);
    return prices.length ? Math.min(...prices, fallback) : fallback;
  } catch {
    return fallback;
  }
}

/** 新单没出现在未成交里时,去全部订单里看它的最终状态 */
async function orderStatus(st: St, accountId: string, orderId: string): Promise<string | null> {
  try {
    const all = (await st.accountInformation.getUserAccountOrders({ accountId, state: "all", days: 1 })).data as Order[];
    return all.find((o) => o.brokerage_order_id === orderId)?.status ?? null;
  } catch {
    return null;
  }
}

async function setStop(
  st: St,
  db: SupabaseClient,
  ownerId: string,
  accounts: Account[],
  ticker: string,
  stop: number,
  basis: StopBasis
): Promise<{ status: number; body: SetStopResult | { error: string } }> {
  // 先把所有持有该股票的账户找齐、全部校验通过,再动任何订单
  const holdings: { a: Account; units: number; price: number }[] = [];
  for (const a of accounts) {
    const res = (await st.accountInformation.getAllAccountPositions({ accountId: a.id })).data as { results?: Order[] };
    const p = (res.results ?? []).find((x) => x.instrument?.symbol === ticker && Number(x.units) > 0);
    if (p) holdings.push({ a, units: Number(p.units), price: Number(p.price) });
  }
  if (!holdings.length) return { status: 400, body: { error: `没有账户持有 ${ticker}` } };
  for (const h of holdings) {
    const ref = await livePrice(st, h.a.id, ticker, h.price);
    if (!(stop < ref)) return { status: 400, body: { error: `触发价 ${stop} 不低于现价 ${ref},卖出止损会被拒或立刻触发。旧止损没动` } };
    if (stop < ref * 0.5) return { status: 400, body: { error: `触发价 ${stop} 低于现价 ${ref} 的一半,像是输错了。旧止损没动` } };
  }

  const results: SetStopAccountResult[] = [];
  for (const { a, units } of holdings) {
    const r: SetStopAccountResult = { accountId: a.id, accountName: a.name ?? a.id.slice(0, 8), units, canceled: [], orderId: null };
    results.push(r);
    const open = (await st.accountInformation.getUserAccountOrders({ accountId: a.id, state: "open" })).data as Order[];
    const old = open.filter((o: Order) => isSellStop(o) && orderSymbol(o) === ticker);

    // 先撤:不撤的话新旧两笔卖单加起来超过持仓,券商会拒;撤失败就不下新单,旧止损保持原样
    try {
      for (const o of old) {
        await st.trading.cancelOrder({ accountId: a.id, brokerage_order_id: o.brokerage_order_id });
        r.canceled.push(o.brokerage_order_id);
      }
    } catch (e) {
      // 有多笔旧止损、撤到一半失败时,已撤的那部分股数就没保护了
      r.error = `撤旧止损失败:${errMsg(e)}`;
      r.unprotected = r.canceled.length > 0;
      continue;
    }
    if (r.canceled.length) {
      await db.from("stock_stop_orders").update({ canceled_at: new Date().toISOString() }).in("brokerage_order_id", r.canceled);
    }

    try {
      const placed = (
        await st.trading.placeForceOrder({
          account_id: a.id,
          action: "SELL",
          order_type: "Stop",
          time_in_force: "GTC",
          symbol: ticker,
          universal_symbol_id: null,
          units,
          stop,
        })
      ).data as Order;
      r.orderId = placed.brokerage_order_id;
    } catch (e) {
      r.error = `下新止损失败:${errMsg(e)}`;
      r.unprotected = true;
      continue;
    }
    const { error } = await db.from("stock_stop_orders").insert({
      user_id: ownerId,
      ticker,
      account_id: a.id,
      brokerage_order_id: r.orderId,
      stop_price: stop,
      units,
      basis,
    });
    // 单已经挂上了,只是页面上会显示"价格未知",不算失败
    if (error) console.error(`snaptrade-stop: record insert failed: ${error.message}`);
  }

  // 券商要一两秒才把新单列出来
  await new Promise((res) => setTimeout(res, 1500));
  const stops = await listStops(st, db, accounts);
  const live = new Set((stops[ticker] ?? []).map((s) => s.orderId));
  for (const r of results) {
    if (r.error || !r.orderId || live.has(r.orderId)) continue;
    const status = await orderStatus(st, r.accountId, r.orderId);
    if (status && /REJECT|CANCEL|EXPIRE/i.test(status)) {
      r.error = `券商拒单(${status},Wealthsimple 不给原因;常见是触发价不低于当时的买价)`;
      r.unprotected = true;
      await db.from("stock_stop_orders").update({ canceled_at: new Date().toISOString() }).eq("brokerage_order_id", r.orderId);
    } else {
      r.error = `已提交(${status ?? "状态未知"}),但还没在未成交订单里看到,去 Wealthsimple 确认一下`;
    }
  }
  return { status: 200, body: { ok: results.every((r) => !r.error), ticker, stop, basis, accounts: results, stops } };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method not allowed" });

  // ---- 鉴权:必须是登录用户,且是本人 ----
  const ownerId = Deno.env.get("PORTFOLIO_OWNER_USER_ID");
  if (!ownerId) {
    console.error("snaptrade-stop: PORTFOLIO_OWNER_USER_ID not configured");
    return json(req, 500, { error: "server not configured" });
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json(req, 401, { error: "unauthorized" });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await db.auth.getUser();
  if (userError || !userData.user) return json(req, 401, { error: "unauthorized" });
  if (userData.user.id !== ownerId) return json(req, 403, { error: "forbidden" });

  const clientId = Deno.env.get("SNAPTRADE_CLIENT_ID");
  const consumerKey = Deno.env.get("SNAPTRADE_CONSUMER_KEY");
  if (!clientId || !consumerKey) return json(req, 500, { error: "SnapTrade credentials are not configured on the server" });
  const st = snaptrade(clientId, consumerKey);

  const body = await req.json().catch(() => ({}));
  try {
    const accounts = ((await st.accountInformation.listUserAccounts()).data as Account[]).filter(isStockAccount);
    if (body.action === "list") return json(req, 200, { stops: await listStops(st, db, accounts) });
    if (body.action === "set") {
      const ticker = String(body.ticker ?? "").toUpperCase();
      const stop = Math.round(Number(body.stop) * 100) / 100;
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return json(req, 400, { error: "ticker 不合法" });
      if (!(Number.isFinite(stop) && stop > 0)) return json(req, 400, { error: "stop 必须是正数" });
      const basis = (body.basis ?? "custom") as StopBasis;
      if (!STOP_BASES.includes(basis)) return json(req, 400, { error: "basis 必须是 ema10 / ema20 / custom" });
      const r = await setStop(st, db, ownerId, accounts, ticker, stop, basis);
      if ("accounts" in r.body) {
        console.log(`snaptrade-stop set ${ticker}: ${r.body.accounts.map((a) => (a.error ? `${a.accountId.slice(0, 8)} failed` : `${a.accountId.slice(0, 8)} ok`)).join(", ")}`);
      }
      return json(req, r.status, r.body);
    }
    return json(req, 400, { error: "unknown action" });
  } catch (e) {
    console.error(`snaptrade-stop: ${errMsg(e)}`);
    return json(req, 502, { error: errMsg(e) });
  }
});
