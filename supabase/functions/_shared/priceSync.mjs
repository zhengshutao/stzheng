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
//
// 这个文件是库(本地脚本 scripts/prices/sync-prices.mjs 和 edge function snaptrade-sync 共用),不读环境变量、不碰文件。

import { addDays, priceKey, priceRangesNeeded } from "./dailyPnl.ts";
import { FX_CURRENCY, FX_TICKER, FX_YAHOO_SYMBOL, yahooCandidates } from "./instruments.ts";
import { etToday, lastClosedEtDate } from "./marketTime.ts";
import { fetchAllRows, isMissingTableError } from "./stockDb.mjs";

const CONCURRENCY = 4;
const YAHOO_UA = "Mozilla/5.0 (compatible; stzheng-dashboard/1.0)";

// ---------- 雅虎 chart ----------

function epoch(date) {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}

function barDate(ts, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ts * 1000)
  );
}

/**
 * 拉一段日K。返回 { ok:true, meta, bars:[{date, close}] } / { ok:false, notFound:true } / 抛网络错误。
 * bars 只保留 date ≤ lastClosed 的(今天还没收盘就不要今天的那根)。
 */
export async function fetchYahooDaily(symbol, from, to, lastClosed) {
  // period2 永远取到现在而不是 to:雅虎只返回请求区间内的拆股事件,而"还原回原始价"需要知道
  // 区间之后发生过的拆股(比如清仓之后才发生的合股),否则清仓前的价格会被整体缩放。
  // 多下载的那段 K 线在下面按 to 过滤掉,不入库。
  const nowDate = new Date().toISOString().slice(0, 10);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${epoch(from)}&period2=${epoch(addDays(nowDate, 2))}&interval=1d&includePrePost=false&events=splits`;
  const resp = await fetch(url, { headers: { "User-Agent": YAHOO_UA }, signal: AbortSignal.timeout(20000) });
  let json = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }
  const result = json?.chart?.result?.[0];
  if (!result) {
    const code = json?.chart?.error?.code ?? "";
    if (resp.status === 404 || /not found/i.test(code)) return { ok: false, notFound: true, error: json?.chart?.error?.description ?? "not found" };
    throw new Error(`yahoo ${symbol} HTTP ${resp.status} ${json?.chart?.error?.description ?? ""}`.trim());
  }
  const tz = result.meta?.exchangeTimezoneName;
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  // 拆股事件:{date: 生效日, ratio: 新股数/旧股数}。雅虎"通常"会把生效日之前的价格除以 ratio,
  // 但不是每只票都做了(实测 IESC 2026-08 的 2:1 拆股事件有、价格却没回调)。
  // 所以这里只原样返回"雅虎给的价 + 事件",由 calibrateBars() 拿用户自己的成交价来判断到底要不要乘回去。
  const splits = Object.values(result.events?.splits ?? {})
    .map((ev) => ({
      date: barDate(Number(ev.date), tz),
      ratio: Number(ev.numerator) / Number(ev.denominator),
    }))
    .filter((ev) => Number.isFinite(ev.ratio) && ev.ratio > 0 && Math.abs(ev.ratio - 1) > 1e-9)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const bars = [];
  const seen = new Set();
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined || !Number.isFinite(close) || close <= 0) continue;
    const date = barDate(timestamps[i], tz);
    if (date > lastClosed || date > to || date < from) continue;
    if (seen.has(date)) continue; // 同一天出现两根(极少见)只取第一根
    seen.add(date);
    bars.push({ date, close });
  }
  // 收盘后的头几个小时,雅虎当天那根日 K 的 close 常常还是 null,但 meta.regularMarketPrice 已经是
  // 常规时段的正式收盘价(regularMarketTime == 当天 regular.end)。只在这种"已收盘"情况下用它补当天的收盘价;
  // 盘中 regularMarketTime < regular.end,不会误把实时价当收盘价存进去。
  const meta = result.meta ?? {};
  const rmTime = Number(meta.regularMarketTime);
  const regularEnd = Number(meta.currentTradingPeriod?.regular?.end);
  if (Number.isFinite(rmTime) && Number.isFinite(regularEnd) && rmTime >= regularEnd) {
    const rmDate = barDate(rmTime, tz);
    const px = Number(meta.regularMarketPrice);
    if (rmDate === lastClosed && rmDate <= to && rmDate >= from && !seen.has(rmDate) && Number.isFinite(px) && px > 0) {
      bars.push({ date: rmDate, close: px });
    }
  }
  bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { ok: true, meta, bars, splits };
}

/**
 * 用用户自己的成交价校准拆股回调:
 * 对每个拆股事件决定"要不要把事件之前的价格乘回 ratio"。枚举所有事件的开/关组合(事件很少,最多 5 个),
 * 选让"成交当天的收盘价 / 成交价"最接近 1 的那个组合。没有成交可对照时,按雅虎惯例全部乘回。
 * 返回原始口径的 bars、每个事件是否应用、以及校准后仍对不上时的警告。
 */
export function calibrateBars(bars, splits, fills, priceScale = 1) {
  const events = splits.slice(0, 5);
  const factorFor = (date, mask) => {
    let f = 1;
    events.forEach((ev, i) => {
      if (mask & (1 << i) && ev.date > date) f *= ev.ratio;
    });
    return f;
  };
  const byDate = new Map(bars.map((b) => [b.date, b.close]));
  const samples = [];
  for (const t of fills) {
    const close = byDate.get(t.date);
    if (close && t.price > 0) samples.push({ date: t.date, close: close * priceScale, price: t.price });
  }
  const median = (arr) => {
    const a = [...arr].sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : null;
  };
  const errorFor = (mask) => median(samples.map((s) => Math.abs(Math.log((s.close * factorFor(s.date, mask)) / s.price))));

  let mask = (1 << events.length) - 1; // 默认:雅虎惯例,全部乘回
  let warning = null;
  if (samples.length && events.length) {
    let best = mask;
    let bestErr = errorFor(mask);
    for (let m = 0; m < 1 << events.length; m++) {
      const err = errorFor(m);
      if (err < bestErr - 1e-9) {
        best = m;
        bestErr = err;
      }
    }
    mask = best;
    if (bestErr > 0.35) warning = `收盘价和成交价对不上(中位偏差 ${(Math.exp(bestErr) * 100 - 100).toFixed(0)}%),请核对拆股/成交记录`;
  } else if (samples.length && !events.length) {
    const err = errorFor(0);
    if (err > 0.35) warning = `收盘价和成交价对不上(中位偏差 ${(Math.exp(err) * 100 - 100).toFixed(0)}%),雅虎可能漏了拆股事件`;
  }
  const applied = events.map((ev, i) => ({ ...ev, applied: Boolean(mask & (1 << i)) }));
  const out = bars.map((b) => ({ date: b.date, close: b.close * priceScale * factorFor(b.date, mask) }));
  return { bars: out, splits: applied, warning, samples: samples.length };
}

/** 按候选顺序找到雅虎有数据的代码。CAD 标的要求雅虎标的币种也是 CAD。 */
async function resolveAndFetch(ticker, currency, from, to, lastClosed, knownSymbol, knownScale) {
  const candidates = knownSymbol ? [{ symbol: knownSymbol, priceScale: knownScale ?? 1 }] : yahooCandidates(ticker, currency);
  let lastNotFound = null;
  for (const cand of candidates) {
    const r = await fetchYahooDaily(cand.symbol, from, to, lastClosed);
    if (!r.ok) {
      lastNotFound = r;
      continue;
    }
    if (currency === "CAD" && r.meta.currency && String(r.meta.currency).toUpperCase() !== "CAD") continue;
    return { ...r, symbol: cand.symbol, priceScale: cand.priceScale };
  }
  return { ok: false, notFound: true, error: lastNotFound?.error ?? "no candidate matched" };
}

// ---------- 主流程 ----------

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 同步一个用户需要的全部收盘价。
 * @returns {{ today, lastClosed, fetched: [], skipped: number, notFound: [], errors: [], bars: number, missingTable?: boolean }}
 */
export async function syncPrices({ client, userId, log = () => {}, refetch = [], all = false, noDb = false, now = new Date() }) {
  const today = etToday(now);
  const lastClosed = lastClosedEtDate(now);
  const [trades, splits] = await Promise.all([
    fetchAllRows(client, "stock_trades", "date,ts,ticker,side,qty,price,currency,fees,account", (q) => q.eq("user_id", userId), ["date", "ts"]),
    fetchAllRows(client, "stock_splits", "date,ts,ticker,currency,account,ratio", (q) => q.eq("user_id", userId), ["date", "ts"]),
  ]);

  const ranges = priceRangesNeeded(trades, splits, today);
  const fillsByPk = new Map();
  for (const t of trades) {
    const pk = priceKey(t.ticker, t.currency);
    if (!fillsByPk.has(pk)) fillsByPk.set(pk, []);
    fillsByPk.get(pk).push({ date: t.date, price: Number(t.price) });
  }
  // 汇率:从最早的成交一路到今天(展示用的是最新一天,但历史一起存着以后想看也有)
  let earliest = today;
  for (const r of ranges.values()) if (r.from < earliest) earliest = r.from;
  ranges.set(priceKey(FX_TICKER, FX_CURRENCY), {
    ticker: FX_TICKER,
    currency: FX_CURRENCY,
    from: earliest,
    to: today,
    open: true,
    splitCount: 0,
  });

  let symbols = new Map();
  if (!noDb) {
    const { data, error } = await client.from("stock_price_symbols").select("*");
    if (error) {
      if (isMissingTableError(error)) return { today, lastClosed, missingTable: true, fetched: [], skipped: 0, notFound: [], errors: [], bars: 0 };
      throw new Error(`stock_price_symbols fetch failed: ${error.message}`);
    }
    symbols = new Map(data.map((s) => [priceKey(s.ticker, s.currency), s]));
  }

  const refetchSet = new Set(refetch.map((k) => k.toUpperCase()));
  const jobs = [];
  let skipped = 0;
  for (const [pk, range] of ranges) {
    const sym = symbols.get(pk);
    const target = range.to < lastClosed ? range.to : lastClosed; // 这只票需要同步到的最后一天
    const force = all || refetchSet.has(pk);
    if (!force && sym && sym.through_date && sym.through_date >= target) {
      skipped++;
      continue;
    }
    const incremental = !force && sym && sym.symbol && sym.through_date;
    jobs.push({
      pk,
      range,
      target,
      force: Boolean(force),
      from: incremental ? addDays(sym.through_date, -5) : range.from,
      knownSymbol: incremental ? sym.symbol : null,
      knownScale: incremental ? Number(sym.price_scale ?? 1) : null,
    });
  }
  log(`需要同步 ${jobs.length} 个标的(跳过 ${skipped} 个已是最新),收盘价截至 ${lastClosed}`);

  const fetched = [];
  const notFound = [];
  const errors = [];
  const warnings = [];
  let totalBars = 0;
  const allBarsForOut = [];

  await mapLimit(jobs, CONCURRENCY, async (job) => {
    const { pk, range, target } = job;
    const isFx = pk === priceKey(FX_TICKER, FX_CURRENCY);
    let r;
    try {
      r = isFx
        ? { ...(await fetchYahooDaily(FX_YAHOO_SYMBOL, job.from, target, lastClosed)), symbol: FX_YAHOO_SYMBOL, priceScale: 1 }
        : await resolveAndFetch(range.ticker, range.currency, job.from, target, lastClosed, job.knownSymbol, job.knownScale);
    } catch (e) {
      errors.push({ key: pk, error: String(e?.message ?? e) });
      log(`  ✗ ${pk}: ${String(e?.message ?? e)}`);
      if (!noDb) {
        await client.from("stock_price_symbols").upsert(
          { ticker: range.ticker, currency: range.currency, status: "error", last_error: String(e?.message ?? e).slice(0, 300), split_count: range.splitCount, updated_at: new Date().toISOString() },
          { onConflict: "ticker,currency" }
        );
      }
      return;
    }
    if (!r.ok) {
      notFound.push({ key: pk, open: range.open, error: r.error });
      log(`  – ${pk}: 雅虎没有数据(${r.error})${range.open ? ",还持有,明天再试" : ""}`);
      if (!noDb) {
        await client.from("stock_price_symbols").upsert(
          {
            ticker: range.ticker,
            currency: range.currency,
            symbol: null,
            status: "not_found",
            last_error: String(r.error).slice(0, 300),
            through_date: target,
            split_count: range.splitCount,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "ticker,currency" }
        );
      }
      return;
    }
    const cal = isFx ? { bars: r.bars, splits: [], warning: null } : calibrateBars(r.bars, r.splits ?? [], fillsByPk.get(pk) ?? [], r.priceScale);
    if (cal.warning) {
      log(`  ⚠ ${pk}: ${cal.warning}`);
      warnings.push({ key: pk, warning: cal.warning });
    }
    const rows = cal.bars.map((b) => ({
      ticker: range.ticker,
      currency: range.currency,
      date: b.date,
      close: Math.round(b.close * 10000) / 10000,
      symbol: r.symbol,
      fetched_at: new Date().toISOString(),
    }));
    totalBars += rows.length;
    allBarsForOut.push(...rows);
    // through_date 记"真正拿到的最后一根 K 线",而不是想同步到的那天:雅虎收盘后几小时内当天可能还没数据,
    // 记成 target 的话下次就会当成"已是最新"跳过,今天的收盘价永远补不上。已清仓的票不会再变,直接记 target 不再重试。
    const lastBar = cal.bars.at(-1)?.date;
    const through = !range.open || !lastBar || lastBar >= target ? target : lastBar;
    if (!noDb) {
      if (job.force) {
        const { error: delErr } = await client.from("stock_prices").delete().eq("ticker", range.ticker).eq("currency", range.currency);
        if (delErr) throw new Error(`stock_prices delete failed: ${delErr.message}`);
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await client.from("stock_prices").upsert(rows.slice(i, i + 500), { onConflict: "ticker,currency,date" });
        if (error) throw new Error(`stock_prices upsert failed: ${error.message}`);
      }
      const { error: symErr } = await client.from("stock_price_symbols").upsert(
        {
          ticker: range.ticker,
          currency: range.currency,
          symbol: r.symbol,
          price_scale: r.priceScale,
          through_date: through,
          split_count: range.splitCount,
          status: "ok",
          last_error: cal.warning,
          yahoo_splits: cal.splits,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "ticker,currency" }
      );
      if (symErr) throw new Error(`stock_price_symbols upsert failed: ${symErr.message}`);
    }
    const last = rows[rows.length - 1];
    fetched.push({ key: pk, symbol: r.symbol, bars: rows.length, from: rows[0]?.date ?? null, to: last?.date ?? null, yahooSplits: cal.splits });
    const splitNote = cal.splits.length
      ? `,拆股 ${cal.splits.map((x) => `${x.date} ×${x.ratio}${x.applied ? "" : "(雅虎未回调,按原价)"}`).join(" ")}`
      : "";
    log(`  ✓ ${pk} ← ${r.symbol}: ${rows.length} 天${last ? `(至 ${last.date} 收 ${last.close})` : ""}${splitNote}`);
  });

  return { today, lastClosed, fetched, skipped, notFound, errors, warnings, bars: totalBars, rows: noDb ? allBarsForOut : undefined };
}

/** 把 stock_prices 整表读成引擎要的 PriceSeries(Map<ticker|ccy, [{date, close}]>)。 */
export async function loadPriceSeries(client) {
  const rows = await fetchAllRows(client, "stock_prices", "ticker,currency,date,close", (q) => q, ["ticker", "currency", "date"]);
  return priceSeriesFromRows(rows);
}

export function priceSeriesFromRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const pk = priceKey(r.ticker, r.currency);
    let arr = map.get(pk);
    if (!arr) {
      arr = [];
      map.set(pk, arr);
    }
    arr.push({ date: r.date, close: Number(r.close) });
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return map;
}
