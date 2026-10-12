#!/usr/bin/env node
// 止损单命令行:给某只股票挂卖出止损(Stop, GTC),或者把已有止损改价。
// 默认只预览,打印将要提交的订单;加 --confirm 才真的发给券商。
//
// 改价先试 trading.replaceOrder;券商不支持就退回"撤单 → 重新下单",
// 中间有几秒没有止损保护,新单没挂上会大声报错(不自动重试,避免重复下单)。
//
// 每下一笔就记进 stock_stop_orders(basis = custom),K 线页才知道触发价(Wealthsimple 不回报);撤掉的标 canceled_at。
//
// 环境变量(.env / .env.local):SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY(连接需要是 trade 类型)
//   记录用:SUPABASE_URL + SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY, WEALTHSIMPLE_USER_ID

import process from "node:process";
import { Snaptrade, SnaptradeAuth } from "snaptrade-typescript-sdk";
import { loadEnv } from "../lib/env.mjs";
import { createServiceClient } from "../lib/db.mjs";

function usage() {
  console.log(`
Usage:
  npm run snaptrade:stop -- --symbol ASST --stop 26.5 [--units 120] [--account d148] [--confirm]
  npm run snaptrade:stop -- --symbol ASST --replace 26.6 [--order <brokerage_order_id>] [--confirm]

  --symbol <ticker>   股票代码(必填)
  --stop <price>      新挂一笔卖出止损,触发价 <price>
  --replace <price>   把已有的卖出止损改到 <price>
  --units <n>         股数(默认:新单 = 全部持仓;改价 = 原单股数)
  --account <prefix>  账户 ID 前缀(同一只股票在多个账户里时必填)
  --order <id>        改价时指定原单(同一只股票有多笔止损时必填)
  --confirm           真的提交;不加只预览
`);
}

function parseArgs(argv) {
  const args = { confirm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--symbol") args.symbol = argv[++i]?.toUpperCase();
    else if (a === "--stop") args.stop = Number(argv[++i]);
    else if (a === "--replace") args.replace = Number(argv[++i]);
    else if (a === "--units") args.units = Number(argv[++i]);
    else if (a === "--account") args.account = argv[++i];
    else if (a === "--order") args.order = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  return args;
}

function validate(args) {
  if (!args.symbol) throw new Error("缺少 --symbol");
  if ((args.stop == null) === (args.replace == null)) throw new Error("--stop 和 --replace 二选一");
  for (const [k, v] of [["--stop", args.stop], ["--replace", args.replace], ["--units", args.units]]) {
    if (v != null && !(Number.isFinite(v) && v > 0)) throw new Error(`${k} 必须是正数`);
  }
}

function client() {
  const clientId = process.env.SNAPTRADE_CLIENT_ID;
  const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY;
  if (!clientId || !consumerKey) throw new Error("Missing SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY (.env).");
  return new Snaptrade({ auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }) });
}

const orderSymbol = (o) => o.universal_symbol?.symbol ?? o.option_symbol?.ticker ?? o.symbol?.symbol ?? o.symbol;
const isSellStop = (o, symbol) =>
  orderSymbol(o) === symbol && o.action === "SELL" && /^Stop$/i.test(o.order_type ?? "");
const fmtOrder = (o) =>
  `${o.brokerage_order_id}  ${o.status}  ${o.action} ${Number(o.total_quantity)} ${orderSymbol(o)} ` +
  `${o.order_type} stop=${o.stop_price ?? "-"} limit=${o.limit_price ?? "-"} ${o.time_in_force}`;

/** 找持有该股票的账户和持仓 */
async function findHolding(st, symbol, accountPrefix) {
  const accounts = (await st.accountInformation.listUserAccounts()).data;
  const hits = [];
  for (const a of accounts) {
    if (accountPrefix && !a.id.startsWith(accountPrefix)) continue;
    let positions;
    try {
      positions = (await st.accountInformation.getAllAccountPositions({ accountId: a.id })).data.results ?? [];
    } catch {
      continue; // 信用卡、加密账户等没有股票持仓
    }
    const p = positions.find((x) => x.instrument?.symbol === symbol);
    if (p) hits.push({ account: a, units: Number(p.units), price: Number(p.price), currency: p.currency });
  }
  if (hits.length === 0) throw new Error(`没有账户持有 ${symbol}${accountPrefix ? `(--account ${accountPrefix})` : ""}`);
  if (hits.length > 1) {
    const list = hits.map((h) => `  ${h.account.id}  ${h.account.name}  ${h.units} 股`).join("\n");
    throw new Error(`${symbol} 在多个账户里,用 --account 指定:\n${list}`);
  }
  return hits[0];
}

async function openOrders(st, accountId) {
  return (await st.accountInformation.getUserAccountOrders({ accountId, state: "open" })).data;
}

async function placeStop(st, accountId, symbol, units, stop) {
  return (
    await st.trading.placeForceOrder({
      account_id: accountId,
      action: "SELL",
      order_type: "Stop",
      time_in_force: "GTC",
      symbol,
      universal_symbol_id: null,
      units,
      stop,
    })
  ).data;
}

