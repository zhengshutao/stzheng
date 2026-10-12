// 银行连接调用 —— 通过 plaid-link edge function 创建 Link token / 换取 access_token /
// 列出已连接银行 / 移除银行,和 stockApi.ts 里调用 stock-quotes/stock-stops 的写法一致。

import { supabase } from "@/app/lib/supabase";

export interface BankItem {
  item_id: string;
  institution_name: string | null;
  status: string;
  created_at: string;
}

async function invokePlaidLink<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("plaid-link", { body });
  if (error) throw new Error(`plaid-link: ${error.message}`);
  if (data?.error) throw new Error(`plaid-link: ${typeof data.error === "string" ? data.error : JSON.stringify(data.error)}`);
  return data as T;
}

export async function createPlaidLinkToken(): Promise<string> {
  const data = await invokePlaidLink<{ link_token: string }>({ action: "link_token" });
  return data.link_token;
}

export async function exchangePlaidPublicToken(
  publicToken: string,
  institution: { institution_id?: string; name?: string } | null
): Promise<void> {
  await invokePlaidLink({ action: "exchange", public_token: publicToken, institution });
}

export async function listBankItems(): Promise<BankItem[]> {
  const data = await invokePlaidLink<{ items: BankItem[] }>({ action: "list" });
  return data.items;
}

export async function syncBankItems(terms: string[]): Promise<number> {
  const data = await invokePlaidLink<{ count: number }>({ action: "sync", terms });
  return data.count;
}

export async function removeBankItem(itemId: string): Promise<void> {
  await invokePlaidLink({ action: "remove", item_id: itemId });
}
