#!/usr/bin/env node
// SnapTrade → stock_trades / stock_cash 的本地命令行版(预览 / 排查 / 手动补跑)。
// 映射、配对、写库都在 supabase/functions/_shared/snaptradeSync.mjs,线上的 edge function snaptrade-sync
// (pg_cron 每 10 分钟调一次)用的是同一份。这里只负责:读 .env、建 SDK 客户端、把预览打印出来。
//
// 用官方 SDK(版本在 package.json 里固定),不自己签名。
//
// 环境变量(.env / .env.local):
//   SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY   —— SnapTrade Dashboard → API Key(Personal)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, WEALTHSIMPLE_USER_ID —— 和 ws:import 一样

import { writeFileSync } from "node:fs";
import process from "node:process";
import { Snaptrade, SnaptradeAuth } from "snaptrade-typescript-sdk";
import { describeDayDiff } from "../../supabase/functions/_shared/stockApply.mjs";
import { normalizeAccount, runSnaptradeSync } from "../../supabase/functions/_shared/snaptradeSync.mjs";
import { loadEnv } from "../lib/env.mjs";
import { createServiceClient } from "../lib/db.mjs";
import { printBox } from "../wealthsimple/import-csv.mjs";

function usage() {
  console.log(`
Usage:
  node scripts/snaptrade/sync-activities.mjs [--since YYYY-MM-DD] [--apply] [--raw]

  默认只预览:列出 SnapTrade 上的账户,拉活动记录,和库里已有记录配对,打印"会新增哪些"。
  --since <date>   只看这天及之后的活动(默认全部历史)
  --since-days <n> 只看最近 n 天(定时任务用,不用每次拉全部历史)
  --apply          把配不上的新记录写进 stock_trades / stock_cash,并同步收盘价、写 import_logs
  --raw            额外打印前几条原始 activity JSON(排查字段映射用)
  --dump <file>    把配对结果(新增 / 库里独有 / 价格不符 / 跳过)写成 JSON,方便排查
`);
}

function parseArgs(argv) {
  const args = { apply: false, raw: false, since: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--apply") args.apply = true;
    else if (a === "--raw") args.raw = true;
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--since-days") args.since = new Date(Date.now() - Number(argv[++i]) * 86400000).toISOString().slice(0, 10);
    else if (a === "--dump") args.dump = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  return args;
}

/** 官方 SDK 的只读适配器(Personal API key:不传 userId / userSecret) */
function snapAdapter() {
  const clientId = process.env.SNAPTRADE_CLIENT_ID;
  const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY;
  if (!clientId || !consumerKey) throw new Error("Missing SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY (.env).");
  const st = new Snaptrade({ auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }) });
  return {
    listAccounts: async () => (await st.accountInformation.listUserAccounts()).data,
    activitiesPage: async (accountId, startDate, offset, limit) =>
      (await st.accountInformation.getAccountActivities({ accountId, startDate, offset, limit })).data,
    recentOrders: async (accountId) => (await st.accountInformation.getUserAccountRecentOrders({ accountId })).data.orders ?? [],
  };
}

