// SnapTrade 活动 → stock_trades / stock_cash 的映射、和库里已有记录的配对、写库。
// 本地脚本 scripts/snaptrade/sync-activities.mjs 和 edge function snaptrade-sync 共用:
// 不 import SDK(调用方传一个只读的 snap 适配器进来),不读环境变量、不碰文件。
//
// 和库里已有记录(WS CSV 导入的 ws_trade_* / 手动录入的)怎么去重:
//   SnapTrade 的 activity id 和 CSV 行的哈希对不上,所以不按 id,按内容配对 ——
//   账户 + 标的 + 方向 + 股数 + 日期(先同一天,再 ±1 天,因为 CSV 按"executed at"成交日记,
//   SnapTrade 的 trade_date 可能是下单日)。配上的视为已有,不写;只把配不上的当新增写入,
//   id 用 snap_trade_<activity.id>,下次同步再拉到同一条时按 id 直接认出来。
//
// SnapTrade 的交易记录(activities)一天只刷新一次、晚一天;当天的成交从"最近订单"(实时,最近 24 小时)拿:
// 已成交的订单先以 snap_order_<订单号> 写入,第二天 activity 到了按内容和它配上,不会重复记。

import { sessionDateOf } from "./marketTime.ts";
import { applyToSupabase } from "./stockApply.mjs";
import { fetchAllRows } from "./stockDb.mjs";

/**
 * snap 适配器(只读):
 *   listAccounts(): Promise<Account[]>
 *   activitiesPage(accountId, startDate | undefined, offset, limit): Promise<Activity[] | { data: Activity[] }>
 *   recentOrders?(accountId): Promise<Order[]>   —— 最近 24 小时的订单(实时)
 */

/** SDK 抛的错里带完整请求信息,只留状态码和简短原因,避免把账户数据打进日志。 */
export function snapError(what, e) {
  const status = e?.status ?? e?.response?.status ?? "?";
  const detail = e?.responseBody?.detail ?? e?.response?.data?.detail ?? e?.message ?? "";
  // 401 的 detail 会把收到的 clientId 原样回显("Invalid clientId provided - <值>"),截掉
  const clean = String(detail).replace(/(provided)\s*-\s*\S+/gi, "$1").slice(0, 200);
  return new Error(`SnapTrade ${what} → ${status} ${clean}`);
}

export async function listAccounts(snap) {
  try {
    return await snap.listAccounts();
  } catch (e) {
    throw snapError("listUserAccounts", e);
  }
}

export async function listActivities(snap, accountId, since) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    let page;
    try {
      page = await snap.activitiesPage(accountId, since ?? undefined, offset, 1000);
    } catch (e) {
      throw snapError("getAccountActivities", e);
    }
    const rows = Array.isArray(page) ? page : page.data ?? [];
    all.push(...rows);
    if (rows.length < 1000) return all;
  }
}

// ---------- 映射 ----------

// 按 SnapTrade 的 meta.unifiedAccountType 判断,不要看 name/raw_type:WS 的"投资组合信用额度"
// raw_type 也是 PERSONAL,按名字猜会被误当成非注册账户。
const ACCOUNT_BY_UNIFIED_TYPE = {
  SELF_DIRECTED_TFSA: "TFSA",
  SELF_DIRECTED_NON_REGISTERED: "NON-REG",
  SELF_DIRECTED_NON_REGISTERED_MARGIN: "NON-REG",
};

export function normalizeAccount(acct) {
  // 已关闭的账户也要读:老交易(比如 2025 年那个已关闭的 TFSA)在库里有,靠它们配对才不会被当成"库里独有"。
  // RRSP / FHSA / Chequing(MSB) / 信用卡 / 信用额度 / Crypto:不是股票记录页的账户
  return ACCOUNT_BY_UNIFIED_TYPE[acct.meta?.unifiedAccountType] ?? null;
}

/** WS CSV 的 OCC 写法:标的补齐到 6 位再接 YYMMDD+C/P+行权价(TSLA  260706C00405000)。 */
function wsOccTicker(occ) {
  const m = String(occ).trim().match(/^([A-Za-z.]{1,6})\s*(\d{6}[CP]\d{8})$/i);
  return m ? `${m[1].toUpperCase().padEnd(6)}${m[2].toUpperCase()}` : String(occ).trim().toUpperCase();
}

/** trade_date 只有日期(UTC 零点)就直接用;带具体时间的按美东交易日归属(晚 8 点后算次日)。 */
function tradeDateOf(a) {
  const raw = String(a.trade_date ?? a.settlement_date ?? "");
  if (!raw) return { date: null, ts: null };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { date: raw.slice(0, 10), ts: raw.slice(0, 10) };
  const dateOnly = /T00:00:00(\.0+)?(Z|\+00:00)?$/.test(raw) || raw.length === 10;
  return dateOnly ? { date: raw.slice(0, 10), ts: raw.slice(0, 10) } : { date: sessionDateOf(d), ts: d.toISOString() };
}

