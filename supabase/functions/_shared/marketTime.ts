// 交易日边界(美东时间)。
//
// 日历/每日盈亏里"某一天"指的是美东交易日:一笔成交归属哪天,以券商标注的执行日为准
// (WS 导出的 "executed at YYYY-MM-DD",导入脚本已经写进 stock_trades.date)。
// 手动录入的成交没有券商标注,按美东时间推:晚 8 点之后的隔夜盘(overnight session,
// 20:00 → 次日 04:00)按惯例属于下一个交易日,其余按当天。

function etParts(d: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function addDaysStr(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 今天的美东日期(YYYY-MM-DD)——日历上"今天"这一格、实时价适用的那一天。 */
export function etToday(now: Date = new Date()): string {
  return etParts(now).date;
}

/** 一个时刻应归属的交易日:美东 20:00 之后算下一天(隔夜盘),其余算当天。 */
export function sessionDateOf(when: Date): string {
  const { date, minutes } = etParts(when);
  return minutes >= 20 * 60 ? addDaysStr(date, 1) : date;
}

/** 美东当天常规交易已收盘(≥ 16:10,给数据源一点结算时间)。周末按"已收盘"处理。 */
export function etMarketClosedToday(now: Date = new Date()): boolean {
  return etParts(now).minutes >= 16 * 60 + 10;
}

/** 最近一个已经完整收盘的美东日期:收盘后是今天,否则是前一天;落在周末就退回周五
 *  (假日不考虑,调用方用"是否有K线"判断)。 */
export function lastClosedEtDate(now: Date = new Date()): string {
  const { date } = etParts(now);
  let d = etMarketClosedToday(now) ? date : addDaysStr(date, -1);
  for (let dow = new Date(`${d}T00:00:00Z`).getUTCDay(); dow === 0 || dow === 6; dow = new Date(`${d}T00:00:00Z`).getUTCDay()) {
    d = addDaysStr(d, -1);
  }
  return d;
}
