// 写库 + 同步收盘价 + 日历前后 diff + 写 import_logs。
// 本地脚本(WS CSV 导入、SnapTrade 同步)和 edge function snaptrade-sync 共用,不读环境变量、不碰文件。

import { computeDailyPnl, diffDailyPnl } from "./dailyPnl.ts";
import { etToday } from "./marketTime.ts";
import { loadPriceSeries, syncPrices } from "./priceSync.mjs";
import { fetchAllRows, isMissingTableError } from "./stockDb.mjs";

// ---------- 每日盈亏:同步前后对比 ----------
//
// 日历上的每日盈亏不落库,是 stock_trades + stock_splits + stock_prices 现算出来的
// (算法在 ./dailyPnl.ts,和前端同一份)。导入前后各算一遍做 diff,
// 就能告诉用户"这次同步改了日历上的哪几天、从多少变成多少"。

async function loadPnlInputs(client, userId) {
  const [trades, splits] = await Promise.all([
    fetchAllRows(client, "stock_trades", "id,date,ts,ticker,side,qty,price,currency,fees,account", (q) => q.eq("user_id", userId), ["date", "ts"]),
    fetchAllRows(client, "stock_splits", "date,ts,ticker,currency,account,ratio", (q) => q.eq("user_id", userId), ["date", "ts"]),
  ]);
  let prices = new Map();
  let pricesAvailable = true;
  try {
    prices = await loadPriceSeries(client);
  } catch (e) {
    if (!isMissingTableError(e)) throw e;
    pricesAvailable = false;
  }
  return { trades, splits, prices, pricesAvailable };
}

