#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { applyToSupabase as applyRows } from "../../supabase/functions/_shared/stockApply.mjs";
import { loadEnv } from "../lib/env.mjs";
import { createServiceClient } from "../lib/db.mjs";

const ROOT = process.cwd();
const DEFAULT_OUT_DIR = path.join(ROOT, "data/wealthsimple/normalized");

function usage() {
  console.log(`
Usage:
  node scripts/wealthsimple/import-csv.mjs --file <wealthsimple.csv> [--apply]

Options:
  --file <path>       Wealthsimple activities CSV to parse.
  --account <name>    Default account when the CSV does not include one. Default: TFSA.
  --out <dir>         Directory for normalized JSON output. Default: data/wealthsimple/normalized.
  --apply             Upsert parsed rows into Supabase (stock_trades / stock_cash / daily_transactions),
                       sync daily close prices (stock_prices), diff the daily P&L calendar before/after,
                       and write a summary (+ the diff) to the import_logs table.
  --help              Show this help.

For --apply, set:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  WEALTHSIMPLE_USER_ID

Requires the import_logs table — run the bottom of supabase/schema.sql once in the
Supabase SQL editor if it hasn't been created yet.
`);
}

function parseArgs(argv) {
  const args = { account: "TFSA", out: DEFAULT_OUT_DIR, apply: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--file") args.file = argv[++i];
    else if (arg === "--account") args.account = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        value += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(value);
      value = "";
    } else if (ch === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (ch !== "\r") {
      value += ch;
    }
  }
  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function normalizeHeader(header) {
  return header
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header || `column_${index}`] = row[index]?.trim() ?? "";
    });
    return obj;
  });
}

function pick(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && String(row[key]).trim() !== "") return String(row[key]).trim();
  }
  return "";
}

function parseNumber(input) {
  const cleaned = String(input ?? "")
    .replace(/\((.*)\)/, "-$1")
    .replace(/[,$+\s]/g, "")
    .replace(/−/g, "-");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDate(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!m) return null;
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  return parsed.toISOString().slice(0, 10);
}

function parseTime(input) {
  const raw = String(input ?? "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
}

function combineDateTime(date, time) {
  const parsedTime = parseTime(time);
  return parsedTime ? `${date}T${parsedTime}` : date;
}

function classify(type, description, direction) {
  const text = `${type} ${description} ${direction}`.toLowerCase();
  if (/\b(buy|bought|purchase|purchased)\b/.test(text)) return "buy";
  if (/\b(sell|sold|sale)\b/.test(text)) return "sell";
  if (/\b(dividend|distribution|interest|cash\s?back)\b/.test(text)) return "cash_deposit";
  if (/\b(deposit|contribution|transfer in|money transfer into|funding|received|credit)\b/.test(text)) return "cash_deposit";
  if (/\b(withdraw|withdrawal|transfer out|e-transfer.*out|obp_out|online bill payment|credit card payment|fee|charged|debit)\b/.test(text)) return "cash_withdraw";
  return "skip";
}

function stableId(prefix, row) {
  const hash = createHash("sha1").update(JSON.stringify(row)).digest("hex").slice(0, 24);
  return `${prefix}_${hash}`;
}

function normalizeAccount(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes("tfsa")) return "TFSA";
  if (text.includes("non") && (text.includes("registered") || text.includes("reg"))) return "NON-REG";
  if (text.includes("margin")) return "NON-REG";
  return text.toUpperCase();
}

function isStockAccount(account) {
  return account === "TFSA" || account === "NON-REG";
}

// Chequing / USD savings 是 WS 用来给 TFSA/NON-REG 转钱的现金账户,不算持仓账户,
// 但里面的钱进出(尤其是转去投资账户之外的部分,比如 e-Transfer、账单代付)
// 属于日常收支,要并进 daily_transactions,不能整段丢掉。
function isDailyCashAccount(accountType) {
  const t = String(accountType || "").trim().toLowerCase();
  return t === "chequing" || t === "usd savings";
}

