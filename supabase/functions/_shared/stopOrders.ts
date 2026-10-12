// snaptrade-stop 的返回类型,edge function 和前端(src/app/lib/stopOrders.ts)共用。

/** 止损怎么定的:ema10 / ema20 = 日线 EMA − 1%(批量更新会重算);custom = 手动价格(批量更新不动) */
export type StopBasis = "ema10" | "ema20" | "custom";
export const STOP_BASES: StopBasis[] = ["ema10", "ema20", "custom"];

/** 一笔还挂着的卖出止损单 */
export interface StopView {
  orderId: string;
  accountId: string;
  accountName: string;
  units: number;
  /** 我们自己下的单才知道触发价(stock_stop_orders);Wealthsimple App 里设的是 null */
  stop: number | null;
  /** 同上,不是我们下的单为 null */
  basis: StopBasis | null;
  status: string;
  placedAt: string | null;
}

/** ticker → 这只股票所有账户里挂着的卖出止损 */
export type StopsByTicker = Record<string, StopView[]>;

/** 改一个账户的止损的结果 */
export interface SetStopAccountResult {
  accountId: string;
  accountName: string;
  units: number;
  canceled: string[];
  orderId: string | null;
  /** 有值就是这个账户失败了;unprotected = 旧单已撤、新单没挂上 */
  error?: string;
  unprotected?: boolean;
}

export interface SetStopResult {
  ok: boolean;
  ticker: string;
  stop: number;
  basis: StopBasis;
  accounts: SetStopAccountResult[];
  stops: StopsByTicker;
}
