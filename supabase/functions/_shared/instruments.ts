// 标的识别工具 —— 纯函数、零依赖,前端(Vite)/Node 脚本(type stripping)都直接 import 这个文件。
//
// 三种 ticker 形态:
//   1. 普通股票/ETF:  "NBIS"、"XSP"、"HUT.TO"(CAD 标的可能自带交易所后缀)
//   2. WS 导出的期权(OCC 代码,标的和日期之间是两个空格): "TSLA  260706C00405000"
//      —— WS 的 unit_price 已经是"每张合约"的总价(455 = 4.55 × 100),所以乘数是 1。
//   3. 手输的期权(自由文本): "TSLA Jul 27 $410 Call"
//      —— 价格按"每股"权利金记,一张合约 100 股,乘数是 100。

/** 手输期权:标的 + 到期月日 + 行权价 + 方向(没有年份,年份按"离现在最近的未来同月日"推)。 */
export const FREE_TEXT_OPTION_RE =
  /^([A-Za-z.]{1,6})\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+\$(\d+(?:\.\d+)?)\s+(Call|Put)$/i;

/** OCC 期权代码:标的(1-6 位) + 空格若干 + YYMMDD + C/P + 行权价×1000(8 位)。 */
export const OCC_OPTION_RE = /^([A-Za-z.]{1,6})\s+(\d{6})([CP])(\d{8})$/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function isFreeTextOption(ticker: string): boolean {
  return FREE_TEXT_OPTION_RE.test(ticker.trim());
}

export function isOccOption(ticker: string): boolean {
  return OCC_OPTION_RE.test(ticker.trim());
}

/**
 * 成交价 → 实际金额的乘数。
 * 手输期权按"每股"报价所以 ×100;OCC 期权(WS 导入)价格已经是每张合约总价,×1;股票 ×1。
 */
export function contractMultiplier(ticker: string): number {
  return isFreeTextOption(ticker) ? 100 : 1;
}

/** 手输期权 → OCC 代码(如 TSLA260727C00410000)。年份取离 now 最近的未来同月日。 */
export function freeTextOptionToOcc(ticker: string, now: Date = new Date()): string | null {
  const m = ticker.trim().match(FREE_TEXT_OPTION_RE);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[3]);
  let target = new Date(Date.UTC(now.getUTCFullYear(), month, day));
  const threeDaysAgo = new Date(now.getTime() - 3 * 86400000);
  if (target < threeDaysAgo) target = new Date(Date.UTC(now.getUTCFullYear() + 1, month, day));
  const yy = String(target.getUTCFullYear()).slice(-2);
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(target.getUTCDate()).padStart(2, "0");
  const right = m[5].toLowerCase() === "call" ? "C" : "P";
  const strike = String(Math.round(Number(m[4]) * 1000)).padStart(8, "0");
  return `${m[1].toUpperCase()}${yy}${mm}${dd}${right}${strike}`;
}

export interface YahooCandidate {
  symbol: string;
  /** 雅虎返回的收盘价要乘这个数才和交易记录里的 price 同单位(OCC 期权:每股 → 每张合约 ×100)。 */
  priceScale: number;
}

/**
 * 按 ticker+币种给出雅虎财经的候选代码(按优先级)。调用方逐个尝试,第一个有数据的就用。
 *   USD 股票:原样;OCC 期权:去掉空格;手输期权:转 OCC。
 *   CAD 标的:自带后缀的原样;否则先 .TO(多伦多,含大部分 CDR)再 .NE(Cboe Canada)。
 */
export function yahooCandidates(ticker: string, currency: string): YahooCandidate[] {
  const t = ticker.trim().toUpperCase();
  const occ = t.match(OCC_OPTION_RE);
  if (occ) return [{ symbol: `${occ[1]}${occ[2]}${occ[3].toUpperCase()}${occ[4]}`, priceScale: 100 }];
  const free = freeTextOptionToOcc(ticker);
  if (free) return [{ symbol: free, priceScale: 1 }];
  if (currency.toUpperCase() === "CAD") {
    if (t.includes(".")) return [{ symbol: t, priceScale: 1 }];
    return [
      { symbol: `${t}.TO`, priceScale: 1 },
      { symbol: `${t}.NE`, priceScale: 1 },
    ];
  }
  return [{ symbol: t, priceScale: 1 }];
}

/** 汇率在 stock_prices 里当成一个特殊标的存:ticker=USDCAD, currency=FX。 */
export const FX_TICKER = "USDCAD";
export const FX_CURRENCY = "FX";
export const FX_YAHOO_SYMBOL = "USDCAD=X";
