// 每日盈亏引擎 —— 纯函数、零外部依赖。前端页面和 Node 同步脚本 import 的是同一份文件,
// 所以日历上看到的数字和导入日志里"哪几天变了"用的是完全一样的算法。
//
// 核心公式(每个 ticker+币种+账户 每个交易日一行):
//
//   当日盈亏 = 收盘持仓 × 当日收盘价
//            − 开盘持仓 × 前一日收盘价
//            − 当日买入总额(含手续费)
//            + 当日卖出总额(扣手续费)
//
// 这一条式子自动覆盖所有情况,不需要分支:
//   昨天买今天没卖      → qty × (今收 − 昨收)
//   昨天买今天卖了      → 卖出额 − qty × 昨收
//   今天买今天没卖      → qty × 今收 − 买入额
//   今天买今天卖        → 卖出额 − 买入额
//   部分卖/加仓/多笔    → 各项自然相加
// 而且一段持仓从开仓到清仓的每日盈亏之和 == FIFO 已实现盈亏(含手续费),两边永远对得上。
//
// 价格取值(mark)的优先级,见 createMarker():
//   1. stock_prices 里这一天的真实收盘价
//   2. 只对"今天":页面传进来的实时价(盘中看到的是浮动值,收盘同步后自动变成真实收盘价)
//   3. 之前最近一天的收盘价(行情还没同步到这天 / 停牌 / 退市)—— 当天变动记 0,等同步后自动补上
//   4. 这只票在此之前最近一笔成交价(雅虎完全没有这只票的数据,比如已到期的期权)
// 用同一个函数取"今收"和"昨收",所以不管数据补到哪一步,相邻两天之间永远不会重复算或漏算。
//
// 拆股/合股:stock_prices 存的是"当时的原始收盘价"(同步脚本已经把雅虎的回调价还原了),
// 和成交价同一口径,所以这里只需要在拆股日把持仓股数乘以比例,估值直接 股数 × 当天原始收盘价。
// 拆股日的盈亏 = 拆股后股数 × 今收 − 拆股前股数 × 昨收,自然不会冒出假盈亏。

import { contractMultiplier } from "./instruments.ts";

export interface PnlTrade {
  id?: string;
  date: string; // 交易日(YYYY-MM-DD,美东)—— 就是日历上归属的那天
  ts: string | null;
  ticker: string;
  currency: string;
  account: string | null;
  side: "buy" | "sell";
  qty: number;
  price: number;
  fees: number | null;
}

export interface PnlSplit {
  date: string;
  ts: string | null;
  ticker: string;
  currency: string;
  account: string | null;
  ratio: number; // 换股后股数 = 换股前股数 × ratio
}

export interface PriceBar {
  date: string;
  close: number;
}

/** priceKey → 按日期升序的收盘价序列 */
export type PriceSeries = Map<string, PriceBar[]>;

export type MarkSource = "close" | "live" | "carried" | "trade" | "none";

export interface Mark {
  price: number | null;
  source: MarkSource;
}

export interface PositionDayPnl {
  key: string; // ticker|currency|account
  ticker: string;
  currency: string;
  account: string;
  qtyStart: number;
  qtyEnd: number;
  bought: number;
  sold: number;
  buyCost: number; // 含手续费
  sellProceeds: number; // 扣手续费
  fees: number;
  prevMark: number | null;
  prevSource: MarkSource;
  mark: number | null;
  markSource: MarkSource;
  pnl: number; // 原币种
  warning?: string;
}

export interface DayPnl {
  date: string;
  positions: PositionDayPnl[];
  totalByCcy: Record<string, number>;
  hasTrades: boolean;
  /** 今收不是真实收盘价(实时价 / 行情没同步到这天 / 只能拿成交价兜底)—— 数字以后还会变 */
  provisional: boolean;
}

export interface DailyPnlOptions {
  /** 当前交易日(美东日期)。实时价只会用在这一天。 */
  today: string;
  /** priceKey → 实时价 */
  liveMarks?: Map<string, number>;
}

const EPS = 1e-9;