// 和 CSV 导入的口径一致:分红/利息当现金入账,账户间转账记成存/取
const CASH_IN = new Set(["CONTRIBUTION", "DEPOSIT", "DIVIDEND", "SUBSTITUTE_DIVIDEND", "INTEREST", "INTERNAL_CASH_TRANSFER_IN"]);
const CASH_OUT = new Set(["WITHDRAWAL", "FEE", "TAX", "INTERNAL_CASH_TRANSFER_OUT"]);
// 方向看金额正负
const CASH_BY_SIGN = new Set(["TRANSFER", "FUNDS_CONVERSION"]);

export function normalizeActivities(account, activities) {
  const trades = [];
  const cash = [];
  const skipped = [];
  for (const a of activities) {
    const type = String(a.type ?? "").toUpperCase();
    const { date, ts } = tradeDateOf(a);
    const currency = String(a.currency?.code ?? a.symbol?.currency?.code ?? "CAD").toUpperCase();
    const note = ["SnapTrade", type, a.option_type, a.description].filter(Boolean).join(" - ");
    const base = { date, ts, currency, account, note };
    if (!date) {
      skipped.push({ id: a.id, type, reason: "missing trade_date", description: a.description });
      continue;
    }

    if (type === "BUY" || type === "SELL") {
      const option = a.option_symbol?.ticker;
      const ticker = option ? wsOccTicker(option) : a.symbol?.symbol ?? a.symbol?.raw_symbol;
      const units = Math.abs(Number(a.units));
      const price = Math.abs(Number(a.price));
      if (!ticker || !units || !Number.isFinite(price)) {
        skipped.push({ id: a.id, type, reason: "trade missing symbol/units/price", description: a.description });
        continue;
      }
      trades.push({
        id: `snap_trade_${a.id}`,
        ...base,
        ticker: ticker.toUpperCase(),
        side: type === "BUY" ? "buy" : "sell",
        qty: units,
        // SnapTrade 期权价是每股权利金;库里 WS OCC 期权按每张合约总价记(乘数 1,见 instruments.ts),所以 ×100
        price: option ? Math.round(price * 100 * 10000) / 10000 : price,
        fees: Math.abs(Number(a.fee) || 0),
        realized_pnl: null,
        initial_stop: null,
      });
      continue;
    }

    const amount = Math.abs(Number(a.amount) || 0);
    let cashType = CASH_IN.has(type) ? "deposit" : CASH_OUT.has(type) ? "withdraw" : null;
    if (!cashType && CASH_BY_SIGN.has(type) && amount) cashType = Number(a.amount) > 0 ? "deposit" : "withdraw";
    if (cashType && amount) {
      cash.push({ id: `snap_cash_${a.id}`, ...base, type: cashType, amount });
      continue;
    }
    // OPTIONEXPIRATION / OPTIONASSIGNMENT / SPLIT / REI 等先不自动处理,预览里列出来人工确认
    skipped.push({ id: a.id, type, reason: "unmapped type", description: a.description, date });
  }
  return { trades, cash, skipped };
}

/** 最近订单里已成交的 → 交易行(和 activity 同一套字段)。部分成交的先不管,等全部成交或第二天的 activity。 */
export function normalizeOrders(account, orders) {
  const trades = [];
  for (const o of orders) {
    if (String(o.status ?? "").toUpperCase() !== "EXECUTED") continue;
    const action = String(o.action ?? "").toUpperCase();
    if (action !== "BUY" && action !== "SELL") continue;
    const option = o.option_symbol?.ticker;
    const ticker = option ? wsOccTicker(option) : o.universal_symbol?.symbol ?? o.symbol;
    const qty = Math.abs(Number(o.filled_quantity ?? o.total_quantity));
    const price = Math.abs(Number(o.execution_price));
    const when = new Date(String(o.time_executed ?? o.time_updated ?? o.time_placed ?? ""));
    if (!ticker || typeof ticker !== "string" || !qty || !Number.isFinite(price) || !price || Number.isNaN(when.getTime())) continue;
    const currency = String(o.universal_symbol?.currency?.code ?? o.option_symbol?.underlying_symbol?.currency?.code ?? "USD").toUpperCase();
    trades.push({
      id: `snap_order_${o.brokerage_order_id}`,
      date: sessionDateOf(when),
      ts: when.toISOString(),
      currency,
      account,
      note: ["SnapTrade order", action, o.order_type].filter(Boolean).join(" - "),
      ticker: ticker.toUpperCase(),
      side: action === "BUY" ? "buy" : "sell",
      qty,
      price: option ? Math.round(price * 100 * 10000) / 10000 : price,
      fees: 0,
      realized_pnl: null,
      initial_stop: null,
    });
  }
  return trades;
}

