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