export function priceKey(ticker: string, currency: string): string {
  return `${ticker.trim().toUpperCase()}|${currency.trim().toUpperCase()}`;
}

export function positionKey(ticker: string, currency: string, account: string | null): string {
  return `${priceKey(ticker, currency)}|${(account ?? "TFSA").trim().toUpperCase()}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function tsOf(x: { ts: string | null; date: string }): string {
  return x.ts ?? `${x.date}T00:00:00`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 二分:series 里 date 恰好等于 d 的下标,没有返回 -1 */
function indexOfDate(series: PriceBar[], d: string): number {
  let lo = 0;
  let hi = series.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cmp(series[mid].date, d);
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** 二分:series 里 date 严格小于 d 的最后一个下标,没有返回 -1 */
function lastIndexBefore(series: PriceBar[], d: string): number {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date < d) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export type Marker = (pk: string, date: string) => Mark;

/**
 * 生成取价函数 mark(priceKey, date)。trades 用于第 4 级兜底(最近一笔成交价),
 * 所以传进来的应该是全部交易(不分账户)。
 */
export function createMarker(trades: PnlTrade[], prices: PriceSeries, opts: DailyPnlOptions): Marker {
  const tradesByPk = new Map<string, PnlTrade[]>();
  for (const t of trades) {
    const pk = priceKey(t.ticker, t.currency);
    const arr = tradesByPk.get(pk);
    if (arr) arr.push(t);
    else tradesByPk.set(pk, [t]);
  }
  for (const arr of tradesByPk.values()) {
    arr.sort((a, b) => cmp(a.date, b.date) || cmp(tsOf(a), tsOf(b)));
  }

  return (pk: string, date: string): Mark => {
    const series = prices.get(pk);
    if (series && series.length) {
      const i = indexOfDate(series, date);
      if (i >= 0) return { price: series[i].close, source: "close" };
    }
    if (date === opts.today) {
      const live = opts.liveMarks?.get(pk);
      if (live !== undefined && live !== null && Number.isFinite(live) && live > 0) {
        return { price: live, source: "live" };
      }
    }
    if (series && series.length) {
      const j = lastIndexBefore(series, date);
      if (j >= 0) return { price: series[j].close, source: "carried" };
    }
    const arr = tradesByPk.get(pk);
    if (arr) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].date <= date) return { price: arr[i].price, source: "trade" };
      }
    }
    return { price: null, source: "none" };
  };
}

type PosEvent =
  | { kind: "split"; date: string; ts: string; split: PnlSplit }
  | { kind: "trade"; date: string; ts: string; trade: PnlTrade };

interface PosGroup {
  ticker: string;
  currency: string;
  account: string;
  events: PosEvent[];
}

function groupByPosition(trades: PnlTrade[], splits: PnlSplit[]): Map<string, PosGroup> {
  const groups = new Map<string, PosGroup>();
  const get = (ticker: string, currency: string, account: string | null) => {
    const key = positionKey(ticker, currency, account);
    let g = groups.get(key);
    if (!g) {
      g = {
        ticker: ticker.trim().toUpperCase(),
        currency: currency.trim().toUpperCase(),
        account: (account ?? "TFSA").trim().toUpperCase(),
        events: [],
      };
      groups.set(key, g);
    }
    return g;
  };
  for (const t of trades) get(t.ticker, t.currency, t.account).events.push({ kind: "trade", date: t.date, ts: tsOf(t), trade: t });
  for (const s of splits) get(s.ticker, s.currency, s.account).events.push({ kind: "split", date: s.date, ts: tsOf(s), split: s });
  for (const g of groups.values()) {
    // 同一天:拆股先于交易(公司行为在开盘前生效),其余按时间
    g.events.sort((a, b) => cmp(a.date, b.date) || (a.kind === b.kind ? cmp(a.ts, b.ts) : a.kind === "split" ? -1 : 1));
  }
  return groups;
}

/**
 * 逐日逐仓位算盈亏。返回 date → DayPnl(只包含有持仓或有成交的日子;没变化的日子不出现)。
 */
export function computeDailyPnl(
  trades: PnlTrade[],
  splits: PnlSplit[],
  prices: PriceSeries,
  opts: DailyPnlOptions
): Map<string, DayPnl> {
  const mark = createMarker(trades, prices, opts);
  const groups = groupByPosition(trades, splits);
  const out = new Map<string, DayPnl>();

  const dayOf = (date: string): DayPnl => {
    let d = out.get(date);
    if (!d) {
      d = { date, positions: [], totalByCcy: {}, hasTrades: false, provisional: false };
      out.set(date, d);
    }
    return d;
  };

  for (const [key, g] of groups) {
    if (g.events.length === 0) continue;
    const pk = priceKey(g.ticker, g.currency);
    const mult = contractMultiplier(g.ticker);

    const firstDate = g.events[0].date;
    const lastEventDate = g.events[g.events.length - 1].date;
    const endDate = lastEventDate > opts.today ? lastEventDate : opts.today;

    let qty = 0;
    let ei = 0;
    for (let d = firstDate; d <= endDate; d = addDays(d, 1)) {
      const qtyStart = qty;
      let bought = 0;
      let sold = 0;
      let buyCost = 0;
      let sellProceeds = 0;
      let fees = 0;
      let hadTrade = false;
      while (ei < g.events.length && g.events[ei].date === d) {
        const e = g.events[ei++];
        if (e.kind === "split") {
          qty *= e.split.ratio;
          continue;
        }
        const t = e.trade;
        const fee = t.fees ?? 0;
        hadTrade = true;
        fees += fee;
        if (t.side === "buy") {
          qty += t.qty;
          bought += t.qty;
          buyCost += t.qty * t.price * mult + fee;
        } else {
          qty -= t.qty;
          sold += t.qty;
          sellProceeds += t.qty * t.price * mult - fee;
        }
      }
      const qtyEnd = qty;
      const flatAllDay = Math.abs(qtyStart) < EPS && Math.abs(qtyEnd) < EPS;
      if (!hadTrade && flatAllDay) {
        // 已经清仓、后面也没有事件了:这个仓位到此为止
        if (ei >= g.events.length) break;
        continue;
      }

      const prev = mark(pk, addDays(d, -1));
      const cur = mark(pk, d);
      const startVal = Math.abs(qtyStart) < EPS ? 0 : qtyStart * (prev.price ?? 0) * mult;
      const endVal = Math.abs(qtyEnd) < EPS ? 0 : qtyEnd * (cur.price ?? 0) * mult;
      const pnl = endVal - startVal - buyCost + sellProceeds;

      if (!hadTrade && Math.abs(pnl) < 0.005) continue;

      const row: PositionDayPnl = {
        key,
        ticker: g.ticker,
        currency: g.currency,
        account: g.account,
        qtyStart: round4(qtyStart),
        qtyEnd: round4(qtyEnd),
        bought,
        sold,
        buyCost,
        sellProceeds,
        fees,
        prevMark: Math.abs(qtyStart) < EPS ? null : prev.price,
        prevSource: Math.abs(qtyStart) < EPS ? "none" : prev.source,
        mark: Math.abs(qtyEnd) < EPS ? null : cur.price,
        markSource: Math.abs(qtyEnd) < EPS ? "none" : cur.source,
        pnl,
      };
      if (qtyEnd < -EPS) row.warning = `持仓为负(${round4(qtyEnd)}),可能缺少买入记录或数量填错`;

      const day = dayOf(d);
      day.positions.push(row);
      day.totalByCcy[g.currency] = (day.totalByCcy[g.currency] ?? 0) + pnl;
      if (hadTrade) day.hasTrades = true;
      // "昨收"沿用更早一天的收盘价是正常的(周末/假日),不算临时值;
      // 今收用了实时价 / 沿用旧价 / 成交价兜底,或者昨收只能拿成交价兜底,才算。
      if ((row.markSource !== "none" && row.markSource !== "close") || row.prevSource === "trade") {
        day.provisional = true;
      }
    }
  }

  for (const day of out.values()) {
    day.positions.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  }
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 原币种合计 → 展示币种。汇率只用一个"当前值",历史比较不受汇率波动干扰。 */
export function totalInCurrency(totalByCcy: Record<string, number>, display: "USD" | "CAD", fxUsdCad: number): number {
  let cad = 0;
  for (const [ccy, v] of Object.entries(totalByCcy)) cad += ccy === "CAD" ? v : v * fxUsdCad;
  return display === "CAD" ? cad : cad / fxUsdCad;
}

// ---------- 同步前后对比(导入日志用) ----------

export interface DayDiff {
  date: string;
  before: Record<string, number> | null;
  after: Record<string, number> | null;
  /** 这一天里数字变了的仓位(ticker|ccy|account),给人看 */
  positions: string[];
}

export interface PnlDiff {
  added: DayDiff[];
  changed: DayDiff[];
  removed: DayDiff[];
}

function totalsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) >= 0.005) return false;
  return true;
}

function roundTotals(t: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(t)) out[k] = round2(v);
  return out;
}

export function diffDailyPnl(before: Map<string, DayPnl>, after: Map<string, DayPnl>): PnlDiff {
  const dates = [...new Set([...before.keys(), ...after.keys()])].sort();
  const diff: PnlDiff = { added: [], changed: [], removed: [] };
  for (const date of dates) {
    const b = before.get(date);
    const a = after.get(date);
    if (!b && a) {
      diff.added.push({ date, before: null, after: roundTotals(a.totalByCcy), positions: a.positions.map((p) => p.key) });
      continue;
    }
    if (b && !a) {
      diff.removed.push({ date, before: roundTotals(b.totalByCcy), after: null, positions: b.positions.map((p) => p.key) });
      continue;
    }
    if (!b || !a) continue;
    const bPos = new Map(b.positions.map((p) => [p.key, p.pnl]));
    const aPos = new Map(a.positions.map((p) => [p.key, p.pnl]));
    const changedPositions = [...new Set([...bPos.keys(), ...aPos.keys()])].filter(
      (k) => Math.abs((bPos.get(k) ?? 0) - (aPos.get(k) ?? 0)) >= 0.005
    );
    if (changedPositions.length === 0 && totalsEqual(b.totalByCcy, a.totalByCcy)) continue;
    diff.changed.push({ date, before: roundTotals(b.totalByCcy), after: roundTotals(a.totalByCcy), positions: changedPositions.sort() });
  }
  return diff;
}

// ---------- 行情同步需要覆盖的日期范围 ----------

export interface PriceRange {
  ticker: string;
  currency: string;
  from: string; // 首笔成交前几天(要有"前一日收盘价")
  to: string; // 还持有 → today;已清仓 → 最后一笔成交日
  open: boolean;
  splitCount: number;
}

/** 每个 ticker+币种 需要收盘价的日期区间。 */
export function priceRangesNeeded(trades: PnlTrade[], splits: PnlSplit[], today: string): Map<string, PriceRange> {
  const groups = groupByPosition(trades, splits);
  const ranges = new Map<string, PriceRange>();
  for (const g of groups.values()) {
    let qty = 0;
    for (const e of g.events) {
      if (e.kind === "split") qty *= e.split.ratio;
      else qty += e.trade.side === "buy" ? e.trade.qty : -e.trade.qty;
    }
    const open = Math.abs(qty) > EPS;
    const first = g.events[0].date;
    const last = g.events[g.events.length - 1].date;
    const pk = priceKey(g.ticker, g.currency);
    const splitCount = g.events.filter((e) => e.kind === "split").length;
    const prev = ranges.get(pk);
    const from = addDays(first, -7);
    const to = open ? (last > today ? last : today) : last;
    if (!prev) ranges.set(pk, { ticker: g.ticker, currency: g.currency, from, to, open, splitCount });
    else {
      prev.from = prev.from < from ? prev.from : from;
      prev.to = prev.to > to ? prev.to : to;
      prev.open = prev.open || open;
      prev.splitCount += splitCount;
    }
  }
  return ranges;
}