// ---------- 和库里已有记录配对 ----------

// SnapTrade 用改名后的新代码回显历史成交,库里(CSV 导入)是当时的旧代码。只用于配对,不改写库里的 ticker。
const TICKER_ALIASES = {
  BREA: "SLMT", // 2025-09
};
const tickerKey = (t) => {
  const k = String(t).toUpperCase().replace(/\s+/g, "").replace(/\.(TO|NE|CN|V)$/, "");
  return TICKER_ALIASES[k] ?? k;
};
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * 多重集合配对:每条已有记录最多被认领一次。按 offsets 依次放宽日期(先同一天,再 ±1 ...)。
 * 返回 { matched: [[incoming, existing]], unmatched: incoming[], dbOnly: existing[] }。
 */
function pairUp(incoming, existing, keyOf, offsets) {
  const pool = new Map();
  for (const row of existing) {
    const k = `${keyOf(row)}|${row.date}`;
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(row);
  }
  const matched = [];
  let rest = incoming;
  for (const off of offsets) {
    const next = [];
    for (const row of rest) {
      const bucket = pool.get(`${keyOf(row)}|${addDays(row.date, off)}`);
      if (bucket?.length) {
        // 同一天同股数的多笔:挑价格最接近的,不然会两两交叉配错
        let best = 0;
        for (let i = 1; i < bucket.length; i++) {
          if (Math.abs((bucket[i].price ?? 0) - (row.price ?? 0)) < Math.abs((bucket[best].price ?? 0) - (row.price ?? 0))) best = i;
        }
        matched.push([row, bucket.splice(best, 1)[0]]);
      } else next.push(row);
    }
    rest = next;
  }
  const dbOnly = [...pool.values()].flat();
  return { matched, unmatched: rest, dbOnly };
}

/**
 * 一笔订单分几次成交时,activity 可能是几条小的、订单行是一条合计的:同账户/标的/方向、日期 ±1 天、
 * 股数加起来等于订单的,算配上。只拿 snap_order_ 行做这种合计配对。
 */