function fmtTrade(t) {
  return `${t.date} ${t.account.padEnd(7)} ${t.side.padEnd(4)} ${String(t.qty).padStart(8)} ${t.ticker.padEnd(22)} @ ${t.price} ${t.currency}`;
}
function fmtCash(c) {
  return `${c.date} ${c.account.padEnd(7)} ${c.type.padEnd(8)} ${c.amount} ${c.currency}  ${c.note.slice(0, 60)}`;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv);
  if (args.help) return usage();
  const userId = process.env.WEALTHSIMPLE_USER_ID;
  if (!userId) throw new Error("Missing WEALTHSIMPLE_USER_ID.");

  const plan = await runSnaptradeSync({
    snap: snapAdapter(),
    client: createServiceClient(),
    userId,
    since: args.since,
    apply: args.apply,
    log: (m) => console.log(m),
  });

  console.log("SnapTrade 账户:");
  for (const acct of plan.accounts) {
    console.log(
      `  ${acct.id}  ${String(acct.institution_name ?? "").padEnd(12)} ${String(acct.name ?? "").padEnd(24)} ` +
        `${acct.meta?.unifiedAccountType ?? acct.raw_type ?? "?"} ${acct.status ?? ""}  → ${normalizeAccount(acct) ?? "(跳过)"}`
    );
  }
  for (const a of plan.perAccount) {
    console.log(`  ${a.account}: ${a.activities} 条活动 → 交易 ${a.trades} / 现金 ${a.cash} / 跳过 ${a.skipped}`);
  }
  if (args.raw && plan.rawSamples.length) console.log("\n原始 activity 样例:\n" + JSON.stringify(plan.rawSamples, null, 2));
  if (plan.empty) {
    console.log("\nSnapTrade 没有返回任何可用的活动记录(交易记录每天刷新一次,刚连上的话可能要等一天)。");
    return;
  }

  const { incoming, from, to, tp, cp, cashCutoff, priceDiffs, tradesDbOnly, cashDbOnly } = plan;
  printBox(`SnapTrade 预览(${from} → ${to})`, [
    `交易: SnapTrade ${incoming.trades.length} 笔 = 已同步过 ${incoming.trades.length - plan.tradesNewById.length} + 配上已有 ${tp.matched.length} + 新增 ${tp.unmatched.length}`,
    `现金: SnapTrade ${incoming.cash.length} 笔 = 已同步过 ${incoming.cash.length - plan.cashNewById.length} + ${cashCutoff} 及之前(不同步) ${plan.cashHistorical.length} + 配上已有 ${cp.matched.length} + 新增 ${cp.unmatched.length}`,
    `当天订单(已成交): ${incoming.orders.length} 笔 = 已同步过 ${incoming.orders.length - plan.ordersNewById.length} + 配上已有 ${plan.op.matched.length} + 新增 ${plan.op.unmatched.length}`,
    `价格对不上(配上了但成交价差 >0.2%): ${priceDiffs.length}`,
    `库里有、SnapTrade 没有: 交易 ${tradesDbOnly.length} / 现金 ${cashDbOnly.length}`,
    `跳过(未映射类型): ${incoming.skipped.length}`,
  ]);

  const section = (title, lines, max = 40) => {
    if (!lines.length) return;
    console.log(`\n${title}(${lines.length}):`);
    for (const l of lines.slice(0, max)) console.log("  " + l);
    if (lines.length > max) console.log(`  … 还有 ${lines.length - max} 条`);
  };
  section(args.apply ? "新增的交易" : "会新增的交易", tp.unmatched.map(fmtTrade));
  section(args.apply ? "新增的当天成交" : "会新增的当天成交", plan.op.unmatched.map(fmtTrade));
  section(args.apply ? "新增的现金" : "会新增的现金", cp.unmatched.map(fmtCash));
  section(`${cashCutoff} 及之前、库里配不上的现金(口径不同,不写入,仅供核对)`, plan.cashHistoricalUnmatched.map(fmtCash), 20);
  section("价格对不上", priceDiffs.map(([s, d]) => `${fmtTrade(s)}   库里: ${d.price} (${d.id})`));
  section("库里有、SnapTrade 没有的交易", tradesDbOnly.map((t) => `${fmtTrade(t)}   (${t.id})`));
  section("库里有、SnapTrade 没有的现金", cashDbOnly.map((c) => `${fmtCash(c)}   (${c.id})`));
  const skipCounts = Object.entries(Object.groupBy(incoming.skipped, (s) => s.type)).map(([t, l]) => `${t}: ${l.length}  例: ${l[0].description ?? ""}`);
  section("跳过的类型", skipCounts);

  if (args.dump) {
    writeFileSync(args.dump, JSON.stringify({ from, to, newTrades: tp.unmatched, newCash: cp.unmatched, tradesDbOnly, cashDbOnly, priceDiffs, skipped: incoming.skipped }, null, 2));
    console.log(`\n配对结果已写入 ${args.dump}`);
  }

  if (!args.apply) {
    console.log("\n只是预览,没有写数据库。确认没问题后加 --apply。");
    return;
  }
  const result = plan.result;
  if (!result) {
    console.log("\n没有新记录,不写数据库。");
    return;
  }
  const diffLines = [
    ...result.pnlDiff.added.map((d) => describeDayDiff("added", d)),
    ...result.pnlDiff.changed.map((d) => describeDayDiff("changed", d)),
    ...result.pnlDiff.removed.map((d) => describeDayDiff("removed", d)),
  ].sort();
  printBox("SnapTrade 同步完成 ✓", [result.summary, "", ...(diffLines.length ? diffLines.slice(0, 40) : ["日历无变动"])]);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
