// Plaid Link 授权流程 edge function —— 移植自 /Users/szheng/记账/server.js 的
// /api/create_link_token, /api/exchange_public_token, /api/items 系列路由。
//
// 单一入口,按请求体里的 action 分发:
//   { action: "link_token" }                         → 创建 Plaid Link token
//   { action: "exchange", public_token, institution } → 换取 access_token,存 bank_items,
//                                                        后台立即触发一次该银行的同步
//   { action: "list" }                                → 列出当前用户已连接的银行(不含 access_token)
//   { action: "remove", item_id }                     → 解除银行连接(不删历史交易记录)
//
// 鉴权:和 stock-stops 一样,用调用者透传的 Authorization(用户 JWT)建一个 client 来确认
// auth.uid();但 bank_items 表本身对 authenticated 没有任何 RLS policy,所以所有实际读写都
// 另外用 SUPABASE_SERVICE_ROLE_KEY 建的 client 做,并在代码里手动按 user_id 过滤。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLAID_BASE: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: authErr,
    } = await supabaseUser.auth.getUser();
    if (authErr || !user) return jsonResponse({ error: "unauthorized" }, 401);
    // 只给本人用:Supabase 开着注册时,别人注册个号也能连银行、花 Plaid 的额度
    const ownerId = Deno.env.get("PORTFOLIO_OWNER_USER_ID");
    if (!ownerId) return jsonResponse({ error: "server not configured" }, 500);
    if (user.id !== ownerId) return jsonResponse({ error: "forbidden" }, 403);

    const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const base = PLAID_BASE[Deno.env.get("PLAID_ENV") ?? "production"];
    const client_id = Deno.env.get("PLAID_CLIENT_ID")!;
    const secret = Deno.env.get("PLAID_SECRET")!;

    const body = await req.json();

    if (body.action === "link_token") {
      const resp = await fetch(`${base}/link/token/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id,
          secret,
          user: { client_user_id: user.id },
          client_name: "stzheng dashboard",
          products: ["transactions"],
          country_codes: ["CA"],
          language: "en",
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return jsonResponse({ error: data }, 500);
      return jsonResponse({ link_token: data.link_token });
    }

    if (body.action === "exchange") {
      const { public_token, institution } = body as {
        public_token: string;
        institution?: { institution_id?: string; name?: string };
      };
      const resp = await fetch(`${base}/item/public_token/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id, secret, public_token }),
      });
      const data = await resp.json();
      if (!resp.ok) return jsonResponse({ error: data }, 500);

      const { error: upsertErr } = await supabaseAdmin.from("bank_items").upsert({
        item_id: data.item_id,
        user_id: user.id,
        access_token: data.access_token,
        institution_id: institution?.institution_id ?? null,
        institution_name: institution?.name ?? null,
        status: "ok",
        updated_at: new Date().toISOString(),
      });
      if (upsertErr) return jsonResponse({ error: upsertErr.message }, 500);

      // 后台立即触发一次同步,不阻塞响应(首次同步可能耗时较长)
      const syncPromise = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/bank-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "" },
        body: JSON.stringify({ item_id: data.item_id, immediate: true }),
      }).catch(() => {});
      // @ts-ignore EdgeRuntime 由 Supabase 平台注入,用于后台任务
      (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil(
        syncPromise
      );

      return jsonResponse({ ok: true, item_id: data.item_id });
    }

    if (body.action === "list") {
      const { data, error } = await supabaseAdmin
        .from("bank_items")
        .select("item_id, institution_name, status, created_at")
        .eq("user_id", user.id)
        .order("created_at");
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ items: data });
    }

    if (body.action === "sync") {
      const terms = ((body.terms ?? []) as string[]).map((term) => term.toLowerCase());
      let q = supabaseAdmin
        .from("bank_items")
        .select("item_id, institution_name")
        .eq("user_id", user.id)
        .neq("access_token", "");
      const { data: items, error } = await q;
      if (error) return jsonResponse({ error: error.message }, 500);

      const matched = (items ?? []).filter((item) => {
        if (terms.length === 0) return true;
        const name = String(item.institution_name ?? "").toLowerCase();
        return terms.some((term) => name.includes(term));
      });

      for (const item of matched) {
        const syncPromise = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/bank-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "" },
          body: JSON.stringify({ item_id: item.item_id, immediate: true }),
        }).catch(() => {});
        // @ts-ignore EdgeRuntime 由 Supabase 平台注入,用于后台任务
        (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil(
          syncPromise
        );
      }

      return jsonResponse({ ok: true, count: matched.length });
    }

    if (body.action === "remove") {
      const { item_id } = body as { item_id: string };
      const { data: item } = await supabaseAdmin
        .from("bank_items")
        .select("item_id, access_token")
        .eq("item_id", item_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!item) return jsonResponse({ error: "not found" }, 404);
      try {
        await fetch(`${base}/item/remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id, secret, access_token: item.access_token }),
        });
      } catch {
        // 远端可能已失效,忽略
      }
      const { error: delErr } = await supabaseAdmin.from("bank_items").delete().eq("item_id", item_id).eq(
        "user_id",
        user.id
      );
      if (delErr) return jsonResponse({ error: delErr.message }, 500);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "unknown action" }, 400);
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
});
