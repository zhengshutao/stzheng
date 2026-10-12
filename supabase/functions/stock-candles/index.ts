// K 线数据 edge function —— 给 /dashboard/chart 画蜡烛图用。
// 数据源和 stock-quotes 一样是雅虎财经公开 chart 接口(免 key);浏览器不能直接跨域调它,所以走这里转一手。
// 只做美股:symbol 原样传给雅虎。
// 单个:{symbol, period} → {symbol, name, previousClose, price, candles}
// 批量:{symbols: [...], period} → {results: {SYMBOL: 同上 | null}}(左侧列表迷你走势图用)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 前端的周期 → 雅虎的 interval + range。range 取够算 EMA50 预热、又不至于太大的长度。
// 分钟线/小时线带盘前盘后(includePrePost),日线/周线只要常规时段。
// spark:左侧列表的迷你走势图,只要最近一个交易日的常规时段 5 分钟线。
// 3m:雅虎没有 3 分钟 interval,拉 1 分钟线再按 3 分钟一桶合并(aggregate = 每桶秒数)。
const PERIODS: Record<string, { interval: string; range: string; prePost: boolean; aggregate?: number }> = {
  spark: { interval: "5m", range: "1d", prePost: false },
  "3m": { interval: "1m", range: "5d", prePost: true, aggregate: 180 },
  "5m": { interval: "5m", range: "5d", prePost: true },
  "15m": { interval: "15m", range: "1mo", prePost: true },
  "1h": { interval: "60m", range: "6mo", prePost: true },
  "1d": { interval: "1d", range: "2y", prePost: false },
  "1wk": { interval: "1wk", range: "10y", prePost: false },
};

interface Candle {
  t: number; // unix 秒(bar 开始时刻)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

type Result = { symbol: string; name: string | null; previousClose: number | null; price: number | null; candles: Candle[] };

const SYMBOL_RE = /^[A-Za-z.\-^=]{1,12}$/;

async function loadCandles(symbol: string, period: string): Promise<Result | { error: string; status: number }> {
  const cfg = PERIODS[period];
  if (!SYMBOL_RE.test(symbol) || !cfg) return { error: "bad symbol or period", status: 400 };
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}` +
    `?range=${cfg.range}&interval=${cfg.interval}&includePrePost=${cfg.prePost}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stzheng-dashboard/1.0)" },
  });
  if (!resp.ok) return { error: `yahoo ${resp.status}`, status: 502 };
  const body = await resp.json();
  const result = body?.chart?.result?.[0];
  if (!result) return { error: "no data", status: 404 };

  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    // 雅虎偶尔会给空 bar(停牌/无成交的分钟),整根跳过
    if ([o, h, l, c].some((x) => x === null || x === undefined || Number.isNaN(x))) continue;
    candles.push({ t: ts[i], o, h, l, c, v: q.volume?.[i] ?? 0 });
  }

  const meta = result.meta ?? {};
  return {
    symbol: meta.symbol ?? symbol.toUpperCase(),
    name: meta.longName ?? meta.shortName ?? null,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    price: meta.regularMarketPrice ?? null,
    candles: cfg.aggregate ? aggregateCandles(candles, cfg.aggregate) : candles,
  };
}

/** 小周期 bar 合并成 seconds 秒一根;按 unix 秒向下取整分桶(盘前 4:00、开盘 9:30 都是 3 分钟的整数倍)。 */
function aggregateCandles(candles: Candle[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const k of candles) {
    const t = Math.floor(k.t / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, k.h);
      last.l = Math.min(last.l, k.l);
      last.c = k.c;
      last.v += k.v;
    } else {
      out.push({ ...k, t });
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  try {
    const { symbol, symbols, period = "1d" } = await req.json();

    // 批量:左侧列表的迷你走势图,一次请求拿一整个列表
    if (Array.isArray(symbols)) {
      const list = [...new Set((symbols as unknown[]).filter((s): s is string => typeof s === "string"))].slice(0, 60);
      const loaded = await Promise.all(list.map((s) => loadCandles(s, period).catch((e) => ({ error: String(e), status: 500 }))));
      const results: Record<string, Result | null> = {};
      list.forEach((s, i) => (results[s] = "error" in loaded[i] ? null : (loaded[i] as Result)));
      return json({ results });
    }

    if (typeof symbol !== "string") return json({ error: "bad symbol or period" }, 400);
    const r = await loadCandles(symbol, period);
    return "error" in r ? json({ error: r.error }, r.status) : json(r);
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
});
