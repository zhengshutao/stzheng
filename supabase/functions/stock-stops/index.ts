// 动量止损 edge function —— 移植自 /Users/szheng/stock/stops.py 的完整算法
// (10EMA/20EMA 自动选线 + ATR 缓冲 + 趋势质量判定 + 止损棘轮),
// 历史K线取自雅虎财经公开 chart 接口(和 yfinance 同源,免 key)。
//
// 止损棘轮状态原来存在本地 .stop_ratchet.json,这里改存 Supabase
// `stock_stop_ratchet` 表,用调用者的 JWT 透传,读写走 RLS(auth.uid()=user_id)。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ATR_MULT = 1.5; // 突破止损上限: 今日开盘 - ATR_MULT*ATR14

// ---------- 雅虎财经公开 chart 接口 ----------

interface Bars {
  timestamps: number[];
  open: number[];
  high: number[];
  low: number[];
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
    const high: number[] = quote.high ?? [];
    const low: number[] = quote.low ?? [];
    const close: number[] = quote.close ?? [];
    if (timestamps.length === 0 || close.length === 0) return null;
    return { timestamps, open, high, low, close };
  } catch {
    return null;
  }
}

function lastValid(values: number[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined && !Number.isNaN(v)) return v;
  }
  return null;
}

// ---------- 指标算法(逐行对应 stops.py) ----------

function wilderAtr(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  const n = closes.length;
  if (n < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = seed;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + (out[i - 1] as number) * (1 - k);
  }
  return out;
}

function countClosesBelowRange(closes: number[], lineSeries: (number | null)[], startIdx: number): number {
  let cnt = 0;
  for (let i = startIdx; i < closes.length; i++) {
    const l = lineSeries[i];
    if (l !== null && closes[i] < l) cnt++;
  }
  return cnt;
}

function findTrendStart(ema10Series: (number | null)[], ema20Series: (number | null)[]): number | null {
  const n = ema10Series.length;
  if (n < 2) return null;
  const e10now = ema10Series[n - 1], e20now = ema20Series[n - 1];
  if (e10now === null || e20now === null || e10now < e20now) return null;
  for (let i = n - 1; i > 0; i--) {
    const a = ema10Series[i - 1], b = ema20Series[i - 1];
    const c = ema10Series[i], d = ema20Series[i];
    if (a === null || b === null || c === null || d === null) continue;
    if (a < b && c >= d) return i;
  }
  for (let i = 0; i < n; i++) {
    if (ema10Series[i] !== null && ema20Series[i] !== null) return i;
  }
  return null;
}

function findLegRestart(closes: number[], trendStartIdx: number | null): number | null {
  if (trendStartIdx === null) return null;
  const n = closes.length;
  const threshold = 1.07;
  let bestIdx: number | null = null;
  const start = Math.max(trendStartIdx + 1, 10);
  for (let i = start; i < n; i++) {
    if (closes[i] <= closes[i - 1] * threshold) continue;
    const recentMax = Math.max(...closes.slice(Math.max(0, i - 10), i + 1));
    if (closes[i] >= recentMax - 1e-6) bestIdx = i;
  }
  if (bestIdx === null) return null;
  if (n - bestIdx < 5) return null;
  return bestIdx;
}

function pickLineAndQuality(
  breaks10: number,
  breaks20: number,
  trendDays: number,
  inUptrend: boolean
): [string, string] {
  if (!inUptrend) return ["20EMA", "broken"];
  if (trendDays < 5) return ["20EMA", "new"];
  const rate10 = breaks10 / trendDays;
  const rate20 = breaks20 / trendDays;
  if (rate20 > 0.25 && breaks20 >= 3) return ["20EMA", "broken"];
  if (rate10 >= 0.15 && breaks10 >= 2) return ["20EMA", "ok"];
  return ["10EMA", "clean"];
}

function pickBuffer(atrPct: number): number {
  if (atrPct > 8) return 0.97;
  if (atrPct > 5) return 0.98;
  return 0.99;
}

function pct(stop: number | null, current: number): number | null {
  if (stop === null || !current) return null;
  return ((stop - current) / current) * 100;
}

function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

interface StopsResult {
  ticker: string;
  error?: string;
  current?: number;
  open?: number;
  atr14?: number | null;
  atr_pct?: number;
  ema10?: number | null;
  ema20?: number | null;
  breaks_10?: number;
  breaks_20?: number;
  trend_days?: number;
  in_uptrend?: boolean;
  leg_restarted?: boolean;
  chosen_line?: string;
  chosen_line_value?: number | null;
  buffer?: number;
  trend_quality?: string;
  stop_basis?: string;
  stop_mom?: number | null;
  stop_mom_pct?: number | null;
  stop_mom_raw?: number | null;
  ratcheted?: boolean;
}