function fmtTotals(t) {
  if (!t) return "—";
  return Object.entries(t)
    .map(([ccy, v]) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} ${ccy}`)
    .join(" / ");
}

/** 一条日历变动的可读描述,比如 "2026-09-03 修改: +120.50 USD → +95.20 USD (交易变动) [ASST|USD|TFSA]" */
export function describeDayDiff(kind, d) {
  const label = kind === "added" ? "新增" : kind === "removed" ? "消失" : "修改";
  const reason = d.reason === "both" ? "交易+行情" : d.reason === "trades" ? "交易变动" : "行情更新";
  const amounts = kind === "added" ? fmtTotals(d.after) : kind === "removed" ? fmtTotals(d.before) : `${fmtTotals(d.before)} → ${fmtTotals(d.after)}`;
  const pos = d.positions.length ? ` [${d.positions.slice(0, 6).join(", ")}${d.positions.length > 6 ? ", …" : ""}]` : "";
  return `${d.date} ${label}: ${amounts} (${reason})${pos}`;
}

function summarizeTradeChange(row, prev, fields) {
  const base = { date: row.date, ticker: row.ticker, side: row.side, qty: row.qty, price: row.price, currency: row.currency, account: row.account };
  if (!prev) return { op: "insert", ...base };
  const changes = {};
  for (const f of fields) {
    if (rowsDiffer(row, prev, [f])) changes[f] = [prev[f] ?? null, row[f] ?? null];
  }
  return { op: "update", ...base, changes };
}

function summarizeCashChange(row, prev, fields) {
  const base = { date: row.date, type: row.type, amount: row.amount, currency: row.currency, account: row.account };
  if (!prev) return { op: "insert", ...base };
  const changes = {};
  for (const f of fields) {
    if (rowsDiffer(row, prev, [f])) changes[f] = [prev[f] ?? null, row[f] ?? null];
  }
  return { op: "update", ...base, changes };
}

async function fetchExistingRows(client, table, ids, columns) {
  const found = new Map();
  // PostgREST 用查询参数拼 .in() 的 id 列表 —— 一次塞太多会把请求 URL/headers 撑爆
  // (实测 500 个 id 就报 "Headers Overflow Error",服务端 16KB 上限),分小批查。
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    if (!chunk.length) continue;
    const { data, error } = await client.from(table).select(columns).in("id", chunk);
    if (error) throw new Error(`${table} row lookup failed: ${error.message}`);
    for (const row of data) found.set(row.id, row);
  }
  return found;
}

function rowsDiffer(a, b, fields) {
  return fields.some((f) => {
    const av = a[f];
    const bv = b[f];
    if (typeof av === "number" || typeof bv === "number") return Math.abs((av ?? 0) - (bv ?? 0)) > 0.005;
    return (av ?? null) !== (bv ?? null);
  });
}

/**
 * 把这批要 upsert 的行分成"新增"(id 之前没有)/"内容有变"(id 存在但字段不一样)/
 * "没变"(id 存在且内容完全一样,upsert 只是白跑一遍,不算触碰过)三类。
 * WS 导出是全量的,每次都会把整段历史重新递一遍——如果不分清楚"真的变了"和"内容照旧",
 * 每次同步都会把 touchedDates 撑到账户开户第一天,连带把所有历史快照都重算一遍。
 */
function classifyRows(rows, existingById, fields) {
  const inserted = [];
  const changed = [];
  const unchanged = [];
  for (const row of rows) {
    const prev = existingById.get(row.id);
    if (!prev) inserted.push(row);
    else if (rowsDiffer(row, prev, fields)) changed.push(row);
    else unchanged.push(row);
  }
  return { inserted, changed, unchanged };
}

/**
 * 写库 + 同步收盘价 + 日历前后 diff + 写 import_logs。SnapTrade 同步(scripts/snaptrade/)也复用这一段,
 * 只是 source 不同。normalized.dailyTx 可以省略。client 是 service-role 的 supabase-js。
 */
export async function applyToSupabase(client, userId, normalized, sourceFile, { source = "wealthsimple-csv", log = () => {} } = {}) {
  const nowIso = new Date().toISOString();
  const today = etToday();
  const trades = normalized.trades.map((row) => ({ ...row, user_id: userId, synced_at: nowIso }));
  const cash = normalized.cash.map((row) => ({ ...row, user_id: userId, synced_at: nowIso }));
  const dailyTx = (normalized.dailyTx ?? []).map((row) => ({ ...row, user_id: userId, synced_at: nowIso }));

  const TRADE_FIELDS = ["date", "ts", "ticker", "side", "qty", "price", "currency", "fees", "account", "note"];
  const CASH_FIELDS = ["date", "ts", "type", "amount", "currency", "account", "note"];
  const DAILY_FIELDS = ["date", "merchant", "amount", "currency", "note", "is_transfer", "institution_name"];

  // 同步前的日历(用当前库里的交易 + 已有收盘价)
  const before = await loadPnlInputs(client, userId);
  const pnlBefore = computeDailyPnl(before.trades, before.splits, before.prices, { today });

  const [existingTrades, existingCash, existingDaily] = await Promise.all([
    fetchExistingRows(client, "stock_trades", trades.map((t) => t.id), TRADE_FIELDS.concat("id").join(",")),
    fetchExistingRows(client, "stock_cash", cash.map((c) => c.id), CASH_FIELDS.concat("id").join(",")),
    fetchExistingRows(client, "daily_transactions", dailyTx.map((d) => d.id), DAILY_FIELDS.concat("id").join(",")),
  ]);

  const tradeGroups = classifyRows(trades, existingTrades, TRADE_FIELDS);
  const cashGroups = classifyRows(cash, existingCash, CASH_FIELDS);
  const dailyGroups = classifyRows(dailyTx, existingDaily, DAILY_FIELDS);

  const tradesToWrite = [...tradeGroups.inserted, ...tradeGroups.changed];
  const cashToWrite = [...cashGroups.inserted, ...cashGroups.changed];
  const dailyToWrite = [...dailyGroups.inserted, ...dailyGroups.changed];

  if (tradesToWrite.length) {
    const { error } = await client.from("stock_trades").upsert(tradesToWrite, { onConflict: "id" });
    if (error) throw new Error(`stock_trades upsert failed: ${error.message}`);
  }
  if (cashToWrite.length) {
    const { error } = await client.from("stock_cash").upsert(cashToWrite, { onConflict: "id" });
    if (error) throw new Error(`stock_cash upsert failed: ${error.message}`);
  }
  if (dailyToWrite.length) {
    const { error } = await client.from("daily_transactions").upsert(dailyToWrite, { onConflict: "id" });
    if (error) throw new Error(`daily_transactions upsert failed: ${error.message}`);
  }

  // 成交变动明细(给日志/给人看)。改了 date 的老记录会以 update 形式出现,changes 里能看到从哪天挪到哪天。
  const tradeChanges = [
    ...tradeGroups.inserted.map((r) => summarizeTradeChange(r, null, TRADE_FIELDS)),
    ...tradeGroups.changed.map((r) => summarizeTradeChange(r, existingTrades.get(r.id), TRADE_FIELDS)),
  ];
  const cashChanges = [
    ...cashGroups.inserted.map((r) => summarizeCashChange(r, null, CASH_FIELDS)),
    ...cashGroups.changed.map((r) => summarizeCashChange(r, existingCash.get(r.id), CASH_FIELDS)),
  ];
  // 涉及的日期:新值的日期 + 旧值的日期(挪了日期的记录两天都算)
  const touchedDates = [
    ...new Set([
      ...tradesToWrite.map((t) => t.date),
      ...tradeGroups.changed.map((t) => existingTrades.get(t.id)?.date).filter(Boolean),
      ...cashToWrite.map((c) => c.date),
    ]),
  ].sort();

  // 同步收盘价:新出现的 ticker / 新的日期立刻有价,今天收盘后跑一次今天就是真实收盘价
  let priceSync = null;
  let priceWarning = null;
  try {
    const r = await syncPrices({ client, userId, log });
    if (r.missingTable) {
      priceWarning = "stock_prices 表还没建:先在 Supabase SQL Editor 执行 supabase/schema.sql 末尾那段,日历才有收盘价。";
    } else {
      priceSync = {
        today: r.today,
        lastClosed: r.lastClosed,
        fetched: r.fetched,
        skipped: r.skipped,
        notFound: r.notFound,
        errors: r.errors,
        warnings: r.warnings,
        bars: r.bars,
      };
    }
  } catch (e) {
    priceWarning = `行情同步失败: ${String(e?.message ?? e)}`;
  }

  // 同步后的日历,和同步前 diff
  const after = await loadPnlInputs(client, userId);
  const pnlAfter = computeDailyPnl(after.trades, after.splits, after.prices, { today });
  const diff = diffDailyPnl(pnlBefore, pnlAfter);
  const touched = new Set(touchedDates);
  const tag = (list) =>
    list.map((d) => ({
      ...d,
      reason: touched.has(d.date) ? (priceSync && priceSync.bars > 0 ? "both" : "trades") : "prices",
    }));
  const pnlDiff = { added: tag(diff.added), changed: tag(diff.changed), removed: tag(diff.removed) };

  const result = {
    userId,
    tradesInserted: tradeGroups.inserted.length,
    tradesUpdated: tradeGroups.changed.length,
    cashInserted: cashGroups.inserted.length,
    cashUpdated: cashGroups.changed.length,
    dailyInserted: dailyGroups.inserted.length,
    dailyUpdated: dailyGroups.changed.length,
    touchedDates,
    tradeChanges,
    cashChanges,
    pnlDiff,
    priceSync,
    priceWarning,
  };

  const summary =
    `新增交易 ${result.tradesInserted} 笔 / 更新 ${result.tradesUpdated} 笔; ` +
    `新增现金 ${result.cashInserted} 笔 / 更新 ${result.cashUpdated} 笔; ` +
    `新增日常记录 ${result.dailyInserted} 笔 / 更新 ${result.dailyUpdated} 笔; ` +
    `日历: 新增 ${pnlDiff.added.length} 天 / 修改 ${pnlDiff.changed.length} 天 / 消失 ${pnlDiff.removed.length} 天; ` +
    (priceSync
      ? `行情: 拉取 ${priceSync.fetched.length} 个标的 ${priceSync.bars} 天, 收盘价截至 ${priceSync.lastClosed}` +
        (priceSync.notFound.length ? `, 无数据 ${priceSync.notFound.length}` : "") +
        (priceSync.errors.length ? `, 出错 ${priceSync.errors.length}` : "") +
        (priceSync.warnings.length ? `, 需核对 ${priceSync.warnings.length}` : "")
      : `行情: 未同步(${priceWarning ?? "unknown"})`);

  const logRow = {
    user_id: userId,
    source,
    source_file: sourceFile,
    trades_inserted: result.tradesInserted,
    trades_updated: result.tradesUpdated,
    cash_inserted: result.cashInserted,
    cash_updated: result.cashUpdated,
    touched_dates: touchedDates,
    snapshot_dates_ok: [],
    snapshot_dates_skipped: [],
    summary,
  };
  const extra = {
    pnl_diff: pnlDiff,
    price_sync: priceSync ?? { warning: priceWarning },
    trade_changes: { trades: tradeChanges.slice(0, 300), cash: cashChanges.slice(0, 100) },
  };
  let { error: logError } = await client.from("import_logs").insert({ ...logRow, ...extra });
  if (logError && /column/i.test(logError.message)) {
    log(`import_logs 还没有 pnl_diff/price_sync/trade_changes 列(先执行 schema.sql),这次只记基础字段: ${logError.message}`);
    ({ error: logError } = await client.from("import_logs").insert(logRow));
  }
  if (logError) throw new Error(`import_logs insert failed: ${logError.message}`);

  return { ...result, summary };
}
