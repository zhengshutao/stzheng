// 实时报价 edge function —— 移植自 /Users/szheng/stock/server.py:
//   _cached_usd_quote / _cached_cad_quote / _cached_fx /
//   _us_extended_hours / _yf_extended_quote
//
// USD 报价用 Finnhub(key 存在 edge function secret,不进浏览器);
// CAD 报价 + FX + 盘前盘后覆盖用雅虎财经公开 chart 接口(和 yfinance 同源,免 key)。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Quote {
  c: number;
  o: number;
  pc: number | null;
}

// ---------- 雅虎财经公开 chart 接口 ----------

interface Bars {
  timestamps: number[];
  open: number[];
  close: number[];
}

async function fetchChart(
  symbol: string,
  range: string,
  interval: string,
  includePrePost = false
): Promise<Bars | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=${includePrePost}`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; stzheng-dashboard/1.0)" },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const timestamps: number[] = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const open: number[] = quote.open ?? [];
    const close: number[] = quote.close ?? [];
    if (timestamps.length === 0 || close.length === 0) return null;
    return { timestamps, open, close };
  } catch {
    return null;
  }
}

function lastValid(values: number[]): { value: number; index: number } | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined && !Number.isNaN(v)) return { value: v, index: i };
  }
  return null;
}

// ---------- FX ----------

async function getFx(): Promise<number | null> {
  const bars = await fetchChart("USDCAD=X", "5d", "1d");
  if (!bars) return null;
  const last = lastValid(bars.close);
  return last ? last.value : null;
}

// ---------- CAD 报价(先 .TO 再 .NE) ----------

async function getCadQuote(ticker: string): Promise<Quote | null> {
  for (const suffix of [".TO", ".NE"]) {
    const bars = await fetchChart(`${ticker}${suffix}`, "5d", "1d");
    if (!bars) continue;
    const lastClose = lastValid(bars.close);
    if (!lastClose) continue;
    const idx = lastClose.index;
    const prevClose = idx > 0 ? lastValid(bars.close.slice(0, idx)) : null;
    return {
      c: lastClose.value,
      o: bars.open[idx] ?? lastClose.value,
      pc: prevClose ? prevClose.value : null,
    };
  }
  return null;
}

// ---------- 美股盘前/盘后判断(美东时间) ----------

function usExtendedHours(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const mins = hour * 60 + minute;
  return (mins >= 240 && mins < 570) || (mins >= 960 && mins < 1200);
}

function todayEtDateString(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

/** 返回 [盘前盘后最新价, 上一个正常交易日收盘价] */
async function yfExtendedQuote(ticker: string): Promise<[number | null, number | null]> {
  const [intra, daily] = await Promise.all([
    fetchChart(ticker, "1d", "1m", true),
    fetchChart(ticker, "5d", "1d"),
  ]);
  const ext = intra ? lastValid(intra.close)?.value ?? null : null;
  let prevClose: number | null = null;
  if (daily) {
    const todayEt = todayEtDateString();
    for (let i = daily.timestamps.length - 1; i >= 0; i--) {
      const barDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
        new Date(daily.timestamps[i] * 1000)
      );
      if (barDate < todayEt) {
        const v = daily.close[i];
        if (v !== null && v !== undefined && !Number.isNaN(v)) {
          prevClose = v;
          break;
        }
      }
    }
  }
  return [ext, prevClose];
}

// ---------- USD 报价(Finnhub + 盘前盘后覆盖) ----------

async function getUsdQuote(ticker: string, finnhubKey: string): Promise<Quote | null> {
  let result: Quote | null = null;
  if (finnhubKey) {
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${finnhubKey}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const d = await resp.json();
        if (d && Number(d.c) > 0) {
          result = { c: Number(d.c), o: Number(d.o ?? 0), pc: d.pc ? Number(d.pc) : null };
        }
      }
    } catch {
      // ignore, fall through to extended-hours-only result below
    }
  }
  if (usExtendedHours()) {
    const [ext, prevPc] = await yfExtendedQuote(ticker);
    if (ext !== null || prevPc !== null) {
      if (result === null) {
        result = { c: ext ?? prevPc ?? 0, o: ext ?? prevPc ?? 0, pc: prevPc };
      } else {
        if (ext !== null) result.c = ext;
        if (prevPc !== null) result.pc = prevPc;
      }
    }
  }
  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  try {
    const { usdTickers = [], cadTickers = [] } = await req.json();
    const finnhubKey = Deno.env.get("FINNHUB_API_KEY") ?? "";

    const [usdResults, cadResults, fx] = await Promise.all([
      Promise.all((usdTickers as string[]).map((t) => getUsdQuote(t, finnhubKey))),
      Promise.all((cadTickers as string[]).map((t) => getCadQuote(t))),
      getFx(),
    ]);

    const usd: Record<string, Quote | null> = {};
    (usdTickers as string[]).forEach((t, i) => (usd[t] = usdResults[i]));
    const cad: Record<string, Quote | null> = {};
    (cadTickers as string[]).forEach((t, i) => (cad[t] = cadResults[i]));

    return new Response(JSON.stringify({ fx, usd, cad }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
