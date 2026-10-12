#!/usr/bin/env node
// 每日收盘价同步 —— 每日盈亏的唯一价格来源。
//
// 做什么:
//   1. 从 stock_trades / stock_splits 算出每个 ticker+币种 需要收盘价的日期区间
//      (首笔成交前 7 天 → 清仓日;还持有的 → 今天),外加 USD/CAD 汇率。
//   2. 对照 stock_price_symbols 里"已同步到哪天",只拉缺的部分(雅虎财经 chart 接口,免 key)。
//   3. 写入 stock_prices(主键 ticker+currency+date,重复 upsert 幂等)。
//
// 什么时候跑:
//   - Wealthsimple 导入脚本每次 --apply 之后自动跑(新 ticker / 新日期马上有价)。
//   - 本地 helper 的 POST /prices/sync(首页"更新行情"按钮)。
//   - 手动:npm run prices:sync。收盘后(美东 16:10 之后)跑一次,当天的盈亏就从"实时价"变成"收盘价"。
//
// 规则:
//   - 只存已经收盘的那天(美东 16:10 之前不存今天的,免得把盘中价当收盘价)。
//   - 存的是"当时的原始收盘价"(未按拆股回调)。雅虎 chart 接口返回的历史价是按后来的拆股
//     回调过的(比如 5 合 1 之后,之前的 13 块会显示成 65 块),这里用接口同时返回的拆股事件
//     把它还原回去 —— 这样价格和 stock_trades 里当时的成交价永远同一口径,持仓股数也不用换算,
//     而且已经存下来的历史价以后不会因为新的拆股而变,清仓的票永远不用重拉。
//   - 雅虎没有的票(到期期权、退市)记 status=not_found,还持有的每天重试一次,已清仓的不再试。
//
// 用法:
//   node scripts/prices/sync-prices.mjs [--user <uuid>] [--refetch TICKER|CCY]... [--all] [--no-db --out file.json]
//     --user      指定 user_id(默认 WEALTHSIMPLE_USER_ID,再不行就取 stock_trades 里的第一个)
//     --refetch   强制整段重拉某只票(例:--refetch CLBK|USD)
//     --all       忽略"已同步到哪天",全部重拉(慎用,雅虎会限流)
//     --no-db     不写数据库(配合 --out 把拉到的价格存成 JSON,调试用)

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { syncPrices } from "../../supabase/functions/_shared/priceSync.mjs";
import { loadEnv } from "../lib/env.mjs";
import { createServiceClient } from "../lib/db.mjs";

// 实现在 supabase/functions/_shared/priceSync.mjs;老的 import 路径继续能用
export { calibrateBars, fetchYahooDaily, loadPriceSeries, priceSeriesFromRows, syncPrices } from "../../supabase/functions/_shared/priceSync.mjs";

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { refetch: [], all: false, noDb: false, out: null, user: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user") args.user = argv[++i];
    else if (a === "--refetch") args.refetch.push(argv[++i]);
    else if (a === "--all") args.all = true;
    else if (a === "--no-db") args.noDb = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return args;
}

export async function resolveUserId(client, explicit) {
  if (explicit) return explicit;
  if (process.env.WEALTHSIMPLE_USER_ID) return process.env.WEALTHSIMPLE_USER_ID;
  const { data } = await client.from("stock_trades").select("user_id").limit(1);
  return data?.[0]?.user_id ?? null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("node scripts/prices/sync-prices.mjs [--user <uuid>] [--refetch TICKER|CCY]... [--all] [--no-db --out file.json]");
    return;
  }
  loadEnv();
  const client = createServiceClient();
  const userId = await resolveUserId(client, args.user);
  if (!userId) throw new Error("找不到 user_id:传 --user 或设置 WEALTHSIMPLE_USER_ID。");
  const result = await syncPrices({ client, userId, log: (m) => console.log(m), refetch: args.refetch, all: args.all, noDb: args.noDb });
  if (result.missingTable) {
    console.error("stock_prices / stock_price_symbols 表还没建 —— 先在 Supabase SQL Editor 里执行 supabase/schema.sql 末尾的那段。");
    process.exit(2);
  }
  if (args.out && result.rows) {
    writeFileSync(path.resolve(args.out), JSON.stringify(result.rows));
    console.log(`已写入 ${result.rows.length} 行到 ${args.out}`);
  }
  console.log(
    `完成:拉取 ${result.fetched.length} 个标的 / ${result.bars} 天,跳过 ${result.skipped},雅虎无数据 ${result.notFound.length},出错 ${result.errors.length}` +
      (result.warnings.length ? `,需核对 ${result.warnings.length}` : "")
  );
  if (result.errors.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
