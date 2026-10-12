// FIFO 持仓/盈亏计算 —— 移植自 /Users/szheng/stock/trades.py 的 _replay 算法。
// 输入始终是完整的交易列表(按 ticker+currency+account 分组做 FIFO 撮合),
// 持仓的 avg_cost 是"当前剩余未平仓 lot"的加权平均成本,不是全部历史买入的均价。
//
// 每日盈亏不在这里算(见 dailyPnl.ts,那边不需要 FIFO)。这里只管:持仓明细、已实现盈亏、现金余额。

import type { StockCash, StockSplit, StockTrade } from "@/app/lib/dashboardData";
import { contractMultiplier } from "@/app/lib/instruments";

export { contractMultiplier };

export interface Lot {
  qty: number;
  price: number;
  ts: string;
  initial_stop?: number;
}

export interface Position {
  ticker: string;
  currency: string;
  account: string;
  qty: number;
  avg_cost: number;
  lots: Lot[];
}

export interface EnrichedTrade extends StockTrade {
  realized_pct: number | null;
  warning?: string;
}

function tradeTs(t: StockTrade): string {
  return t.ts ?? t.date;
}

function splitTs(s: StockSplit): string {
  return s.ts ?? s.date;
}

function posKey(ticker: string, currency: string, account: string): string {
  return `${ticker}|${currency}|${account}`;
}

/** FIFO 消耗 lots(原地修改,清空已耗尽的 lot),返回卖出结算结果。 */
function consumeLotsFifo(
  lots: Lot[],
  qty: number,
  price: number,
  fees: number,
  multiplier: number
): { realized_pnl: number; realized_pct: number; warning?: string } {
  let remaining = qty;
  let costBasis = 0;
  while (remaining > 1e-9 && lots.length > 0) {
    const lot = lots[0];
    const take = Math.min(lot.qty, remaining);
    costBasis += take * lot.price * multiplier;
    lot.qty -= take;
    remaining -= take;
    if (lot.qty <= 1e-9) lots.shift();
  }
  const soldQty = qty - remaining;
  const realized = soldQty * price * multiplier - costBasis - fees;
  const realizedPct = costBasis > 0 ? (realized / costBasis) * 100 : 0;
  const warning =
    remaining > 1e-9
      ? `卖出 ${qty} 股，但只有 ${soldQty} 股持仓（多卖 ${remaining}）`
      : undefined;
  return {
    realized_pnl: Math.round(realized * 100) / 100,
    realized_pct: Math.round(realizedPct * 100) / 100,
    warning,
  };
}

type ReplayEvent =
  | { kind: "trade"; ts: string; trade: StockTrade }
  | { kind: "split"; ts: string; split: StockSplit };

/**
 * 按 ticker+currency+account 做 FIFO 撮合,返回持仓(仅剩余未平仓 lot)和逐笔盈亏明细。
 * splits 是拆股/合股/并购换股这类没有成交价的公司行为——按 ts 混入同一条时间线,
 * 撞到时把当时该 key 名下所有未平仓 lot 的 qty*ratio、price/ratio(总成本不变)。
 */
export function replay(
  trades: StockTrade[],
  splits: StockSplit[] = []
): {
  positions: Position[];
  enrichedTrades: EnrichedTrade[];
} {
  const events: ReplayEvent[] = [
    ...trades.map((t) => ({ kind: "trade" as const, ts: tradeTs(t), trade: t })),
    ...splits.map((s) => ({ kind: "split" as const, ts: splitTs(s), split: s })),
  ];
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const lotsByKey = new Map<string, Lot[]>();
  const enrichedTrades: EnrichedTrade[] = [];

  for (const e of events) {
    if (e.kind === "split") {
      const s = e.split;
      const key = posKey(s.ticker.toUpperCase(), s.currency.toUpperCase(), (s.account ?? "TFSA").toUpperCase());
      const lots = lotsByKey.get(key);
      if (lots) {
        for (const lot of lots) {
          lot.qty *= s.ratio;
          lot.price /= s.ratio;
          if (lot.initial_stop !== undefined) lot.initial_stop /= s.ratio;
        }
      }
      continue;
    }

    const t = e.trade;
    const ticker = t.ticker.toUpperCase();
    const currency = t.currency.toUpperCase();
    const account = (t.account ?? "TFSA").toUpperCase();
    const key = posKey(ticker, currency, account);

    if (t.side === "buy") {
      const lots = lotsByKey.get(key) ?? [];
      lots.push({
        qty: t.qty,
        price: t.price,
        ts: tradeTs(t),
        initial_stop: t.initial_stop ?? undefined,
      });
      lotsByKey.set(key, lots);
      enrichedTrades.push({ ...t, realized_pct: null });
      continue;
    }

    // sell: FIFO 消耗
    const lots = lotsByKey.get(key) ?? [];
    const settled = consumeLotsFifo(lots, t.qty, t.price, t.fees ?? 0, contractMultiplier(ticker));
    enrichedTrades.push({ ...t, ...settled });
  }

  const positions: Position[] = [];
  for (const [key, lots] of lotsByKey) {
    if (lots.length === 0) continue;
    const totalQty = lots.reduce((s, l) => s + l.qty, 0);
    if (totalQty <= 1e-9) continue;
    const totalCost = lots.reduce((s, l) => s + l.qty * l.price, 0);
    const [ticker, currency, account] = key.split("|");
    positions.push({
      ticker,
      currency,
      account,
      qty: Math.round(totalQty * 10000) / 10000,
      avg_cost: Math.round((totalCost / totalQty) * 10000) / 10000,
      lots: lots.map((l) => ({ ...l })),
    });
  }
  positions.sort((a, b) =>
    a.account !== b.account
      ? a.account.localeCompare(b.account)
      : a.currency !== b.currency
        ? a.currency.localeCompare(b.currency)
        : a.ticker.localeCompare(b.ticker)
  );

  return { positions, enrichedTrades };
}

