// 股票记录页的读写/行情调用 —— 新增/删除交易和出入金记录,
// 以及调用 stock-quotes / stock-stops 两个 Supabase Edge Function。

import { supabase } from "@/app/lib/supabase";
import type { StockCash, StockTrade } from "@/app/lib/dashboardData";
import { stopAnchorAndFloor, type Position, type Quote } from "@/app/lib/stockPositions";

export type Account = "TFSA" | "NON-REG";
export type Currency = "USD" | "CAD";

export interface NewTradeInput {
  ticker: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  currency: Currency;
  account: Account;
  ts: string; // ISO datetime
  note: string;
  fees?: number;
  initial_stop?: number | null; // buy only
  realized_pnl?: number | null; // sell only — 由调用方用 matchSell() 预先算好
}

export interface NewCashInput {
  type: "deposit" | "withdraw";
  amount: number;
  currency: Currency;
  account: Account;
  ts: string;
  note: string;
}

export async function insertStockTrade(input: NewTradeInput, userId: string): Promise<StockTrade> {
  const row = {
    id: crypto.randomUUID(),
    user_id: userId,
    date: input.ts.slice(0, 10),
    ts: input.ts,
    ticker: input.ticker.toUpperCase(),
    side: input.side,
    qty: input.qty,
    price: input.price,
    currency: input.currency,
    fees: input.fees ?? 0,
    account: input.account,
    note: input.note || null,
    initial_stop: input.side === "buy" ? input.initial_stop ?? null : null,
    realized_pnl: input.side === "sell" ? input.realized_pnl ?? null : null,
  };
  const { data, error } = await supabase.from("stock_trades").insert(row).select().single();
  if (error) throw new Error(`stock_trades insert: ${error.message}`);
  return data as StockTrade;
}

export async function updateStockTrade(id: string, input: NewTradeInput): Promise<StockTrade> {
  const row = {
    date: input.ts.slice(0, 10),
    ts: input.ts,
    ticker: input.ticker.toUpperCase(),
    side: input.side,
    qty: input.qty,
    price: input.price,
    currency: input.currency,
    fees: input.fees ?? 0,
    account: input.account,
    note: input.note || null,
    initial_stop: input.side === "buy" ? input.initial_stop ?? null : null,
    realized_pnl: input.side === "sell" ? input.realized_pnl ?? null : null,
  };
  const { data, error } = await supabase.from("stock_trades").update(row).eq("id", id).select().single();
  if (error) throw new Error(`stock_trades update: ${error.message}`);
  return data as StockTrade;
}

export async function deleteStockTrade(id: string): Promise<void> {
  const { error } = await supabase.from("stock_trades").delete().eq("id", id);
  if (error) throw new Error(`stock_trades delete: ${error.message}`);
}

export async function insertStockCash(input: NewCashInput, userId: string): Promise<StockCash> {
  const row = {
    id: crypto.randomUUID(),
    user_id: userId,
    date: input.ts.slice(0, 10),
    type: input.type,
    amount: input.amount,
    currency: input.currency,
    account: input.account,
    note: input.note || null,
  };
  const { data, error } = await supabase.from("stock_cash").insert(row).select().single();
  if (error) throw new Error(`stock_cash insert: ${error.message}`);
  return data as StockCash;
}

export async function deleteStockCash(id: string): Promise<void> {
  const { error } = await supabase.from("stock_cash").delete().eq("id", id);
  if (error) throw new Error(`stock_cash delete: ${error.message}`);
}

export interface QuotesResponse {
  fx: number | null;
  usd: Record<string, Quote | null>;
  cad: Record<string, Quote | null>;
}

export async function fetchQuotes(usdTickers: string[], cadTickers: string[]): Promise<QuotesResponse> {
  const { data, error } = await supabase.functions.invoke("stock-quotes", {
    body: { usdTickers, cadTickers },
  });
  if (error) throw new Error(`stock-quotes: ${error.message}`);
  return data as QuotesResponse;
}

export interface StopsInfo {
  ticker: string;
  error?: string;
  current?: number;
  atr_pct?: number;
  chosen_line?: string;
  chosen_line_value?: number | null;
  buffer?: number;
  trend_quality?: string;
  trend_days?: number;
  leg_restarted?: boolean;
  stop_basis?: string;
  stop_mom?: number | null;
  stop_mom_pct?: number | null;
  stop_mom_raw?: number | null;
  ratcheted?: boolean;
}

export async function fetchStops(positions: Position[]): Promise<Record<string, StopsInfo>> {
  const body = {
    positions: positions.map((p) => ({ ticker: p.ticker, ...stopAnchorAndFloor(p) })),
  };
  const { data, error } = await supabase.functions.invoke("stock-stops", { body });
  if (error) throw new Error(`stock-stops: ${error.message}`);
  return data as Record<string, StopsInfo>;
}
