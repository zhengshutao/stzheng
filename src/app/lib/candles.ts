// K 线页(/dashboard/chart)的数据层 —— 拉 stock-candles、算 EMA、把交易记录归到 K 线上做买卖点。
//
// 时间轴约定:lightweight-charts 按 UTC 显示时间,所以这里把每根 bar 的时间换成"美东墙上时间当成 UTC"
// 的假时间戳,图上看到的就是美东时间。日线/周线再截到当天 00:00,图上只显示日期。

import { supabase } from "@/app/lib/supabase";
import type { StockTrade } from "@/app/lib/dashboardData";

export type Period = "3m" | "5m" | "15m" | "1h" | "1d" | "1wk";

export const PERIODS: { key: Period; label: string }[] = [
  { key: "3m", label: "3分" },
  { key: "5m", label: "5分" },
  { key: "15m", label: "15分" },
  { key: "1h", label: "1时" },
  { key: "1d", label: "日" },
  { key: "1wk", label: "周" },
];

export const BAR_SECONDS: Record<Period, number> = { "3m": 180, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400, "1wk": 7 * 86400 };

export const EMA_LENGTHS = [5, 10, 20, 50] as const;

export interface Candle {
  /** 美东墙上时间当 UTC 的秒数(见文件头) */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleData {
  symbol: string;
  name: string | null;
  previousClose: number | null;
  candles: Candle[];
}

const etFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 真实时刻 → 美东墙上时间当 UTC 的秒数;dayOnly 时截到当天 00:00。 */
export function etFakeTime(date: Date, dayOnly: boolean): number {
  const parts = etFormatter.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const ms = Date.UTC(get("year"), get("month") - 1, get("day"), dayOnly ? 0 : get("hour"), dayOnly ? 0 : get("minute"));
  return ms / 1000;
}

export function isDaily(period: Period): boolean {
  return period === "1d" || period === "1wk";
}

export async function fetchCandles(symbol: string, period: Period): Promise<CandleData> {
  const { data, error } = await supabase.functions.invoke("stock-candles", { body: { symbol, period } });
  if (error) throw new Error(`stock-candles: ${error.message}`);
  return parseCandles(data as RawCandles, period);
}

export interface Spark {
  name: string | null;
  /** 前一交易日收盘价(迷你图的虚线基准、涨跌颜色) */
  previousClose: number | null;
  /** 最近一个交易日常规时段的 5 分钟收盘价 */
  closes: number[];
}

/** 左侧列表的迷你走势图,一次请求拿整个列表 */
export async function fetchSparks(symbols: string[]): Promise<Record<string, Spark | null>> {
  if (!symbols.length) return {};
  const { data, error } = await supabase.functions.invoke("stock-candles", { body: { symbols, period: "spark" } });
  if (error) throw new Error(`stock-candles: ${error.message}`);
  const out: Record<string, Spark | null> = {};
  for (const [sym, raw] of Object.entries((data as { results: Record<string, RawCandles | null> }).results)) {
    out[sym] = raw ? { name: raw.name, previousClose: raw.previousClose, closes: raw.candles.map((c) => c.c) } : null;
  }
  return out;
}

/** stock-candles 的原始返回 */
export interface RawCandles {
  symbol: string;
  name: string | null;
  previousClose: number | null;
  candles: { t: number; o: number; h: number; l: number; c: number; v: number }[];
}

export function parseCandles(raw: RawCandles, period: Period): CandleData {
  const daily = isDaily(period);
  const span = BAR_SECONDS[period];
  const candles: Candle[] = [];
  for (const c of raw.candles) {
    const time = etFakeTime(new Date(c.t * 1000), daily);
    const bar = { time, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v };
    const prev = candles[candles.length - 1];
    // 雅虎会在末尾追加一个"当前时刻"的实时点(比如周线多出一根周五的、小时线多出一根 19:28 的),
    // 它落在上一根 bar 的区间里,并进上一根而不是单独成一根
    if (prev && time < prev.time + span) {
      prev.high = Math.max(prev.high, bar.high);
      prev.low = Math.min(prev.low, bar.low);
      prev.close = bar.close;
      prev.volume = Math.max(prev.volume, bar.volume);
    } else if (!prev || prev.time < time) {
      candles.push(bar);
    }
  }
  return { symbol: raw.symbol, name: raw.name, previousClose: raw.previousClose, candles };
}

/** 美股常规时段 09:30–16:00(美东)。bar 时间已经是美东墙上时间,直接看一天里的分钟数。 */
const REGULAR_OPEN_MIN = 9 * 60 + 30;
const REGULAR_CLOSE_MIN = 16 * 60;

/** 分钟线/小时线去掉盘前盘后,只留常规时段的 bar(日线/周线原样返回) */
export function regularSessionOnly(candles: Candle[], period: Period): Candle[] {
  if (isDaily(period)) return candles;
  return candles.filter((c) => {
    const min = Math.floor((c.time % 86400) / 60);
    return min >= REGULAR_OPEN_MIN && min < REGULAR_CLOSE_MIN;
  });
}

/** 标准 EMA:前 length 根用 SMA 起头,之后 α = 2/(n+1)。不足 length 根的位置不出值。 */
export function ema(candles: Candle[], length: number): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  if (candles.length < length) return out;
  const k = 2 / (length + 1);
  let prev = 0;
  for (let i = 0; i < length; i++) prev += candles[i].close;
  prev /= length;
  out.push({ time: candles[length - 1].time, value: prev });
  for (let i = length; i < candles.length; i++) {
    prev = candles[i].close * k + prev * (1 - k);
    out.push({ time: candles[i].time, value: prev });
  }
  return out;
}