export function computePositions(trades: StockTrade[], splits: StockSplit[] = []): Position[] {
  return replay(trades, splits).positions;
}

/** {账户: {币种: 余额}} —— 入金加、出金减、买入减 qty*price+fees、卖出加 qty*price-fees。 */
export function computeCashBalance(
  cash: StockCash[],
  trades: StockTrade[]
): Record<string, Record<string, number>> {
  const bal: Record<string, Record<string, number>> = {};
  const add = (account: string, currency: string, amount: number) => {
    const a = (account ?? "TFSA").toUpperCase();
    const c = currency.toUpperCase();
    bal[a] = bal[a] ?? {};
    bal[a][c] = Math.round(((bal[a][c] ?? 0) + amount) * 100) / 100;
  };
  for (const c of cash) {
    add(c.account ?? "TFSA", c.currency, c.type === "deposit" ? c.amount : -c.amount);
  }
  for (const t of trades) {
    const notional = t.qty * t.price * contractMultiplier(t.ticker) + (t.side === "buy" ? t.fees : -t.fees);
    add(t.account ?? "TFSA", t.currency, t.side === "buy" ? -notional : notional);
  }
  return bal;
}

export interface StockSummary {
  realizedByCcy: Record<string, number>;
  winCount: number;
  lossCount: number;
  sellCount: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
}

/** 用重新做过 FIFO 撮合后的已实现盈亏统计(不依赖数据库里可能过期的 realized_pnl 字段)。 */
export function computeStockSummary(trades: StockTrade[], splits: StockSplit[] = []): StockSummary {
  const { enrichedTrades } = replay(trades, splits);
  const sells = enrichedTrades.filter((t) => t.side === "sell" && t.realized_pnl !== null);
  const realizedByCcy: Record<string, number> = {};
  let winCount = 0;
  let lossCount = 0;
  let winSum = 0;
  let lossSum = 0;
  for (const t of sells) {
    const pnl = t.realized_pnl as number;
    realizedByCcy[t.currency] = Math.round(((realizedByCcy[t.currency] ?? 0) + pnl) * 100) / 100;
    if (pnl > 0) {
      winCount++;
      winSum += pnl;
    } else if (pnl < 0) {
      lossCount++;
      lossSum += pnl;
    }
  }
  return {
    realizedByCcy,
    winCount,
    lossCount,
    sellCount: sells.length,
    winRate: sells.length ? Math.round((winCount / sells.length) * 1000) / 10 : 0,
    avgWin: winCount ? Math.round((winSum / winCount) * 100) / 100 : 0,
    avgLoss: lossCount ? Math.round((lossSum / lossCount) * 100) / 100 : 0,
  };
}

/** anchor = 最早开仓 lot 的 ts(标识持仓生命周期);initial_floor = 该持仓所有 lot 里开仓止损的最大值。 */
export function stopAnchorAndFloor(position: Position): { anchor: string | null; initial_floor: number | null } {
  if (position.lots.length === 0) return { anchor: null, initial_floor: null };
  const anchor = position.lots[0].ts;
  const floors = position.lots.map((l) => l.initial_stop).filter((v): v is number => v !== undefined);
  return { anchor, initial_floor: floors.length ? Math.max(...floors) : null };
}

/** 卖出下单前的 FIFO 试算(不修改传入的 position),用于提交前算出 realized_pnl 并提示超卖。 */
export function matchSell(
  position: Position | undefined,
  qty: number,
  price: number,
  fees: number
): { realized_pnl: number; realized_pct: number; warning?: string } {
  const lots = position ? position.lots.map((l) => ({ ...l })) : [];
  return consumeLotsFifo(lots, qty, price, fees, contractMultiplier(position?.ticker ?? ""));
}

export interface Quote {
  c: number;
  o: number;
  pc: number | null;
}
