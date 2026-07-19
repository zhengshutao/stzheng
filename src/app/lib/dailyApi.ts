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
  institution_name?: string | null; // 银行缩写,比如 Rog / Sco / WS / CIBC / CT
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
    institution_name: input.institution_name || null,
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
  institution_name?: string | null;
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
  if (input.institution_name !== undefined) row.institution_name = input.institution_name || null;

  const { data, error } = await supabase.from("daily_transactions").update(row).eq("id", id).select().single();
  if (error) throw new Error(`daily_transactions update: ${error.message}`);
  return data as DailyTx;
}

export async function deleteDailyTx(id: string): Promise<void> {
  const { error } = await supabase.from("daily_transactions").delete().eq("id", id);
  if (error) throw new Error(`daily_transactions delete: ${error.message}`);
}

// ---------- 合并记录(壳子)—— 只打分组标签,不改原始记录的任何其他字段 ----------

export async function mergeDailyTx(ids: string[]): Promise<string> {
  const groupId = crypto.randomUUID();
  const { error } = await supabase.from("daily_transactions").update({ merge_group_id: groupId }).in("id", ids);
  if (error) throw new Error(`daily_transactions merge: ${error.message}`);
  return groupId;
}

export async function unmergeDailyTx(groupId: string): Promise<void> {
  const { error } = await supabase
    .from("daily_transactions")
    .update({ merge_group_id: null })
    .eq("merge_group_id", groupId);
  if (error) throw new Error(`daily_transactions unmerge: ${error.message}`);
}