/** 记一笔止损到 stock_stop_orders;记不上只警告,单已经挂上了 */
async function record(order, { accountId, symbol, units, stop }) {
  try {
    const { error } = await createServiceClient().from("stock_stop_orders").insert({
      user_id: process.env.WEALTHSIMPLE_USER_ID,
      ticker: symbol,
      account_id: accountId,
      brokerage_order_id: order.brokerage_order_id,
      stop_price: stop,
      units,
      basis: "custom",
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.log(`  ⚠️  止损已挂上,但没记进 stock_stop_orders(页面会显示"价格未知"):${e.message}`);
  }
}

async function markCanceled(orderId) {
  try {
    await createServiceClient().from("stock_stop_orders").update({ canceled_at: new Date().toISOString() }).eq("brokerage_order_id", orderId);
  } catch {
    /* 只是记录,失败无所谓 */
  }
}

/**
 * 提交后再查一次,确认止损真的挂着。
 * Wealthsimple 的订单列表不回报 stop_price(一直是 null),所以按订单 ID 认,触发价只能去 App 里看。
 */
async function verify(st, accountId, symbol, orderId) {
  await new Promise((r) => setTimeout(r, 2000));
  const live = (await openOrders(st, accountId)).filter((o) => isSellStop(o, symbol));
  const ok = live.some((o) => o.brokerage_order_id === orderId);
  console.log(`\n当前 ${symbol} 未成交止损单(Wealthsimple 不回报触发价):`);
  for (const o of live) console.log(`  ${fmtOrder(o)}`);
  if (!ok) console.log(`  ⚠️  没看到 ${orderId},去 Wealthsimple 里确认一下`);
  return ok;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv);
  if (args.help) return usage();
  validate(args);
  const st = client();
  const { symbol } = args;

  const holding = await findHolding(st, symbol, args.account);
  const accountId = holding.account.id;
  const stops = (await openOrders(st, accountId)).filter((o) => isSellStop(o, symbol));

  console.log(`账户   ${holding.account.name}  ${accountId}`);
  console.log(`持仓   ${holding.units} 股 ${symbol}  报价 ${holding.price} ${holding.currency}`);
  console.log(`止损单 ${stops.length ? "" : "无"}`);
  for (const o of stops) console.log(`  ${fmtOrder(o)}`);

  // 持仓里的 price 会滞后,用券商实时报价(买价 / 最新成交价里低的那个)校验,免得挂在现价之上被拒
  try {
    const q = (await st.trading.getUserAccountQuotes({ accountId, symbols: symbol, useTicker: true })).data[0];
    const live = [q?.bid_price, q?.last_trade_price].map(Number).filter((v) => Number.isFinite(v) && v > 0);
    if (live.length) holding.price = Math.min(holding.price, ...live);
  } catch {
    /* 拿不到实时价就用持仓价 */
  }
  const newStop = args.stop ?? args.replace;
  if (newStop >= holding.price) throw new Error(`触发价 ${newStop} 不低于现价 ${holding.price},卖出止损会立刻触发`);

  if (args.stop != null) {
    // ---- 新挂止损 ----
    if (stops.length) throw new Error(`已经有 ${symbol} 的止损单,改价用 --replace`);
    const units = args.units ?? holding.units;
    if (units > holding.units) throw new Error(`股数 ${units} 超过持仓 ${holding.units}`);
    console.log(`\n将提交  SELL ${units} ${symbol}  Stop @ ${newStop}  GTC`);
    if (!args.confirm) return console.log("(预览,加 --confirm 提交)");

    const placed = await placeStop(st, accountId, symbol, units, newStop);
    console.log(`已提交  ${fmtOrder(placed)}`);
    await record(placed, { accountId, symbol, units, stop: newStop });
    if (!(await verify(st, accountId, symbol, placed.brokerage_order_id))) process.exitCode = 2;
    return;
  }

  // ---- 改价 ----
  const target = args.order ? stops.find((o) => o.brokerage_order_id === args.order) : stops.length === 1 ? stops[0] : null;
  if (!target) {
    throw new Error(stops.length ? `${symbol} 有 ${stops.length} 笔止损,用 --order 指定` : `没有 ${symbol} 的未成交止损单可改`);
  }
  const units = args.units ?? Number(target.total_quantity);
  if (units > holding.units) throw new Error(`股数 ${units} 超过持仓 ${holding.units}`);
  console.log(`\n将修改  ${target.brokerage_order_id}  stop → ${newStop}  (${units} 股, GTC;原触发价 Wealthsimple 不回报)`);
  if (!args.confirm) return console.log("(预览,加 --confirm 提交)");

  let newId;
  try {
    const replaced = (
      await st.trading.replaceOrder({
        accountId,
        brokerage_order_id: target.brokerage_order_id,
        action: "SELL",
        order_type: "Stop",
        time_in_force: "GTC",
        symbol,
        units,
        stop: newStop,
      })
    ).data;
    newId = replaced.brokerage_order_id; // 改单后 ID 可能变,以返回的为准
    console.log(`已改单(replaceOrder)  ${fmtOrder(replaced)}`);
    await markCanceled(target.brokerage_order_id);
    await record(replaced, { accountId, symbol, units, stop: newStop });
  } catch (e) {
    console.log(`replaceOrder 失败:${e.responseBody ? JSON.stringify(e.responseBody) : e.message}`);
    console.log("改为:撤单 → 重新下单");
    await st.trading.cancelOrder({ accountId, brokerage_order_id: target.brokerage_order_id });
    console.log(`已撤单  ${target.brokerage_order_id}`);
    await markCanceled(target.brokerage_order_id);
    try {
      const placed = await placeStop(st, accountId, symbol, units, newStop);
      newId = placed.brokerage_order_id;
      console.log(`已重新下单  ${fmtOrder(placed)}`);
      await record(placed, { accountId, symbol, units, stop: newStop });
    } catch (e2) {
      console.error(`\n‼️  旧止损已撤,新止损没挂上:${e2.message}`);
      console.error(`   现在 ${symbol} 没有止损保护。先查一下 Wealthsimple,再手动重跑:`);
      console.error(`   npm run snaptrade:stop -- --symbol ${symbol} --stop ${newStop} --units ${units} --account ${accountId.slice(0, 8)}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!(await verify(st, accountId, symbol, newId))) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
