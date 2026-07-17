import { supabase } from "@/app/lib/supabase";

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
}

export interface StockTrade {
  id: string;
  date: string;
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
}

export interface StockCash {
  id: string;
  date: string;
  type: "deposit" | "withdraw";
  amount: number;
  currency: string;
  account: string | null;
  note: string | null;
}

export interface StockSnapshot {
  date: string;
  value_cad: number;
  cash_cad: number | null;
  positions_value_cad: number | null;
  fx_usdcad: number | null;
  positions: { ticker: string; qty: number; price: number; currency: string }[] | null;
}

export interface DashboardData {
  transactions: DailyTx[];
  trades: StockTrade[];
  cash: StockCash[];
  snapshots: StockSnapshot[]; // 按日期升序
}

// PostgREST 单次最多返回 1000 行,分页拉全
async function fetchAll<T>(table: string, orderCol: string): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order(orderCol, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return rows;
  }
}

export async function fetchDashboardData(): Promise<DashboardData> {
  const [transactions, trades, cash, snapshots] = await Promise.all([
    fetchAll<DailyTx>("daily_transactions", "date"),
    fetchAll<StockTrade>("stock_trades", "date"),
    fetchAll<StockCash>("stock_cash", "date"),
    fetchAll<StockSnapshot>("stock_snapshots", "date"),
  ]);
  return { transactions, trades, cash, snapshots };
}

// ---------- 聚合 ----------

export type Scope = "all" | "daily" | "stock";

export interface DayAgg {
  daily: number; // 日常净变化(收入为正、支出为负),CAD
  stock: number; // 股票市值日变化,CAD
}

/** 每天的资产增减(CAD)。日常剔除转账;股票 = 快照相邻两日差,首日 = 首日市值。 */
export function aggregateByDay(data: DashboardData): Map<string, DayAgg> {
  const map = new Map<string, DayAgg>();
  const get = (d: string) => {
    let v = map.get(d);
    if (!v) {
      v = { daily: 0, stock: 0 };
      map.set(d, v);
    }
    return v;
  };

  for (const t of data.transactions) {
    if (t.is_transfer) continue;
    get(t.date).daily += -t.amount;
  }

  let prev: number | null = null;
  for (const s of data.snapshots) {
    const delta = prev === null ? s.value_cad : s.value_cad - prev;
    if (Math.abs(delta) >= 0.005) get(s.date).stock += delta;
    prev = s.value_cad;
  }

  return map;
}

export function dayNet(agg: DayAgg | undefined, scope: Scope): number {
  if (!agg) return 0;
  if (scope === "daily") return agg.daily;
  if (scope === "stock") return agg.stock;
  return agg.daily + agg.stock;
}

export interface TickerDayPnl {
  ticker: string;
  currency: string;
  qty: number; // 当天收盘后的持仓数量(可能为 0,代表当天清仓)
  pnl: number; // CAD
}

function prevDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 某一天里,每个 ticker(不分账户)的盈亏,折算 CAD。
 * 用快照里当天/前一天的收盘价(每 ticker+currency 一价) + 当天成交,
 * 复刻 stockPositions.ts computeDayPnl 的公式:
 *   隔夜部分 = old_qty * (today_px - prev_px)
 *   当日买入 = bought * (today_px - buy_avg)
 *   当日卖出 = sold * (sell_avg - today_px)
 * 当天清仓(收盘快照里已不存在)时,用当天卖出均价代替 today_px。
 */
export function computeStockDayPnl(data: DashboardData, date: string): TickerDayPnl[] {
  const snap = data.snapshots.find((s) => s.date === date);
  const prevSnap = data.snapshots.find((s) => s.date === prevDateStr(date));
  const todayPx = new Map<string, number>();
  const prevPx = new Map<string, number>();
  const prevQty = new Map<string, number>();
  for (const p of snap?.positions ?? []) {
    todayPx.set(`${p.ticker}|${p.currency}`, p.price);
  }
  for (const p of prevSnap?.positions ?? []) {
    prevPx.set(`${p.ticker}|${p.currency}`, p.price);
    prevQty.set(`${p.ticker}|${p.currency}`, p.qty);
  }

  const todayTrades = data.trades.filter((t) => t.date === date);
  const byKey = new Map<string, { bought: number; buyNotional: number; sold: number; sellNotional: number }>();
  for (const t of todayTrades) {
    const key = `${t.ticker}|${t.currency}`;
    const agg = byKey.get(key) ?? { bought: 0, buyNotional: 0, sold: 0, sellNotional: 0 };
    if (t.side === "buy") {
      agg.bought += t.qty;
      agg.buyNotional += t.qty * t.price;
    } else {
      agg.sold += t.qty;
      agg.sellNotional += t.qty * t.price;
    }
    byKey.set(key, agg);
  }

  const fx = snap?.fx_usdcad ?? prevSnap?.fx_usdcad ?? 1.37;
  const toCad = (amount: number, currency: string) => (currency === "CAD" ? amount : amount * fx);

  const keys = new Set<string>([...todayPx.keys(), ...prevPx.keys(), ...byKey.keys()]);
  const out: TickerDayPnl[] = [];
  for (const key of keys) {
    const [ticker, currency] = key.split("|");
    const trade = byKey.get(key);
    const bought = trade?.bought ?? 0;
    const sold = trade?.sold ?? 0;
    const buyAvg = bought > 0 ? trade!.buyNotional / bought : 0;
    const sellAvg = sold > 0 ? trade!.sellNotional / sold : 0;
    const oldQty = prevQty.get(key) ?? 0;
    const todayPrice = todayPx.get(key) ?? sellAvg ?? prevPx.get(key) ?? 0;
    const prevPrice = prevPx.get(key) ?? buyAvg ?? todayPrice;

    const pnl = oldQty * (todayPrice - prevPrice) + bought * (todayPrice - buyAvg) + sold * (sellAvg - todayPrice);
    if (Math.abs(pnl) < 0.005 && bought === 0 && sold === 0) continue;
    out.push({ ticker, currency, qty: oldQty + bought - sold, pnl: Math.round(toCad(pnl, currency) * 100) / 100 });
  }

  out.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  return out;
}

export interface Totals {
  total: number; // 总资产 = 日常累计 + 最新股票市值
  dailyCum: number; // 日常累计净收支
  stockValue: number; // 最新组合市值(现金+持仓)
  stockCash: number | null;
  fx: number | null;
  asOf: string | null; // 快照最新日期
}

export function computeTotals(data: DashboardData): Totals {
  let dailyCum = 0;
  for (const t of data.transactions) {
    if (!t.is_transfer) dailyCum += -t.amount;
  }
  const last = data.snapshots[data.snapshots.length - 1];
  const stockValue = last?.value_cad ?? 0;
  return {
    total: dailyCum + stockValue,
    dailyCum,
    stockValue,
    stockCash: last?.cash_cad ?? null,
    fx: last?.fx_usdcad ?? null,
    asOf: last?.date ?? null,
  };
}

// ---------- 格式化 ----------

export function fmtCad(n: number, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const sign = n < 0 ? "−" : opts.sign ? "+" : "";
  const abs = Math.abs(n);
  if (opts.compact && abs >= 10000) {
    return `${sign}$${Math.round(abs / 1000)}k`;
  }
  if (opts.compact && abs >= 1000) {
    return `${sign}$${(abs / 1000).toFixed(1)}k`;
  }
  if (opts.compact) {
    return `${sign}$${abs.toFixed(0)}`;
  }
  const s = abs.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${s}`;
}
