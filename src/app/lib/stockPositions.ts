// FIFO 持仓/盈亏计算 —— 移植自 /Users/szheng/stock/trades.py 的 _replay 算法。
// 输入始终是完整的交易列表(按 ticker+currency+account 分组做 FIFO 撮合),
// 持仓的 avg_cost 是"当前剩余未平仓 lot"的加权平均成本,不是全部历史买入的均价。

import type { StockCash, StockTrade } from "@/app/lib/dashboardData";

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

function posKey(ticker: string, currency: string, account: string): string {
  return `${ticker}|${currency}|${account}`;
}

// 期权按"张"(contract)交易,一张对应 100 股标的——买卖价、现价都是"每股"权利金,
// 换算成实际金额(市值/盈亏/占用现金)要乘以 100。ticker 是手输的自由文本才会是期权,
// 形如 "TSLA Jul 27 $410 Call"(标的 + 到期月日 + 行权价 + 方向)。
const OPTION_TICKER_RE = /^[A-Za-z.]{1,6}\s+[A-Za-z]{3}[a-z]*\s+\d{1,2}\s+\$\d+(?:\.\d+)?\s+(Call|Put)$/i;

export function contractMultiplier(ticker: string): number {
  return OPTION_TICKER_RE.test(ticker.trim()) ? 100 : 1;
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

/** 按 ticker+currency+account 做 FIFO 撮合,返回持仓(仅剩余未平仓 lot)和逐笔盈亏明细。 */
export function replay(trades: StockTrade[]): {
  positions: Position[];
  enrichedTrades: EnrichedTrade[];
} {
  const sorted = [...trades].sort((a, b) => tradeTs(a).localeCompare(tradeTs(b)));
  const lotsByKey = new Map<string, Lot[]>();
  const enrichedTrades: EnrichedTrade[] = [];

  for (const t of sorted) {
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

export function computePositions(trades: StockTrade[]): Position[] {
  return replay(trades).positions;
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
export function computeStockSummary(trades: StockTrade[]): StockSummary {
  const { enrichedTrades } = replay(trades);
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

/**
 * 今日盈亏——只反映当前实际持有的这批 lot,不管当天有没有做过已经平仓的日内交易:
 *   lot 是当天(交易日)买入的: (live-lot.price) * lot.qty
 *   lot 是隔夜持有的: (live-pc) * lot.qty
 * 百分比基准 = 各 lot 的名义成本(当天用买入价,隔夜用前收盘价)之和
 */
export function computeDayPnl(
  position: Position,
  live: number | null,
  pc: number | null,
  todayStr: string
): { dayPnl: number | null; dayPct: number | null } {
  if (live === null) return { dayPnl: null, dayPct: null };

  const multiplier = contractMultiplier(position.ticker);
  let dayPnl = 0;
  let baseline = 0;
  for (const lot of position.lots) {
    const isToday = lot.ts.slice(0, 10) === todayStr;
    if (isToday) {
      dayPnl += (live - lot.price) * lot.qty * multiplier;
      baseline += lot.price * lot.qty * multiplier;
    } else {
      if (pc === null) return { dayPnl: null, dayPct: null };
      dayPnl += (live - pc) * lot.qty * multiplier;
      baseline += pc * lot.qty * multiplier;
    }
  }
  const dayPct = baseline > 0 ? (dayPnl / baseline) * 100 : null;
  return {
    dayPnl: Math.round(dayPnl * 100) / 100,
    dayPct: dayPct !== null ? Math.round(dayPct * 100) / 100 : null,
  };
}
