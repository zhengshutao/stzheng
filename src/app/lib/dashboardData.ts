import { supabase } from "@/app/lib/supabase";
import { computeCashBalance, computePositions } from "@/app/lib/stockPositions";
import { contractMultiplier, FX_CURRENCY, FX_TICKER } from "@/app/lib/instruments";
import {
  computeDailyPnl,
  createMarker,
  priceKey,
  totalInCurrency,
  type DayPnl,
  type Mark,
  type PriceBar,
  type PriceSeries,
} from "@/app/lib/dailyPnl";

// ---------- 行类型(对应 Supabase 表) ----------

export interface DailyTx {
  id: string;
  date: string;
  name: string | null;
  merchant: string | null;
  amount: number; // Plaid 约定: >0 支出, <0 收入
  currency: string;
  category: string | null;
  note: string | null;
  is_transfer: boolean;
  pending: boolean;
  source: string | null;
  institution_name: string | null;
  synced_at?: string | null;
  merge_group_id: string | null;
  /** 只在合并壳子行上有值:被收起来的原始记录,供展开查看/拆开用 */
  members?: DailyTx[];
  /** 只在合并壳子行上有值:组内金额绝对值最大那条原始记录的真实 id,编辑壳子的类别/备注时实际更新的是这一条 */
  primary_id?: string;
}

export interface StockTrade {
  id: string;
  date: string; // 交易日(成交日,美东)
  ts: string | null;
  ticker: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  currency: string;
  fees: number;
  account: string | null;
  realized_pnl: number | null;
  note: string | null;
  initial_stop: number | null;
  synced_at?: string | null;
}

export interface StockCash {
  id: string;
  date: string;
  type: "deposit" | "withdraw";
  amount: number;
  currency: string;
  account: string | null;
  note: string | null;
  synced_at?: string | null;
}

/** 拆股/合股/并购换股——没有成交价的公司行为,只改变持仓股数(总成本不变)。 */
export interface StockSplit {
  id: string;
  date: string;
  ts: string | null;
  ticker: string;
  currency: string;
  account: string | null;
  ratio: number; // 换股后股数 = 换股前股数 * ratio
  note: string | null;
  synced_at?: string | null;
}

export interface PriceSymbolRow {
  ticker: string;
  currency: string;
  symbol: string | null;
  through_date: string | null;
  status: string;
  last_error: string | null;
  updated_at: string | null;
}

export interface ImportLog {
  id: string;
  source: string;
  source_file: string | null;
  ran_at: string;
  trades_inserted: number;
  trades_updated: number;
  cash_inserted: number;
  cash_updated: number;
  touched_dates: string[];
  summary: string | null;
  pnl_diff?: {
    added: PnlDiffDay[];
    changed: PnlDiffDay[];
    removed: PnlDiffDay[];
  } | null;
  price_sync?: {
    today?: string;
    lastClosed?: string;
    fetched?: { key: string; symbol: string; bars: number; to: string | null }[];
    skipped?: number;
    notFound?: { key: string; open: boolean }[];
    errors?: { key: string; error: string }[];
    bars?: number;
    warning?: string;
  } | null;
  trade_changes?: {
    trades: { op: "insert" | "update"; date: string; ticker: string; side: string; qty: number; price: number; currency: string; account: string; changes?: Record<string, [unknown, unknown]> }[];
    cash: { op: "insert" | "update"; date: string; type: string; amount: number; currency: string; account: string; changes?: Record<string, [unknown, unknown]> }[];
  } | null;
}

export interface PnlDiffDay {
  date: string;
  before: Record<string, number> | null;
  after: Record<string, number> | null;
  positions: string[];
  reason?: "trades" | "prices" | "both";
}

/** 定时同步(edge function snaptrade-sync)最后一次检查的结果,不管有没有新记录都会更新 */
export interface SyncRun {
  source: string;
  checked_at: string;
  ok: boolean;
  message: string | null;
  new_trades: number;
  new_cash: number;
}

