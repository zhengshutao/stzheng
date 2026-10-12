// /dashboard/portfolio 的数据 —— 调 snaptrade-portfolio edge function(SnapTrade 的 key 只在那边)。
// 浏览器拿到的只有整理好的 view model,类型和汇总函数和 edge function 共用同一份文件。

import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/app/lib/supabase";
import type { PortfolioView } from "../../../supabase/functions/_shared/snaptradeViewModels.ts";

export type {
  AccountView,
  ActivityView,
  BalanceView,
  ConnectionView,
  OrderView,
  PortfolioSummary,
  PortfolioView,
  PositionView,
  Section,
} from "../../../supabase/functions/_shared/snaptradeViewModels.ts";
export { accountLabel, failedSections, isInvestment, summarize } from "../../../supabase/functions/_shared/snaptradeViewModels.ts";

export async function fetchPortfolio(): Promise<PortfolioView> {
  const { data, error } = await supabase.functions.invoke("snaptrade-portfolio", { method: "POST" });
  if (error) {
    // 401/403/500 时函数返回 {error: "..."},把这句带出来(比如"forbidden"说明不是本人账号)
    if (error instanceof FunctionsHttpError) {
      const status = error.context.status;
      const body = await error.context.json().catch(() => null);
      throw new Error(`snaptrade-portfolio ${status}: ${body?.error ?? error.message}`);
    }
    throw new Error(`snaptrade-portfolio: ${error.message}`);
  }
  return data as PortfolioView;
}

export interface SnaptradeSyncResult {
  ok: boolean;
  newTrades: number;
  newCash: number;
  message?: string;
}

/** 手动触发一次 SnapTrade → stock_trades 同步(和 pg_cron 每 10 分钟跑的是同一个 edge function)。 */
export async function runSnaptradeSync(): Promise<SnaptradeSyncResult> {
  const { data, error } = await supabase.functions.invoke("snaptrade-sync", { method: "POST" });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const body = await error.context.json().catch(() => null);
      throw new Error(`snaptrade-sync ${error.context.status}: ${body?.message ?? body?.error ?? error.message}`);
    }
    throw new Error(`snaptrade-sync: ${error.message}`);
  }
  return data as SnaptradeSyncResult;
}
