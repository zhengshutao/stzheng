// 每日银行同步 edge function —— 移植自 /Users/szheng/记账/sync.js 的 transactionsSync 循环,
// 直接写入 daily_transactions(替代原来本地 launchd + supabase-push.js 的链路)。
//
// 触发方式:
//   1. pg_cron + pg_net 每天 UTC 00:00 / 01:00 各调用一次(见 schema.sql 底部注释),
//      本函数按 America/Toronto 当地时间是否为晚 8 点自我判断是否真正执行,
//      两次里恰好命中一次,兼容夏令时切换,不用手动改 cron 时间。
//   2. plaid-link 函数在新连接一家银行后,立即以 {item_id, immediate:true} 调一次。
//   3. 也可手动传 {immediate:true} 强制全量同步(用于验证/补跑)。
//
// 鉴权:不用 Supabase JWT/service-role key(新旧格式密钥不确定,pg_net 里传起来容易出错),
// 改用独立的 x-cron-secret 头,只有 cron job 和 plaid-link 知道这个值(存在 Vault + edge
// function secret 两份,值相同)。函数内部对数据库的读写仍然用平台自动注入的
// SUPABASE_SERVICE_ROLE_KEY 建 client(不需要额外配置)。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLAID_BASE: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

interface BankItem {
  item_id: string;
  user_id: string;
  access_token: string;
  institution_name: string | null;
  cursor: string | null;
}

interface SyncResult {
  item_id: string;
  institution_name: string | null;
  added?: number;
  modified?: number;
  removed?: number;
  status?: string;
  error?: string;
}

async function syncItem(
  supabaseAdmin: ReturnType<typeof createClient>,
  base: string,
  client_id: string,
  secret: string,
  item: BankItem
): Promise<SyncResult> {
  let cursor = item.cursor ?? undefined;
  let hasMore = true;
  let added = 0,
    modified = 0,
    removed = 0;

  while (hasMore) {
    const resp = await fetch(`${base}/transactions/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id, secret, access_token: item.access_token, cursor, count: 500 }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = new Error(data?.error_code ?? `plaid error ${resp.status}`);
      (err as { plaid?: unknown }).plaid = data;
      throw err;
    }

    const upsertRows = [...data.added, ...data.modified].map((t: Record<string, unknown>) => ({
      id: t.transaction_id,
      user_id: item.user_id,
      date: t.date,
      name: t.name ?? null,
      merchant: (t.merchant_name as string | null) ?? null,
      amount: t.amount,
      currency: t.iso_currency_code ?? t.unofficial_currency_code ?? "CAD",
      category: (t.personal_finance_category as { primary?: string } | null)?.primary ?? null,
      pending: !!t.pending,
      source: "plaid",
      institution_name: item.institution_name,
      synced_at: new Date().toISOString(),
      // 故意不写 is_transfer / note:让 upsert 只在真正新行时用列默认值,
      // 已存在的行(用户在网页端手动改过 is_transfer/note)完全不被覆盖。
    }));
    if (upsertRows.length) {
      const { error } = await supabaseAdmin.from("daily_transactions").upsert(upsertRows, { onConflict: "id" });
      if (error) throw error;
      added += data.added.length;
      modified += data.modified.length;
    }
    if (data.removed?.length) {
      const ids = data.removed.map((r: { transaction_id: string }) => r.transaction_id);
      await supabaseAdmin.from("daily_transactions").delete().in("id", ids);
      removed += data.removed.length;
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  await supabaseAdmin
    .from("bank_items")
    .update({ cursor, status: "ok", updated_at: new Date().toISOString() })
    .eq("item_id", item.item_id);

  return { item_id: item.item_id, institution_name: item.institution_name, added, modified, removed, status: "ok" };
}

function torontoHourNow(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    hour: "numeric",
    hourCycle: "h23",
  }).format(new Date());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { item_id, immediate } = body as { item_id?: string; immediate?: boolean };

    if (!item_id && !immediate) {
      const hour = torontoHourNow();
      if (hour !== "20") {
        return new Response(JSON.stringify({ ok: true, skipped: true, reason: `not 8pm Toronto (hour=${hour})` }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const base = PLAID_BASE[Deno.env.get("PLAID_ENV") ?? "production"];
    const client_id = Deno.env.get("PLAID_CLIENT_ID")!;
    const secret = Deno.env.get("PLAID_SECRET")!;

    let q = supabaseAdmin.from("bank_items").select("item_id, user_id, access_token, institution_name, cursor").neq(
      "access_token",
      ""
    );
    if (item_id) q = q.eq("item_id", item_id);
    const { data: items, error: itemsErr } = await q;
    if (itemsErr) {
      return new Response(JSON.stringify({ error: itemsErr.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const results: SyncResult[] = [];
    for (const item of (items ?? []) as BankItem[]) {
      try {
        results.push(await syncItem(supabaseAdmin, base, client_id, secret, item));
      } catch (e) {
        const code = (e as { plaid?: { error_code?: string } })?.plaid?.error_code ?? String(e);
        if (code === "ITEM_LOGIN_REQUIRED") {
          await supabaseAdmin
            .from("bank_items")
            .update({ status: "login_required", updated_at: new Date().toISOString() })
            .eq("item_id", item.item_id);
        }
        results.push({ item_id: item.item_id, institution_name: item.institution_name, error: String(code) });
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