export interface DashboardData {
  transactions: DailyTx[];
  trades: StockTrade[];
  cash: StockCash[];
  splits: StockSplit[];
  /** 收盘价序列(ticker|ccy → 升序日K),汇率也在里面(USDCAD|FX) */
  prices: PriceSeries;
  priceSymbols: PriceSymbolRow[];
  importLogs: ImportLog[];
  syncRuns: SyncRun[];
  /** stock_prices 表还没建(schema.sql 没跑) */
  priceTableMissing: boolean;
}

export type Currency = "USD" | "CAD";

// PostgREST 单次最多返回 1000 行,分页拉全
export async function fetchAll<T>(table: string, orderCols: string | string[], columns = "*"): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from(table).select(columns);
    for (const col of Array.isArray(orderCols) ? orderCols : [orderCols]) {
      query = query.order(col, { ascending: true });
    }
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) {
      if (error.message.toLowerCase().includes("jwt issued at future")) {
        await supabase.auth.signOut({ scope: "local" });
        throw new Error(`${table}: 登录状态时间无效，已清除本地 session，请重新登录。`);
      }
      throw new Error(`${table}: ${error.message}`);
    }
    rows.push(...((data ?? []) as unknown as T[]));
    if (!data || data.length < PAGE) return rows;
  }
}

function isMissingTable(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("schema cache") || m.includes("does not exist") || m.includes("could not find the table");
}

interface PriceRow {
  ticker: string;
  currency: string;
  date: string;
  close: number;
}

