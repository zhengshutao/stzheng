// K 线页左侧持仓的止损 —— 调 snaptrade-stop edge function(下单只在那边,SnapTrade 的 key 不进浏览器)。

import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/app/lib/supabase";
import { ema, fetchCandles } from "@/app/lib/candles";
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