// WS 的"Money transfer into/out of the account"描述在 Chequing 和 TFSA/NON-REG 两边
// 是成对出现的同一笔转账(资金从 Chequing 转进/转出投资账户)——TFSA/NON-REG 那一侧已经
// 作为 stock_cash 的存/取记录算过一次了,Chequing 这一侧只是镜像,标记成 is_transfer 避免
// 在"日常支出"里被重复计入一遍。其余(外部 e-Transfer、账单代付、EFT 出入金等)默认也先按
// 转账处理,不计入支出统计,免得和已经在同步的银行账户(bank_items/Plaid)重复计数——
// 真正需要算作支出的,用户可以在日常记录页里手动把 is_transfer 改成 false。
function dailyTxIsTransfer() {
  return true;
}

function normalizeRows(rows, defaults) {
  const trades = [];
  const cash = [];
  const dailyTx = [];
  const skipped = [];

  rows.forEach((row, index) => {
    const date = parseDate(
      pick(row, ["date", "effective_date", "settlement_date", "trade_date", "created_at", "transaction_date"])
    );
    const ts = date ? combineDateTime(date, pick(row, ["effective_time", "time", "created_time"])) : null;
    const type = pick(row, ["type", "activity_type", "transaction_type", "action"]);
    const subType = pick(row, ["activity_sub_type", "sub_type"]);
    const direction = pick(row, ["direction"]);
    const description = [subType, pick(row, ["description", "name", "details", "security_name", "notes"])]
      .filter(Boolean)
      .join(" - ");
    let kind = classify(type, description, direction);
    const rawAccountType = pick(row, ["account_type"]);
    const rawAccount = pick(row, ["account", "account_name", "account_type"]) || defaults.account;
    const account = normalizeAccount(rawAccount);
    const currency = (pick(row, ["currency", "amount_currency", "price_currency"]) || "CAD").toUpperCase();
    const rawAmount =
      parseNumber(pick(row, ["amount", "net_cash_amount", "net_amount", "total_amount", "value", "book_value", "cash_amount"])) ??
      0;
    if (kind === "skip" && /\btax\b/i.test(type)) kind = "cash_withdraw";
    if (kind === "skip" && /\b(fxexchange|moneymovement)\b/i.test(type) && rawAmount !== 0) {
      kind = rawAmount > 0 ? "cash_deposit" : "cash_withdraw";
    }

    if (!date || kind === "skip") {
      skipped.push({ row: index + 2, reason: !date ? "missing date" : "unmapped type", type, description });
      return;
    }

    if (isDailyCashAccount(rawAccountType)) {
      if (kind !== "cash_deposit" && kind !== "cash_withdraw") {
        skipped.push({ row: index + 2, reason: `unmapped daily-cash activity (${kind})`, type, description });
        return;
      }
      const amount = Math.abs(rawAmount);
      if (!amount) {
        skipped.push({ row: index + 2, reason: "daily-cash row missing amount", type, description });
        return;
      }
      // daily_transactions 约定: amount > 0 支出, < 0 收入 —— 和 WS 的正负号(存入为正)相反。
      const plaidAmount = kind === "cash_deposit" ? -amount : amount;
      dailyTx.push({
        id: stableId("ws_daily", { date, kind, amount, currency, account: rawAccountType, type, description }),
        date,
        name: null,
        merchant: description || type,
        amount: plaidAmount,
        currency,
        category: null,
        note: [type, description].filter(Boolean).join(" - ") || "Wealthsimple import",
        is_transfer: dailyTxIsTransfer(),
        pending: false,
        source: "wealthsimple",
        institution_name: `Wealthsimple ${rawAccountType || "Chequing"}`,
      });
      return;
    }

    if (!isStockAccount(account)) {
      skipped.push({ row: index + 2, reason: `non-stock account (${account})`, type, description });
      return;
    }

    if (kind === "buy" || kind === "sell") {
      const ticker = pick(row, ["symbol", "ticker", "security_symbol", "instrument_symbol"]);
      const qty = parseNumber(pick(row, ["quantity", "qty", "shares", "filled_quantity", "units"]));
      const price = parseNumber(pick(row, ["price", "unit_price", "average_price", "avg_price", "fill_price"]));
      const fees = parseNumber(pick(row, ["fees", "fee", "commission"])) ?? 0;
      if (!ticker || qty === null || price === null) {
        skipped.push({ row: index + 2, reason: "trade missing ticker/quantity/price", type, description });
        return;
      }
      // WS 的 effective_date 是下单时间;晚 8 点后挂的单会在"下一个交易日"成交(隔夜盘/开盘),
      // 描述里的 "executed at YYYY-MM-DD" 才是真正的成交日,日历/每日盈亏按成交日归属。
      // id 仍按 effective_date 算(保持稳定,不然老记录会变成重复的新行),只有 date 列用成交日;
      // ts 保留真实下单时间,FIFO 撮合按它排序(隔夜 20:02 的单确实排在次日盘中单之前)。
      const executedAt = description.match(/executed at (\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
      const trade = {
        id: stableId("ws_trade", { date, kind, ticker, qty, price, currency, account: rawAccount, type, description }),
        date: executedAt ?? date,
        ts,
        ticker: ticker.toUpperCase(),
        side: kind,
        qty: Math.abs(qty),
        price: Math.abs(price),
        currency,
        fees,
        account,
        realized_pnl: null,
        initial_stop: null,
        note: [type, description].filter(Boolean).join(" - ") || "Wealthsimple import",
      };
      trades.push(trade);
      return;
    }

    const amount = Math.abs(rawAmount);
    if (!amount) {
      skipped.push({ row: index + 2, reason: "cash row missing amount", type, description });
      return;
    }
    cash.push({
      id: stableId("ws_cash", { date, kind, amount, currency, account: rawAccount, type, description }),
      date,
      ts,
      type: kind === "cash_deposit" ? "deposit" : "withdraw",
      amount,
      currency,
      account,
      note: [type, description].filter(Boolean).join(" - ") || "Wealthsimple import",
    });
  });

  // 有几笔历史转账,老数据里只按"钱从哪个账户流出/流入"记了一侧(note 形如
  // "From: Non-registered (TFSA)"),WS 这份 CSV 是两个账户各记一条(一边 deposit 一边
  // withdraw)——这几笔的另一侧已经在旧数据里算过一次了,这里的这一侧是重复,再导入会把
  // 对应账户的现金凭空多算一遍。2026-09 排查时手动删过一次,这里记下 id 防止下次同步
  // (WS 导出是全量历史,同一笔老转账每次都会被解析出来)重新插回去。
  const KNOWN_DUPLICATE_CASH_IDS = new Set([
    "ws_cash_dc2da9abc78b06df31915511", // 2025-07-17 TFSA +2277.66 USD,对应 NON-REG 那一侧 withdraw 已经算过
    "ws_cash_23c65ae5df5a76f4c9df63a6", // 2026-02-25 TFSA +1451.98 USD,同上
    "ws_cash_58220b5f7670f6134618eb50", // 2026-03-26 TFSA +9.24 USD,同上
    "ws_cash_194fd2e8bfae384e8e358a94", // 2026-04-29 TFSA +1164.72 CAD,同上
    "ws_cash_32693383d7fff39d1deb4f28", // 2025-03-06 TFSA +3092.18 CAD,老数据里次日的 FX 转换 withdraw 已经把这笔钱算掉了
  ]);
  const dedupedCash = cash.filter((c) => !KNOWN_DUPLICATE_CASH_IDS.has(c.id));

  return { trades, cash: dedupedCash, dailyTx, skipped };
}

// 写库那一段在 supabase/functions/_shared/stockApply.mjs(edge function 也用);这里补上 env 里的 client / user。
export { describeDayDiff } from "../../supabase/functions/_shared/stockApply.mjs";

export function applyToSupabase(normalized, sourceFile, { source = "wealthsimple-csv" } = {}) {
  const userId = process.env.WEALTHSIMPLE_USER_ID;
  if (!userId) throw new Error("Missing WEALTHSIMPLE_USER_ID.");
  return applyRows(createServiceClient(), userId, normalized, sourceFile, { source, log: (m) => console.log(m) });
}


export function printBox(title, lines) {
  const width = Math.max(title.length, ...lines.map((l) => l.length), 40) + 4;
  const bar = "─".repeat(width);
  console.log(`┌${bar}┐`);
  console.log(`│ ${title.padEnd(width - 2)} │`);
  console.log(`├${bar}┤`);
  for (const line of lines) {
    console.log(`│ ${line.padEnd(width - 2)} │`);
  }
  console.log(`└${bar}┘`);
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  if (!args.file) throw new Error("Missing --file <wealthsimple.csv>.");
  const file = path.resolve(args.file);
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);

  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const objects = rowsToObjects(parseCsv(text));
  const normalized = normalizeRows(objects, { account: args.account });

  mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(args.out, `wealthsimple-normalized-${stamp}.json`);
  writeFileSync(outFile, `${JSON.stringify(normalized, null, 2)}\n`);

  printBox("正在同步 Wealthsimple 记录…", [
    `文件: ${path.basename(file)}`,
    `解析 CSV 行数: ${objects.length}`,
    `股票交易: ${normalized.trades.length}   现金出入金: ${normalized.cash.length}   日常记录(Chequing/储蓄): ${normalized.dailyTx.length}`,
    `跳过: ${normalized.skipped.length}`,
  ]);
  console.log(`归一化输出: ${outFile}`);

  if (normalized.skipped.length) {
    console.log("\n前几条被跳过的原始行:");
    console.log(JSON.stringify(normalized.skipped.slice(0, 8), null, 2));
  }

  if (!args.apply) {
    console.log("\n只是试跑,没有写数据库。确认没问题后加 --apply 重新运行。");
    return;
  }

  const result = await applyToSupabase(normalized, path.basename(file));

  const diffLines = [
    ...result.pnlDiff.added.map((d) => describeDayDiff("added", d)),
    ...result.pnlDiff.changed.map((d) => describeDayDiff("changed", d)),
    ...result.pnlDiff.removed.map((d) => describeDayDiff("removed", d)),
  ].sort();

  printBox("Wealthsimple 同步完成 ✓", [
    `新增交易 ${result.tradesInserted} 笔 / 更新 ${result.tradesUpdated} 笔`,
    `新增现金 ${result.cashInserted} 笔 / 更新 ${result.cashUpdated} 笔`,
    `新增日常记录 ${result.dailyInserted} 笔 / 更新 ${result.dailyUpdated} 笔`,
    "",
    `交易记录涉及日期(${result.touchedDates.length} 天):`,
    ...(result.touchedDates.length ? [result.touchedDates.join(", ")] : ["(无)"]),
    "",
    `日历变动(新增 ${result.pnlDiff.added.length} 天 / 修改 ${result.pnlDiff.changed.length} 天 / 消失 ${result.pnlDiff.removed.length} 天):`,
    ...(diffLines.length ? diffLines.slice(0, 40) : ["(无)"]),
    ...(diffLines.length > 40 ? [`… 还有 ${diffLines.length - 40} 条,见 import_logs.pnl_diff`] : []),
    "",
    ...(result.priceSync
      ? [
          `行情: 拉取 ${result.priceSync.fetched.length} 个标的 / ${result.priceSync.bars} 天, 收盘价截至 ${result.priceSync.lastClosed}`,
          ...(result.priceSync.notFound.length
            ? [`雅虎无数据: ${result.priceSync.notFound.map((n) => n.key + (n.open ? "(持有中)" : "")).join(", ")}`]
            : []),
          ...(result.priceSync.errors.length ? [`行情出错: ${result.priceSync.errors.map((e) => `${e.key}: ${e.error}`).join("; ")}`] : []),
          ...(result.priceSync.warnings.length ? [`需核对: ${result.priceSync.warnings.map((w) => `${w.key}: ${w.warning}`).join("; ")}`] : []),
        ]
      : [`⚠ ${result.priceWarning}`]),
  ]);
  console.log(`日志已写入 Supabase import_logs 表(user_id=${result.userId})。`);
}

// 被 scripts/snaptrade/ import 时不跑 CLI
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
