// 日常收支记录页的读写调用 —— 手动新增/编辑/删除交易记录。

import { supabase } from "@/app/lib/supabase";
import type { DailyTx } from "@/app/lib/dashboardData";

export interface NewDailyTxInput {
  date: string; // yyyy-mm-dd
  merchant: string;
  amount: number; // 约定: >0 支出, <0 收入
  category?: string | null;
  note?: string | null;
  is_transfer?: boolean;
}

export async function insertDailyTx(input: NewDailyTxInput, userId: string): Promise<DailyTx> {
  const row = {
    id: crypto.randomUUID(),
    user_id: userId,
    date: input.date,
    name: input.merchant,
    merchant: input.merchant,
    amount: input.amount,
    currency: "CAD",
    category: input.category || null,
    note: input.note || null,
    is_transfer: input.is_transfer ?? false,
    pending: false,
    source: "manual",
  };
  const { data, error } = await supabase.from("daily_transactions").insert(row).select().single();
  if (error) throw new Error(`daily_transactions insert: ${error.message}`);
  return data as DailyTx;
}

export interface UpdateDailyTxInput {
  date?: string;
  merchant?: string;
  amount?: number;
  category?: string | null;
  note?: string | null;
  is_transfer?: boolean;
}

export async function updateDailyTx(id: string, input: UpdateDailyTxInput): Promise<DailyTx> {
  const row: Record<string, unknown> = {};
  if (input.date !== undefined) row.date = input.date;
  if (input.merchant !== undefined) {
    row.merchant = input.merchant;
    row.name = input.merchant;
  }
  if (input.amount !== undefined) row.amount = input.amount;
  if (input.category !== undefined) row.category = input.category || null;
  if (input.note !== undefined) row.note = input.note || null;
  if (input.is_transfer !== undefined) row.is_transfer = input.is_transfer;

  const { data, error } = await supabase.from("daily_transactions").update(row).eq("id", id).select().single();
  if (error) throw new Error(`daily_transactions update: ${error.message}`);
  return data as DailyTx;
}

export async function deleteDailyTx(id: string): Promise<void> {
  const { error } = await supabase.from("daily_transactions").delete().eq("id", id);
  if (error) throw new Error(`daily_transactions delete: ${error.message}`);
}