async function computeStopsRaw(ticker: string): Promise<StopsResult> {
  const bars = await fetchChart(ticker, "4mo", "1d");
  if (!bars || bars.close.length < 21) return { ticker, error: "no data" };

  const highs = bars.high, lows = bars.low, closes = bars.close, opens = bars.open;
  let current = closes[closes.length - 1];
  try {
    const intra = await fetchChart(ticker, "1d", "1m", true);
    if (intra) {
      const v = lastValid(intra.close);
      if (v !== null) current = v;
    }
  } catch {
    // keep daily close
  }
  const todayOpen = opens[opens.length - 1];
  const atr14 = wilderAtr(highs, lows, closes, 14);
  const ema10 = ema(closes, 10);
  const ema20 = ema(closes, 20);
  const ema10Series = emaSeries(closes, 10);
  const ema20Series = emaSeries(closes, 20);

  const trendStart = findTrendStart(ema10Series, ema20Series);
  const inUptrend = trendStart !== null;
  const legRestart = inUptrend ? findLegRestart(closes, trendStart) : null;
  const measureStart = legRestart !== null ? legRestart : trendStart;

  let trendDays = 0, breaks10 = 0, breaks20 = 0;
  if (inUptrend && measureStart !== null) {
    trendDays = closes.length - measureStart;
    breaks10 = countClosesBelowRange(closes, ema10Series, measureStart);
    breaks20 = countClosesBelowRange(closes, ema20Series, measureStart);
  }

  const atrPct = atr14 !== null && current ? (atr14 / current) * 100 : 0;

  let [chosenLine, trendQuality] = pickLineAndQuality(breaks10, breaks20, trendDays, inUptrend);
  const lineMap: Record<string, number | null> = { "10EMA": ema10, "20EMA": ema20 };
  let chosenValue = lineMap[chosenLine];
  if (chosenValue === null || chosenValue === undefined) {
    chosenLine = "20EMA";
    chosenValue = ema20;
    trendQuality = "new";
  }

  const buffer = pickBuffer(atrPct);
  let stopMom = chosenValue !== null ? chosenValue * buffer : null;

  const stopBreakout = atr14 !== null ? todayOpen - ATR_MULT * atr14 : null;
  let stopBasis = chosenLine;
  if (stopMom !== null && stopBreakout !== null && stopBreakout > stopMom) {
    stopMom = stopBreakout;
    stopBasis = `${ATR_MULT}ATR`;
  }
  const stopMomRaw = stopMom;

  return {
    ticker,
    current: round2(current) as number,
    open: round2(todayOpen) as number,
    atr14: round2(atr14),
    atr_pct: round2(atrPct) as number,
    ema10: round2(ema10),
    ema20: round2(ema20),
    breaks_10: breaks10,
    breaks_20: breaks20,
    trend_days: trendDays,
    in_uptrend: inUptrend,
    leg_restarted: legRestart !== null,
    chosen_line: chosenLine,
    chosen_line_value: round2(chosenValue),
    buffer,
    trend_quality: trendQuality,
    stop_basis: stopBasis,
    stop_mom: round2(stopMom),
    stop_mom_pct: round2(pct(stopMom, current)),
    stop_mom_raw: round2(stopMomRaw),
    ratcheted: false, // 由棘轮逻辑决定,见下方
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    // 只给本人用(和 snaptrade-* 一样);匿名 key 或别人注册的号都拒掉
    const ownerId = Deno.env.get("PORTFOLIO_OWNER_USER_ID");
    if (!ownerId) return new Response(JSON.stringify({ error: "server not configured" }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    const { data: userData } = await supabase.auth.getUser();
    if (userData.user?.id !== ownerId) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { positions = [] } = await req.json() as {
      positions: { ticker: string; anchor: string | null; initial_floor: number | null }[];
    };

    const results = await Promise.all(
      positions.map(async (p) => {
        const raw = await computeStopsRaw(p.ticker);
        if (raw.error || raw.stop_mom === null || raw.stop_mom === undefined || !p.anchor) {
          return raw;
        }

        // ---------- 止损棘轮(对应 stops.py: _ratchet_stop) ----------
        const today = new Date().toISOString().slice(0, 10);
        const floor = p.initial_floor ?? 0;
        const { data: existing } = await supabase
          .from("stock_stop_ratchet")
          .select("anchor, stop")
          .eq("ticker", p.ticker)
          .maybeSingle();

        let effective: number;
        let rose: boolean;
        if (existing && existing.anchor === p.anchor) {
          const stored = Number(existing.stop);
          effective = Math.max(raw.stop_mom, stored, floor);
          rose = effective > stored + 1e-9;
          if (rose) {
            await supabase
              .from("stock_stop_ratchet")
              .update({ stop: effective, updated_at: today })
              .eq("ticker", p.ticker);
          } else {
            effective = stored;
          }
        } else {
          effective = Math.max(raw.stop_mom, floor);
          rose = true;
          await supabase.from("stock_stop_ratchet").upsert({
            ticker: p.ticker,
            anchor: p.anchor,
            stop: effective,
            initial_floor: floor || null,
            since: today,
            updated_at: today,
          });
        }

        return {
          ...raw,
          stop_mom: round2(effective),
          stop_mom_pct: round2(pct(effective, raw.current!)),
          ratcheted: effective > (raw.stop_mom_raw ?? -Infinity) + 1e-9,
        };
      })
    );

    const byTicker: Record<string, StopsResult> = {};
    positions.forEach((p, i) => (byTicker[p.ticker] = results[i]));

    return new Response(JSON.stringify(byTicker), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
