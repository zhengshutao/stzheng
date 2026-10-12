#!/usr/bin/env node
// 本地 helper —— 首页"同步"面板的两个按钮都打到这里(http://127.0.0.1:8899):
//   POST /wealthsimple/sync  打开 WS 下载活动 CSV,下载完自动导入 + 同步收盘价 + 写日志
//   POST /prices/sync        只同步收盘价(收盘后点一下,今天的盈亏就从实时价变成收盘价)
//   GET  /status             两个任务的运行状态和最近输出
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import process from "node:process";
import { loadEnv } from "../lib/env.mjs";

const ROOT = process.cwd();
const PORT = Number(process.env.WS_HELPER_PORT || 8899);
let current = null;
let lastRun = null;
let priceJob = null;
let lastPriceRun = null;

loadEnv(ROOT);

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 10000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function startWealthsimpleSync(body = {}) {
  if (current) {
    return {
      ok: true,
      running: true,
      canApply: lastRun?.canApply ?? false,
      message: "Wealthsimple sync is already running.",
    };
  }

  const userId = typeof body.userId === "string" ? body.userId : process.env.WEALTHSIMPLE_USER_ID;
  const canApply = Boolean(
    (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY) &&
      userId
  );

  current = spawn(process.execPath, ["scripts/wealthsimple/download-activities.mjs", "--auto"], {
    cwd: ROOT,
    env: { ...process.env, WEALTHSIMPLE_USER_ID: userId ?? "", WS_IMPORT_APPLY: canApply ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  lastRun = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    canApply,
    output: [],
  };

  const collect = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    lastRun.output.push(...text.split(/\r?\n/).filter(Boolean));
    lastRun.output = lastRun.output.slice(-80);
  };

  current.stdout.on("data", collect);
  current.stderr.on("data", collect);
  current.on("exit", (code) => {
    lastRun.finishedAt = new Date().toISOString();
    lastRun.exitCode = code;
    current = null;
  });

  return {
    ok: true,
    running: true,
    canApply,
    message: canApply
      ? "Started Wealthsimple browser sync. Log in, choose/download the activity CSV, and it will import automatically."
      : "Started Wealthsimple browser sync. CSV will be parsed, but Supabase auto-import is missing env vars.",
  };
}

function startPriceSync(body = {}) {
  if (priceJob) return { ok: true, running: true, message: "Price sync is already running." };
  const userId = typeof body.userId === "string" ? body.userId : process.env.WEALTHSIMPLE_USER_ID;
  const args = ["scripts/prices/sync-prices.mjs"];
  if (userId) args.push("--user", userId);
  if (Array.isArray(body.refetch)) for (const k of body.refetch) if (typeof k === "string") args.push("--refetch", k);
  priceJob = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  lastPriceRun = { startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, output: [] };
  const collect = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    lastPriceRun.output.push(...text.split(/\r?\n/).filter(Boolean));
    lastPriceRun.output = lastPriceRun.output.slice(-80);
  };
  priceJob.stdout.on("data", collect);
  priceJob.stderr.on("data", collect);
  priceJob.on("exit", (code) => {
    lastPriceRun.finishedAt = new Date().toISOString();
    lastPriceRun.exitCode = code;
    priceJob = null;
  });
  return { ok: true, running: true, message: "Started price sync." };
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  if (req.method === "GET" && req.url === "/status") {
    return json(res, 200, {
      ok: true,
      running: Boolean(current),
      lastRun,
      prices: { running: Boolean(priceJob), lastRun: lastPriceRun },
    });
  }

  if (req.method === "POST" && req.url === "/prices/sync") {
    const body = await readBody(req);
    return json(res, 200, startPriceSync(body));
  }

  if (req.method === "POST" && req.url === "/wealthsimple/sync") {
    const body = await readBody(req);
    return json(res, 200, startWealthsimpleSync(body));
  }

  return json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Wealthsimple helper listening on http://127.0.0.1:${PORT}`);
});