export function priceSeriesFromRows(rows: PriceRow[]): PriceSeries {
  const map: PriceSeries = new Map();
  for (const r of rows) {
    const pk = priceKey(r.ticker, r.currency);
    let arr = map.get(pk);
    if (!arr) {
      arr = [];
      map.set(pk, arr);
    }
    arr.push({ date: r.date, close: Number(r.close) });
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return map;
}

export async function fetchDashboardData(): Promise<DashboardData> {
  const [transactions, trades, cash, splits, priceResult, symbolResult, importLogs, syncRuns] = await Promise.all([
    fetchAll<DailyTx>("daily_transactions", ["date", "id"]),
    fetchAll<StockTrade>("stock_trades", ["date", "ts", "id"]),
    fetchAll<StockCash>("stock_cash", ["date", "ts", "id"]),
    fetchAll<StockSplit>("stock_splits", ["date", "ts", "id"]),
    fetchAll<PriceRow>("stock_prices", ["ticker", "currency", "date"], "ticker,currency,date,close").then(
      (rows) => ({ rows, missing: false }),
      (e: Error) => {
        if (isMissingTable(e.message)) return { rows: [] as PriceRow[], missing: true };
        throw e;
      }
    ),
    fetchAll<PriceSymbolRow>("stock_price_symbols", ["ticker", "currency"]).catch((e: Error) => {
      if (isMissingTable(e.message)) return [] as PriceSymbolRow[];
      throw e;
    }),
    supabase
      .from("import_logs")
      .select("*")
      .order("ran_at", { ascending: false })
      .limit(8)
      .then(({ data, error }) => {
        if (error) {
          if (isMissingTable(error.message)) return [] as ImportLog[];
          throw new Error(`import_logs: ${error.message}`);
        }
        return (data ?? []) as ImportLog[];
      }),
    // 表还没建 / 读失败都不影响首页,卡片上就不显示"上次检查"
    supabase
      .from("sync_runs")
      .select("source,checked_at,ok,message,new_trades,new_cash")
      .then(({ data, error }) => (error ? [] : ((data ?? []) as SyncRun[]))),
  ]);
  return {
    transactions,
    trades,
    cash,
    splits,
    prices: priceSeriesFromRows(priceResult.rows),
    priceSymbols: symbolResult,
    importLogs,
    syncRuns,
    priceTableMissing: priceResult.missing,
  };
}

/**
 * 把共享 merge_group_id 的原始交易收起来,合成一条净额"壳子"记录 —— 原始记录本身不动,
 * 只是在展示/统计时把它们当一条:金额取代数和(比如聚餐 200 + 朋友转回 3x50,净额就是 50),
 * 日期/商家/类别取组内金额绝对值最大的那条(通常就是真正花钱的那笔),其余字段收进 members
 * 供展开查看或"拆开"用。没有 merge_group_id 的行原样透传。
 */
export function mergeGroupedTxns(transactions: DailyTx[]): DailyTx[] {
  const groups = new Map<string, DailyTx[]>();
  const out: DailyTx[] = [];

  for (const t of transactions) {
    if (!t.merge_group_id) {
      out.push(t);
      continue;
    }
    const g = groups.get(t.merge_group_id);
    if (g) g.push(t);
    else groups.set(t.merge_group_id, [t]);
  }

  for (const [groupId, members] of groups) {
    const primary = members.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
    const amount = members.reduce((sum, m) => sum + m.amount, 0);
    out.push({
      id: `merge:${groupId}`,
      date: primary.date,
      name: primary.name,
      merchant: primary.merchant,
      amount,
      currency: primary.currency,
      category: primary.category,
      note: primary.note,
      is_transfer: false,
      pending: members.some((m) => m.pending),
      source: "merged",
      institution_name: primary.institution_name,
      merge_group_id: groupId,
      members: members.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      primary_id: primary.id,
    });
  }

  return out;
}

// ---------- 汇率 ----------
//
// 展示用的汇率只用一个"当前值":历史每一天的盈亏都用同一个汇率折算,
// 这样相邻两天之间的差值只反映仓位/现金的真实变化,汇率波动不会渗进逐日盈亏里。

export function latestFx(data: DashboardData, liveFx?: number | null): number {
  if (liveFx && liveFx > 0) return liveFx;
  const fx = data.prices.get(priceKey(FX_TICKER, FX_CURRENCY));
  if (fx && fx.length) return fx[fx.length - 1].close;
  return 1.37;
}

// ---------- 每日盈亏 ----------

/** priceKey → 实时价。只用于"今天"这一格。 */
export type LiveMarks = Map<string, number>;

export function buildDailyPnl(data: DashboardData, today: string, liveMarks?: LiveMarks): Map<string, DayPnl> {
  return computeDailyPnl(data.trades, data.splits, data.prices, { today, liveMarks });
}

export type Scope = "all" | "daily" | "stock";

export interface DayAgg {
  daily: number; // 日常净变化(收入为正、支出为负),展示币种
  stock: number; // 股票当日盈亏,展示币种
  provisional: boolean; // 股票部分有腿用的不是真实收盘价
}

/** 每天的资产增减(展示币种)。日常剔除转账;股票 = 每日盈亏引擎的结果按固定汇率折算。 */
export function aggregateByDay(data: DashboardData, pnlByDay: Map<string, DayPnl>, ccy: Currency, fx: number): Map<string, DayAgg> {
  const map = new Map<string, DayAgg>();
  const get = (d: string) => {
    let v = map.get(d);
    if (!v) {
      v = { daily: 0, stock: 0, provisional: false };
      map.set(d, v);
    }
    return v;
  };
  // 日常记录目前全是 CAD,折算成展示币种也用同一个固定汇率,和股票那边保持一致。
  const toDisplay = (amountCad: number) => (ccy === "CAD" ? amountCad : amountCad / fx);

  for (const t of data.transactions) {
    if (t.is_transfer) continue;
    get(t.date).daily += toDisplay(-t.amount);
  }
  for (const [date, day] of pnlByDay) {
    const v = totalInCurrency(day.totalByCcy, ccy, fx);
    if (Math.abs(v) < 0.005 && !day.hasTrades) continue;
    const agg = get(date);
    agg.stock += v;
    if (day.provisional) agg.provisional = true;
  }
  return map;
}

export function dayNet(agg: DayAgg | undefined, scope: Scope): number {
  if (!agg) return 0;
  if (scope === "daily") return agg.daily;
  if (scope === "stock") return agg.stock;
  return agg.daily + agg.stock;
}

/** 原币种金额 → 展示币种 */
export function toDisplayCcy(amount: number, currency: string, ccy: Currency, fx: number): number {
  const cad = currency === "CAD" ? amount : amount * fx;
  return ccy === "CAD" ? cad : cad / fx;
}

// ---------- 行情覆盖状态 ----------

export interface PriceCoverage {
  /** 全部收盘价里最新的一天 */
  latestClose: string | null;
  /** 还持有的标的里,收盘价最早只到哪天(null = 没有持仓或完全没有价格) */
  heldThrough: string | null;
  /** 还持有、但完全没有价格数据的标的 */
  heldMissing: string[];
}

export function priceCoverage(data: DashboardData): PriceCoverage {
  let latestClose: string | null = null;
  for (const [pk, series] of data.prices) {
    if (pk === priceKey(FX_TICKER, FX_CURRENCY)) continue;
    const last = series[series.length - 1];
    if (last && (!latestClose || last.date > latestClose)) latestClose = last.date;
  }
  const positions = computePositions(data.trades, data.splits);
  let heldThrough: string | null = null;
  const heldMissing: string[] = [];
  const seen = new Set<string>();
  for (const p of positions) {
    const pk = priceKey(p.ticker, p.currency);
    if (seen.has(pk)) continue;
    seen.add(pk);
    const series = data.prices.get(pk);
    const last = series?.[series.length - 1];
    if (!last) {
      heldMissing.push(pk);
      continue;
    }
    if (!heldThrough || last.date < heldThrough) heldThrough = last.date;
  }
  return { latestClose, heldThrough, heldMissing };
}

// ---------- 总资产 ----------

export interface Totals {
  total: number; // 总资产 = 日常累计 + 股票(现金+持仓)
  dailyCum: number; // 日常累计净收支
  stockValue: number; // 组合市值(现金+持仓)
  stockCash: number;
  positionsValue: number;
  fx: number;
  /** 持仓估值用的是实时价还是收盘价 */
  marks: { live: number; close: number; other: number };
}

export function computeTotals(data: DashboardData, ccy: Currency, today: string, fx: number, liveMarks?: LiveMarks): Totals {
  let dailyCumCad = 0;
  for (const t of data.transactions) {
    if (!t.is_transfer) dailyCumCad += -t.amount;
  }
  const dailyCum = ccy === "CAD" ? dailyCumCad : dailyCumCad / fx;

  const cashBal = computeCashBalance(data.cash, data.trades);
  let cashUsd = 0;
  let cashCad = 0;
  for (const perCcy of Object.values(cashBal)) {
    cashUsd += perCcy.USD ?? 0;
    cashCad += perCcy.CAD ?? 0;
  }
  const stockCash = toDisplayCcy(cashUsd, "USD", ccy, fx) + toDisplayCcy(cashCad, "CAD", ccy, fx);

  const mark = createMarker(data.trades, data.prices, { today, liveMarks });
  const marks = { live: 0, close: 0, other: 0 };
  let positionsValue = 0;
  for (const p of computePositions(data.trades, data.splits)) {
    const m: Mark = mark(priceKey(p.ticker, p.currency), today);
    if (m.source === "live") marks.live++;
    else if (m.source === "close") marks.close++;
    else marks.other++;
    positionsValue += toDisplayCcy(p.qty * (m.price ?? p.avg_cost) * contractMultiplier(p.ticker), p.currency, ccy, fx);
  }
  const stockValue = stockCash + positionsValue;
  return { total: dailyCum + stockValue, dailyCum, stockValue, stockCash, positionsValue, fx, marks };
}

export type { DayPnl, PriceBar, PriceSeries };

// ---------- 格式化 ----------

export function fmtCad(n: number, opts: { sign?: boolean; compact?: boolean; ccy?: Currency } = {}): string {
  const sign = n < 0 ? "−" : opts.sign ? "+" : "";
  const prefix = opts.ccy === "USD" ? "" : "$";
  const suffix = opts.ccy === "USD" ? "USD" : "";
  const abs = Math.abs(n);
  if (opts.compact && abs >= 10000) {
    return `${sign}${prefix}${Math.round(abs / 1000)}k${suffix}`;
  }
  if (opts.compact && abs >= 1000) {
    return `${sign}${prefix}${(abs / 1000).toFixed(1)}k${suffix}`;
  }
  if (opts.compact) {
    return `${sign}${prefix}${abs.toFixed(0)}${suffix}`;
  }
  const s = abs.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${prefix}${s}${suffix}`;
}
