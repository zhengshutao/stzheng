// 美股交易日边界(9:30 ET 开盘),而不是本地/UTC 午夜——
// 00:00–09:30 ET 期间仍算作上一个交易日,避免收盘后到开盘前这段时间里,
// 日历日期已经跨天、却把睡前刚买的仓位错当成隔夜持仓来算。

function etMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function marketSessionDate(): string {
  const now = new Date();
  const etDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  if (etMinutesOfDay(now) >= 570) return etDateStr; // >= 9:30 ET,新交易日已开始
  const d = new Date(`${etDateStr}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return new Intl.DateTimeFormat("en-CA").format(d);
}

// 00:00–09:30 ET 这段窗口里,"今日盈亏"展示的其实是上一个交易日的结果,标题该叫"昨日盈亏"。
export function isPreMarketLabelWindow(): boolean {
  return etMinutesOfDay(new Date()) < 570;
}
