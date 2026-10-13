// K 线页左侧持仓的止损 —— 调 snaptrade-stop edge function(下单只在那边,SnapTrade 的 key 不进浏览器)。

import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/app/lib/supabase";
import { ema, etFakeTime, fetchCandles } from "@/app/lib/candles";
import type { SetStopResult, StopBasis, StopsByTicker } from "../../../supabase/functions/_shared/stopOrders.ts";

export type { SetStopAccountResult, SetStopResult, StopBasis, StopView, StopsByTicker } from "../../../supabase/functions/_shared/stopOrders.ts";

async function invoke<T>(body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke("snaptrade-stop", { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = await error.context.json().catch(() => null);
      throw new Error(res?.error ?? `snaptrade-stop ${error.context.status}`);
    }
    throw new Error(`snaptrade-stop: ${error.message}`);
  }
  return data as T;
}

export async function fetchStopOrders(): Promise<StopsByTicker> {
  return (await invoke<{ stops: StopsByTicker }>({ action: "list" })).stops;
}

// ---- 收盘后少查:止损单只在常规交易时段触发,收盘后查过一次就一直有效到下次开盘 ----

const STOPS_CACHE_KEY = "chart.stops.live";

/** 美东墙上时间(当 UTC 的秒数)落在常规交易时段里吗:周一到周五 9:30–16:00,不管节假日 */
function inSession(fake: number): boolean {
  const d = new Date(fake * 1000);
  const dow = d.getUTCDay();
  const hm = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow >= 1 && dow <= 5 && hm >= 9 * 60 + 30 && hm < 16 * 60;
}

/** 最近一次收盘(工作日 16:00 美东),同样是"墙上时间当 UTC"的秒数 */
function lastClose(fake: number): number {
  const day = Math.floor(fake / 86400) * 86400;
  for (let i = 0; i < 7; i++) {
    const close = day - i * 86400 + 16 * 3600;
    const dow = new Date(close * 1000).getUTCDay();
    if (dow >= 1 && dow <= 5 && close <= fake) return close;
  }
  return 0;
}

/** 收盘后、而且上次实时查询是在这次收盘之后做的,就直接用那次的结果 */
function readStopsCache(): StopsByTicker | null {
  try {
    const raw = localStorage.getItem(STOPS_CACHE_KEY);
    if (!raw) return null;
    const { at, stops } = JSON.parse(raw) as { at: number; stops: StopsByTicker };
    const now = etFakeTime(new Date(), false);
    return !inSession(now) && at >= lastClose(now) ? stops : null;
  } catch {
    return null;
  }
}

/** 记下实时查到(或刚改完)的止损 */
export function saveStopsCache(stops: StopsByTicker): void {
  try {
    localStorage.setItem(STOPS_CACHE_KEY, JSON.stringify({ at: etFakeTime(new Date(), false), stops }));
  } catch {
    /* 存不了就每次都实时查 */
  }
}

/** 进页面用:收盘后有可用的结果就不打 SnapTrade;force(刷新持仓)总是实时查 */
export async function loadStopOrders(force = false): Promise<StopsByTicker> {
  const cached = force ? null : readStopsCache();
  if (cached) return cached;
  const stops = await fetchStopOrders();
  saveStopsCache(stops);
  return stops;
}

/**
 * 实时查不到时(Wealthsimple 限流等)的兜底:读自己库里记的、还没标撤单的止损。
 * 只有从页面 / 脚本下的单才有记录;已经触发成交、或在 App 里撤掉的单这里还在,所以只能当参考。
 */
export async function fetchCachedStopOrders(): Promise<StopsByTicker> {
  const { data, error } = await supabase
    .from("stock_stop_orders")
    .select("ticker, account_id, brokerage_order_id, stop_price, units, basis, created_at")
    .is("canceled_at", null);
  if (error) throw new Error(`stock_stop_orders: ${error.message}`);
  const out: StopsByTicker = {};
  for (const r of data ?? []) {
    (out[r.ticker] ??= []).push({
      orderId: r.brokerage_order_id,
      accountId: r.account_id,
      accountName: r.account_id.slice(0, 8),
      units: Number(r.units),
      stop: Number(r.stop_price),
      basis: r.basis as StopBasis,
      status: "CACHED",
      placedAt: r.created_at,
    });
  }
  return out;
}