export type MarkKind = "B" | "S" | "T";

export interface BarTrades {
  time: number;
  kind: MarkKind;
  trades: StockTrade[];
}

/** 一笔成交在图上的时刻:日线/周线用交易日(stock_trades.date,美东),分钟线用成交时间 ts。 */
function tradeFakeTime(t: StockTrade, daily: boolean): number {
  if (!daily && t.ts) return etFakeTime(new Date(t.ts), false);
  const [y, m, d] = t.date.split("-").map(Number);
  const dayStart = Date.UTC(y, m - 1, d) / 1000;
  // 分钟线但没记成交时间的(老的手输记录):放在当天开盘 09:30
  return daily ? dayStart : dayStart + 9.5 * 3600;
}

/**
 * 把交易归到所在的那根 K 线:取"开始时间 ≤ 成交时刻"的最后一根。早于第一根 bar 的交易不画。
 * 同一根 bar 里有多笔成交 → T,只有一笔就是 B 或 S。
 */
export function groupTradesByBar(candles: Candle[], trades: StockTrade[], period: Period): BarTrades[] {
  if (!candles.length) return [];
  const daily = isDaily(period);
  const byTime = new Map<number, StockTrade[]>();
  for (const t of trades) {
    const at = tradeFakeTime(t, daily);
    if (at < candles[0].time) continue;
    // 二分找最后一根 time <= at
    let lo = 0;
    let hi = candles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (candles[mid].time <= at) lo = mid;
      else hi = mid - 1;
    }
    // 成交时刻已经超出这根 bar(比如关掉盘前盘后后,盘前的成交会落到前一天收盘那根):
    // 如果下一根是同一天的,归到下一根(当天开盘那根)
    const next = candles[lo + 1];
    if (!daily && next && at >= candles[lo].time + BAR_SECONDS[period] && Math.floor(next.time / 86400) === Math.floor(at / 86400)) lo++;
    const time = candles[lo].time;
    const list = byTime.get(time) ?? [];
    list.push(t);
    byTime.set(time, list);
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, list]) => {
      const kind: MarkKind = list.length > 1 ? "T" : list[0].side === "buy" ? "B" : "S";
      return { time, kind, trades: list };
    });
}

/**
 * 从 K 线推"昨收":日线/周线取倒数第二根收盘;分钟线/小时线取最后一根 bar 之前那个交易日常规时段最后一根的收盘。
 * (stock-candles 的 previousClose 是整个 range 开始前的收盘,分钟线拉 5 天时不是昨收)
 */
export function previousDayClose(candles: Candle[], period: Period): number | null {
  if (candles.length < 2) return null;
  if (isDaily(period)) return candles[candles.length - 2].close;
  const regular = regularSessionOnly(candles, period);
  const lastDay = Math.floor(candles[candles.length - 1].time / 86400);
  for (let i = regular.length - 1; i >= 0; i--) {
    if (Math.floor(regular[i].time / 86400) < lastDay) return regular[i].close;
  }
  return null;
}