function pairGroupsWithOrders(rest, orderRows) {
  const groupKey = (t) => `${t.account}|${tickerKey(t.ticker)}|${t.side}`;
  const groups = new Map();
  for (const r of rest) {
    const k = `${groupKey(r)}|${r.date}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const used = new Set();
  const matched = new Set();
  for (const rows of groups.values()) {
    const total = rows.reduce((s, r) => s + Number(r.qty), 0);
    const hit = orderRows.find(
      (o) => !used.has(o.id) && groupKey(o) === groupKey(rows[0]) && [0, -1, 1].some((d) => addDays(rows[0].date, d) === o.date) && Math.abs(Number(o.qty) - total) < 1e-4,
    );
    if (hit) {
      used.add(hit.id);
      for (const r of rows) matched.add(r);
    }
  }
  return { matched, unmatched: rest.filter((r) => !matched.has(r)) };
}

const tradeKey = (t) => `${t.account}|${tickerKey(t.ticker)}|${t.side}|${Number(t.qty).toFixed(4)}`;
const cashKey = (c) => `${c.account}|${c.type}|${Number(c.amount).toFixed(2)}|${c.currency}`;

/**
 * 拉 SnapTrade 活动、和库里配对,算出"要新增哪些"。apply=true 且有新增时写库(applyToSupabase)。
 * 返回配对的全部明细(本地脚本拿来打印预览),以及 result(写库结果;没写就是 null)。
 * @param {{ snap: any, client: any, userId: string, since?: string | null, apply?: boolean, log?: (m: string) => void }} opts
 */
export async function runSnaptradeSync({ snap, client, userId, since = null, apply = false, log = () => {} }) {
  const accounts = await listAccounts(snap);
  const incoming = { trades: [], cash: [], skipped: [], orders: [] };
  const perAccount = [];
  const rawSamples = [];
  for (const acct of accounts) {
    const account = normalizeAccount(acct);
    if (!account) continue;
    const activities = await listActivities(snap, acct.id, since);
    if (!rawSamples.length) rawSamples.push(...activities.slice(0, 5));
    const n = normalizeActivities(account, activities);
    perAccount.push({ account, activities: activities.length, trades: n.trades.length, cash: n.cash.length, skipped: n.skipped.length });
    incoming.trades.push(...n.trades);
    incoming.cash.push(...n.cash);
    incoming.skipped.push(...n.skipped);
    // 当天的成交:只看开着的账户
    if (snap.recentOrders && acct.status !== "closed") {
      let orders;
      try {
        orders = await snap.recentOrders(acct.id);
      } catch (e) {
        throw snapError("getUserAccountRecentOrders", e);
      }
      incoming.orders.push(...normalizeOrders(account, orders ?? []));
    }
  }

  const allDates = [...incoming.trades, ...incoming.cash, ...incoming.orders].map((r) => r.date).sort();
  const from = since ?? allDates[0];
  const to = allDates.at(-1);
  const base = { accounts, perAccount, rawSamples, incoming, from: from ?? null, to: to ?? null };
  if (!from || !to) return { ...base, empty: true, result: null };

  // 已有记录:同一 user 下 SnapTrade 覆盖的日期范围内的全部交易/现金(含 CSV 导入和手动录入的)
  const inRange = (q) => q.eq("user_id", userId).gte("date", addDays(from, -1)).lte("date", addDays(to, 1));
  const [dbTrades, dbCash, allDbCash] = await Promise.all([
    fetchAllRows(client, "stock_trades", "id,date,ts,ticker,side,qty,price,currency,fees,account", inRange, ["date", "ts"]),
    fetchAllRows(client, "stock_cash", "id,date,type,amount,currency,account,note", inRange, ["date"]),
    fetchAllRows(client, "stock_cash", "id,date", (q) => q.eq("user_id", userId), ["date"]),
  ]);

  // 之前已经由 SnapTrade 写进去的:id 直接对上,不再参与内容配对
  const dbIds = new Set([...dbTrades, ...dbCash].map((r) => r.id));
  const tradesNewById = incoming.trades.filter((t) => !dbIds.has(t.id));
  const cashNewById = incoming.cash.filter((c) => !dbIds.has(c.id));
  const ordersNewById = incoming.orders.filter((t) => !dbIds.has(t.id));
  // activity 和库里 CSV / 手动 / 当天订单写进去的行配对(snap_trade_ 的已经按 id 认出来了)
  const tpRaw = pairUp(tradesNewById, dbTrades.filter((t) => !t.id.startsWith("snap_trade_")), tradeKey, [0, -1, 1]);
  const grouped = pairGroupsWithOrders(tpRaw.unmatched, tpRaw.dbOnly.filter((t) => t.id.startsWith("snap_order_")));
  const tp = { ...tpRaw, unmatched: grouped.unmatched };
  // 当天订单和库里所有成交(包括之前的 activity)以及这一轮要新增的 activity 配对,配不上的才是真的新成交
  const op = pairUp(ordersNewById, [...dbTrades.filter((t) => !t.id.startsWith("snap_order_")), ...tp.unmatched], tradeKey, [0, -1, 1]);
  // 现金的历史口径和库里对不齐(SnapTrade 分红是扣税后净额、CSV 是毛额+预扣税两条;CSV 导入专门排除过几笔
  // 重复的账户间转账;库里还有手动"对齐余额"的校准记录),历史部分硬配会把钱重复算。所以现金只同步
  // 库里最后一笔非 SnapTrade 现金记录之后的,之前的只在预览里列出来不写。
  const cashCutoff = allDbCash.filter((c) => !c.id.startsWith("snap_")).map((c) => c.date).sort().at(-1) ?? "";
  const cashHistorical = cashNewById.filter((c) => c.date <= cashCutoff);
  const cashPool = dbCash.filter((c) => !c.id.startsWith("snap_"));
  const cp = pairUp(cashNewById.filter((c) => c.date > cashCutoff), cashPool.filter((c) => c.date > cashCutoff), cashKey, [0, -1, 1, -2, 2, -3, 3]);
  const priceDiffs = tp.matched.filter(([s, d]) => Math.abs(s.price - d.price) > Math.max(0.01, d.price * 0.002));

  const sinceDbOnly = (rows) => rows.filter((r) => r.date >= from && r.date <= to && !r.id.startsWith("snap_"));
  const plan = {
    ...base,
    empty: false,
    tradesNewById,
    cashNewById,
    tp,
    cp,
    cashCutoff,
    cashHistorical,
    cashHistoricalUnmatched: pairUp(cashHistorical, cashPool.filter((c) => c.date <= cashCutoff), cashKey, [0, -1, 1, -2, 2, -3, 3]).unmatched,
    priceDiffs,
    tradesDbOnly: sinceDbOnly(tp.dbOnly).filter((t) => !t.id.startsWith("snap_order_")),
    ordersNewById,
    op,
    // 现金只比 cutoff 之后的
    cashDbOnly: sinceDbOnly(cp.dbOnly).filter((c) => c.date > cashCutoff),
  };

  // 没有新记录就不写库:不然定时任务每次都会同步一遍收盘价、多一条空的 import_logs
  const newTrades = [...tp.unmatched, ...op.unmatched];
  if (!apply || (!newTrades.length && !cp.unmatched.length)) return { ...plan, result: null };
  const result = await applyToSupabase(client, userId, { trades: newTrades, cash: cp.unmatched }, `snaptrade ${from}..${to}`, {
    source: "snaptrade",
    log,
  });
  return { ...plan, result };
}
