import { supabase } from "@/app/lib/supabase";
import { contractMultiplier, replay } from "@/app/lib/stockPositions";

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
  merge_group_id: string | null;
  /** 只在合并壳子行上有值:被收起来的原始记录,供展开查看/拆开用 */
  members?: DailyTx[];
  /** 只在合并壳子行上有值:组内金额绝对值最大那条原始记录的真实 id,编辑壳子的类别/备注时实际更新的是这一条 */
  primary_id?: string;
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

export interface LiveQuote {
  c: number;
  pc: number | null;
}

/**
 * 某一天里,每个 ticker(不分账户)的盈亏,折算 CAD。
 * 用快照里当天/前一天的收盘价(每 ticker+currency 一价) + 当天成交,
 * 复刻 stockPositions.ts computeDayPnl 的公式:
 *   隔夜部分 = old_qty * (today_px - prev_px)
 *   当日买入 = bought * (today_px - buy_avg)
 *   当日卖出 = sold * (sell_avg - today_px)
 * 当天清仓(收盘快照里已不存在)时,用当天卖出均价代替 today_px。
 *
 * liveQuotes 只在 date 就是当前交易日时才该传——用实时行情兜底快照缺的价格
 * (比如新导入、快照还没跟上的 ticker),历史日期不适用实时价,调用方不传就行。
 */
export function computeStockDayPnl(
  data: DashboardData,
  date: string,
  liveQuotes?: Map<string, LiveQuote>
): TickerDayPnl[] {
  const snap = data.snapshots.find((s) => s.date === date);
  const prevSnap = data.snapshots.find((s) => s.date === prevDateStr(date));
  const todayPx = new Map<string, number>();
  const prevPx = new Map<string, number>();
  // key 统一大写——replay() 对 ticker 做过 toUpperCase(),trades/snapshot 里的原始大小写
  // 不一定一致(比如期权 ticker 是手输的自由文本 "TSLA Jul 27 $410 Call"),大小写不统一会导致
  // 同一个仓位在 oldQtyByKey(来自 replay)和 byKey(来自原始成交记录)里被当成两个不同的 key,
  // 拆成两行显示。
  for (const p of snap?.positions ?? []) {
    todayPx.set(`${p.ticker.toUpperCase()}|${p.currency}`, p.price);
  }
  for (const p of prevSnap?.positions ?? []) {
    prevPx.set(`${p.ticker.toUpperCase()}|${p.currency}`, p.price);
  }

  // 昨日持仓数量不用快照里的 positions(那是外部脚本推的,可能滞后于 stock_trades——
  // 比如某只票早就被真实成交平仓了,快照还在按老仓位继续算账面盈亏)。
  // 改用真实成交记录做 FIFO 回放,算出这一天开盘前实际还剩多少股,更可靠。
  const { positions: priorPositions } = replay(data.trades.filter((t) => t.date < date));
  const oldQtyByKey = new Map<string, number>();
  for (const p of priorPositions) {
    const key = `${p.ticker}|${p.currency}`;
    oldQtyByKey.set(key, (oldQtyByKey.get(key) ?? 0) + p.qty);
  }

  const todayTrades = data.trades.filter((t) => t.date === date);
  const byKey = new Map<string, { bought: number; buyNotional: number; sold: number; sellNotional: number }>();
  for (const t of todayTrades) {
    const key = `${t.ticker.toUpperCase()}|${t.currency}`;
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

  // ticker 范围只看"真实回放出来的昨日持仓"+"今天真实成交过的",
  // 不再直接并入快照 positions 里的 key——避免快照里那些早就平仓、
  // 但外部脚本还没同步到的"幽灵仓位"每天都冒出一笔看似真实的浮动盈亏。
  const keys = new Set<string>([...oldQtyByKey.keys(), ...byKey.keys()]);
  const out: TickerDayPnl[] = [];
  for (const key of keys) {
    const [ticker, currency] = key.split("|");
    const trade = byKey.get(key);
    const bought = trade?.bought ?? 0;
    const sold = trade?.sold ?? 0;
    // buyAvg/sellAvg 缺成交时是 null(不是 0),这样下面的 ?? 链在快照缺数据时才会
    // 老老实实往下找,而不是把"没有卖出"误当成"当天价格是 0"。
    const buyAvg = bought > 0 ? trade!.buyNotional / bought : null;
    const sellAvg = sold > 0 ? trade!.sellNotional / sold : null;
    const oldQty = oldQtyByKey.get(key) ?? 0;
    const live = liveQuotes?.get(key);
    // 价格来源优先级:快照(如果有)> 实时行情(仅当天有传)> 当天实际成交价 > 成本价。
    const todayPrice = todayPx.get(key) ?? live?.c ?? sellAvg ?? prevPx.get(key) ?? live?.pc ?? buyAvg ?? null;
    const prevPrice = prevPx.get(key) ?? live?.pc ?? buyAvg ?? todayPrice ?? null;
    // 如果连这些都拿不到(比如快照数据没跟上新导入的交易,也没传实时行情兜底),
    // 就没有任何可靠的当日价格来源——按成本价打平(当日盈亏记 0),
    // 而不是像之前那样悄悄假设成 $0/股,平白算出一笔离谱的"亏损"。
    // 期权按张(contract)交易,一张对应 100 股标的,价格是"每股"权利金,换算成金额要乘以 100。
    const multiplier = contractMultiplier(ticker);
    const pnl =
      todayPrice === null || prevPrice === null
        ? 0
        : (oldQty * (todayPrice - prevPrice) +
            (buyAvg !== null ? bought * (todayPrice - buyAvg) : 0) +
            (sellAvg !== null ? sold * (sellAvg - todayPrice) : 0)) *
          multiplier;
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