/** 撤掉该股票所有账户的旧止损,按全部持仓重新挂 Stop GTC @ stop */
export function setStopLoss(ticker: string, stop: number, basis: StopBasis): Promise<SetStopResult> {
  return invoke<SetStopResult>({ action: "set", ticker, stop, basis });
}

/** EMA 止损比均线低这么多 */
export const STOP_BELOW_EMA = 0.01;

export const BASIS_LABEL: Record<StopBasis, string> = { ema10: "EMA10", ema20: "EMA20", custom: "自定义" };

/** EMA − 1%,向下取到分 */
export const stopFromEma = (v: number) => Math.floor(v * (1 - STOP_BELOW_EMA) * 100) / 100;

export interface EmaStops {
  ema10: number | null;
  ema20: number | null;
  /** 昨天(上一根日线)的 EMA,批量更新用来判断今天是不是往下走了 */
  prev: { ema10: number | null; ema20: number | null };
  /** 按 basis 算出来的止损价(custom 没有) */
  stop: Partial<Record<StopBasis, number>>;
}

/**
 * 日线 EMA10 / EMA20 和对应的止损价。
 * 日线最后一根是今天的 bar(盘中跟着现价变,收盘后就是当天定值),和 K 线图上的 EMA 是同一个数。
 */
export async function emaStops(ticker: string): Promise<EmaStops> {
  const data = await fetchCandles(ticker, "1d");
  const s10 = ema(data.candles, 10);
  const s20 = ema(data.candles, 20);
  const ema10 = s10.at(-1)?.value ?? null;
  const ema20 = s20.at(-1)?.value ?? null;
  const stop: EmaStops["stop"] = {};
  if (ema10 !== null) stop.ema10 = stopFromEma(ema10);
  if (ema20 !== null) stop.ema20 = stopFromEma(ema20);
  return { ema10, ema20, prev: { ema10: s10.at(-2)?.value ?? null, ema20: s20.at(-2)?.value ?? null }, stop };
}

/** 批量更新里的一行 */
export interface BatchPlanRow {
  ticker: string;
  basis: StopBasis | null;
  current: number | null;
  next: number | null;
  /** 有值 = 跳过这只,写原因 */
  skip?: string;
}

/**
 * 批量更新计划:只动 basis 是 ema10 / ema20 的止损,按今天的 EMA 重算。
 * 自定义价格、App 里手动设的(basis 未知)、没有止损的都跳过;
 * 今天的 EMA 比昨天低也跳过(均线往下走时不跟着下调止损)。
 */
export async function planBatch(stops: StopsByTicker, prices: Record<string, number | null>): Promise<BatchPlanRow[]> {
  const rows = Object.entries(stops).filter(([, list]) => list.length > 0);
  return Promise.all(
    rows.map(async ([ticker, list]): Promise<BatchPlanRow> => {
      const bases = [...new Set(list.map((s) => s.basis))];
      const prices_ = [...new Set(list.map((s) => s.stop))];
      const basis = bases.length === 1 ? bases[0] : null;
      const current = prices_.length === 1 ? prices_[0] : null;
      const row: BatchPlanRow = { ticker, basis, current, next: null };
      if (bases.length > 1) return { ...row, skip: "各账户的止损方式不一样" };
      if (basis === null) return { ...row, skip: "在 App 里设的,不知道方式" };
      if (basis === "custom") return { ...row, skip: "自定义价格,不动" };
      try {
        const emas = await emaStops(ticker);
        const next = emas.stop[basis] ?? null;
        if (next === null) return { ...row, skip: "日线不够,算不出 EMA" };
        const today = emas[basis];
        const yesterday = emas.prev[basis];
        if (today !== null && yesterday !== null && today < yesterday) {
          return { ...row, next, skip: `${BASIS_LABEL[basis]} 比昨天低(${yesterday.toFixed(2)} → ${today.toFixed(2)}),不动` };
        }
        const price = prices[ticker];
        if (price != null && next >= price) return { ...row, next, skip: `现价 ${price.toFixed(2)} 已跌破 ${BASIS_LABEL[basis]}` };
        if (current !== null && Math.abs(next - current) < 0.005) return { ...row, next, skip: "价格没变" };
        return { ...row, next };
      } catch (e) {
        return { ...row, skip: `EMA 加载失败:${String((e as Error).message ?? e)}` };
      }
    })
  );
}
