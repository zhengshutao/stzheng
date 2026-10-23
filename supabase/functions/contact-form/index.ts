// 联系表单 edge function —— 收到提交后:
//   1. 给 stzheng@uwaterloo.ca 发一封通知邮件(reply-to 设为提交者,方便直接回复)
//   2. 给提交者自动回复一封英文确认邮件
// 邮件发送用 Resend REST API,key 存在 edge function secret(RESEND_API_KEY),不进浏览器。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OWNER_EMAIL = "stzheng@uwaterloo.ca";
const FROM_EMAIL = "noreply@stzheng.com";
const RESEND_URL = "https://api.resend.com/emails";

interface ContactPayload {
  name: string;
  email: string;
  type?: string;
  message: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendEmail(
  apiKey: string,
  payload: { to: string; subject: string; html: string; replyTo?: string }
): Promise<void> {
  const resp = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Resend API error (${resp.status}): ${body}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  try {
    const { name, email, type, message } = (await req.json()) as ContactPayload;

    if (!name?.trim() || !email?.trim() || !message?.trim()) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (!isValidEmail(email)) {
      return new Response(JSON.stringify({ error: "Invalid email" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Email service not configured" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const safeName = escapeHtml(name.trim());
    const safeEmail = escapeHtml(email.trim());
    const safeType = escapeHtml((type ?? "").trim() || "Not specified");
    const safeMessage = escapeHtml(message.trim()).replace(/\n/g, "<br/>");

    // 通知邮件(发给我) —— reply-to 设为提交者邮箱,直接回复即可
    const notifyEmail = sendEmail(apiKey, {
      to: OWNER_EMAIL,
      replyTo: email.trim(),
      subject: `New contact form message from ${name.trim()}`,
      html: `
        <p><strong>Name:</strong> ${safeName}</p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <p><strong>Project type:</strong> ${safeType}</p>
        <p><strong>Message:</strong><br/>${safeMessage}</p>
      `,
    });

    // 自动回复(发给提交者) —— reply-to 设为我的邮箱
    const autoReply = sendEmail(apiKey, {
      to: email.trim(),
      replyTo: OWNER_EMAIL,
      subject: "Thanks for reaching out — message received",
      html: `
        <p>Hi ${safeName},</p>
        <p>Thanks for reaching out through my site — I've received your message and will get back to you within 24 hours.</p>
        <p style="color:#666;">For reference, here's what you sent:</p>
        <blockquote style="border-left:3px solid #8b5cf6;margin:0;padding-left:12px;color:#666;">${safeMessage}</blockquote>
        <p>Best,<br/>Shutao Zheng</p>
      `,
    });

    const [notifyResult, replyResult] = await Promise.allSettled([notifyEmail, autoReply]);

    if (notifyResult.status === "rejected") {
      throw notifyResult.reason;
    }
    if (replyResult.status === "rejected") {
      console.error("Auto-reply failed:", replyResult.reason);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
