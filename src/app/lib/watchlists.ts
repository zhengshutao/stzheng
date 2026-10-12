// 自选列表(K 线页左侧的分组)的读写 —— 表结构见 supabase/2026-10-12-watchlists.sql。
// 一个列表存一个有序的代码数组;同一只股票可以同时在多个列表里。

import { supabase } from "@/app/lib/supabase";

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
  sort: number;
}

/** 表还没建(SQL 没跑)时 PostgREST 返回的错误 */
export function isMissingWatchlistTable(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("watchlists") && (m.includes("schema cache") || m.includes("does not exist") || m.includes("could not find"));
}

export async function fetchWatchlists(): Promise<Watchlist[]> {
  const { data, error } = await supabase
    .from("watchlists")
    .select("id,name,symbols,sort")
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`watchlists: ${error.message}`);
  return (data ?? []) as Watchlist[];
}

export async function createWatchlist(name: string, sort: number, symbols: string[] = []): Promise<Watchlist> {
  const { data, error } = await supabase
    .from("watchlists")
    .insert({ name, sort, symbols })
    .select("id,name,symbols,sort")
    .single();
  if (error) throw new Error(`watchlists insert: ${error.message}`);
  return data as Watchlist;
}

export async function updateWatchlist(id: string, patch: Partial<Pick<Watchlist, "name" | "symbols" | "sort">>): Promise<void> {
  const { error } = await supabase.from("watchlists").update(patch).eq("id", id);
  if (error) throw new Error(`watchlists update: ${error.message}`);
}

export async function deleteWatchlist(id: string): Promise<void> {
  const { error } = await supabase.from("watchlists").delete().eq("id", id);
  if (error) throw new Error(`watchlists delete: ${error.message}`);
}
