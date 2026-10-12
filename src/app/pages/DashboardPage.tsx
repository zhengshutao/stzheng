import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw, TrendingUp, Wallet } from "lucide-react";
import DashboardNavbar from "./DashboardNavbar";
import {
  aggregateByDay,
  buildDailyPnl,
  computeTotals,
  dayNet,
  fetchDashboardData,
  fmtCad,
  latestFx,
  priceCoverage,
  toDisplayCcy,
  type DashboardData,
  type DayPnl,
  type ImportLog,
  type LiveMarks,
  type PnlDiffDay,
  type Scope,
} from "@/app/lib/dashboardData";
import { computePositions } from "@/app/lib/stockPositions";
import { priceKey, type MarkSource } from "@/app/lib/dailyPnl";
import { fetchQuotes } from "@/app/lib/stockApi";
import { syncBankItems } from "@/app/lib/bankApi";
import { etMarketClosedToday, etToday, lastClosedEtDate } from "@/app/lib/marketTime";
import { helperStatus, startPriceSync, startWealthsimpleSync, waitForHelper } from "@/app/lib/localHelper";
import { useCurrency } from "@/app/lib/CurrencyContext";
import { useAuth } from "@/app/lib/AuthContext";

const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Exo 2', sans-serif" };

const POS = "#34d399";
const NEG = "#f87171";
const MUTED = "#4a5568";
const TEXT = "#e2e8f4";
const SUB = "#6b7fa8";
const WARN = "#fbbf24";

const netColor = (n: number) => (n > 0 ? POS : n < 0 ? NEG : MUTED);

// ---------- 头部统计 ----------

function StatCard(props: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div
      className="rounded-xl px-5 py-4 flex-1 min-w-[150px]"
      style={{ background: "rgba(10,14,28,0.82)", border: "1px solid rgba(139,92,246,0.18)" }}
    >
      <div className="text-[10px] tracking-widest mb-1.5" style={{ ...mono, color: MUTED }}>
        {props.label}
      </div>
      <div className="text-xl font-bold" style={{ ...display, color: props.color ?? TEXT }}>
        {props.value}
      </div>
      {props.sub && (
        <div className="text-[10px] mt-1 whitespace-pre-line" style={{ ...mono, color: SUB }}>
          {props.sub}
        </div>
      )}
    </div>
  );
}

// ---------- 日历 ----------

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function CalendarView(props: {
  year: number;
  month: number; // 0-based
  dayAgg: Map<string, { daily: number; stock: number; provisional: boolean }>;
  scope: Scope;
  ccy: "USD" | "CAD";
  today: string;
  selected: string | null;
  onSelect: (d: string) => void;
  onNav: (delta: number) => void;
}) {
  const { year, month, dayAgg, scope, ccy, today, selected, onSelect, onNav } = props;

  const firstOffset = (new Date(year, month, 1).getDay() + 6) % 7; // 周一开头
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let monthNet = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    monthNet += dayNet(dayAgg.get(`${year}-${pad2(month + 1)}-${pad2(d)}`), scope);
  }

  const cells: (number | null)[] = [
    ...Array.from({ length: firstOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div
      className="rounded-xl p-5 h-full"
      style={{ background: "rgba(10,14,28,0.82)", border: "1px solid rgba(139,92,246,0.18)" }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNav(-1)}
            className="p-1.5 rounded-md transition-colors hover:bg-violet-600/15"
            style={{ color: SUB }}
            aria-label="上个月"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-bold text-white w-28 text-center" style={display}>
            {year} 年 {month + 1} 月
          </span>
          <button
            onClick={() => onNav(1)}
            className="p-1.5 rounded-md transition-colors hover:bg-violet-600/15"
            style={{ color: SUB }}
            aria-label="下个月"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="text-xs" style={{ ...mono, color: netColor(monthNet) }}>
          本月 {fmtCad(monthNet, { sign: true, ccy })}
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-center text-[10px] py-1" style={{ ...mono, color: MUTED }}>
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`e${i}`} />;
          const ds = `${year}-${pad2(month + 1)}-${pad2(day)}`;
          const agg = dayAgg.get(ds);
          const net = dayNet(agg, scope);
          const isToday = ds === today;
          const isSelected = ds === selected;
          const hasData = Math.abs(net) >= 0.005;
          const provisional = scope !== "daily" && Boolean(agg?.provisional);
          return (
            <button
              key={ds}
              onClick={() => onSelect(ds)}
              title={provisional ? "含实时价/未同步收盘价,数字还会变" : undefined}
              className="rounded-lg px-0.5 pt-1.5 pb-2 min-h-[58px] flex flex-col items-center gap-1 transition-all overflow-hidden"
              style={{
                background: isSelected ? "rgba(139,92,246,0.22)" : hasData ? "rgba(139,92,246,0.06)" : "transparent",
                border: isSelected
                  ? "1px solid rgba(139,92,246,0.6)"
                  : isToday
                    ? "1px solid rgba(139,92,246,0.45)"
                    : "1px solid transparent",
              }}
            >
              <span
                className="text-[11px] leading-none"
                style={{ ...mono, color: isToday ? "#a78bfa" : hasData ? TEXT : MUTED }}
              >
                {day}
              </span>
              {hasData && (
                <span
                  className="text-[10px] leading-none font-semibold"
                  style={{ ...mono, color: netColor(net), opacity: provisional ? 0.7 : 1 }}
                >
                  {fmtCad(net, { sign: true, ccy })}
                  {provisional && "~"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- 选中日明细 ----------

const SOURCE_LABEL: Record<MarkSource, string> = {
  close: "收盘",
  live: "实时",
  carried: "沿用前收",
  trade: "成交价",
  none: "",
};

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtPx(n: number | null): string {
  if (n === null) return "–";
  return n >= 1000 ? n.toFixed(0) : n.toFixed(2);
}

function DayDetail(props: {
  date: string | null;
  data: DashboardData;
  scope: Scope;
  ccy: "USD" | "CAD";
  fx: number;
  dayPnl: DayPnl | undefined;
  today: string;
}) {
  const { date, data, scope, ccy, fx, dayPnl, today } = props;

  const box = {
    background: "rgba(10,14,28,0.82)",
    border: "1px solid rgba(139,92,246,0.18)",
  };

  if (!date) {
    return (
      <div className="rounded-xl p-5 flex items-center justify-center min-h-[200px] h-full" style={box}>
        <span className="text-xs" style={{ ...mono, color: MUTED }}>
          点一个日期看明细
        </span>
      </div>
    );
  }

  const txns = scope !== "stock" ? data.transactions.filter((t) => t.date === date) : [];
  const positions = scope !== "daily" && dayPnl ? dayPnl.positions : [];
  const stockTotal = positions.reduce((sum, p) => sum + toDisplayCcy(p.pnl, p.currency, ccy, fx), 0);
  const cashEvents = scope !== "daily" ? data.cash.filter((c) => c.date === date) : [];

  const rowBorder = { borderBottom: "1px solid rgba(139,92,246,0.08)" };

  return (
    <div className="rounded-xl p-5 space-y-4 h-full" style={box}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-white" style={display}>
          {date}
        </div>
        <div className="flex items-center gap-3">
          {scope !== "stock" && (
            <Link
              to="/dashboard/daily"
              className="text-[10px] transition-colors hover:text-violet-300"
              style={{ ...mono, color: "#a78bfa" }}
            >
              查看记录 →
            </Link>
          )}
          {scope !== "daily" && (
            <Link
              to="/dashboard/stock"
              className="text-[10px] transition-colors hover:text-violet-300"
              style={{ ...mono, color: "#a78bfa" }}
            >
              查看所有记录 →
            </Link>
          )}
        </div>
      </div>

      {positions.length > 0 && (
        <div>
          <div className="text-[10px] tracking-widest mb-2" style={{ ...mono, color: MUTED }}>
            股票 · 当日盈亏
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-bold" style={{ ...display, color: netColor(stockTotal) }}>
              {fmtCad(stockTotal, { sign: true, ccy })}
            </span>
            {dayPnl?.provisional && (
              <span className="text-[10px]" style={{ ...mono, color: WARN }}>
                {data.priceTableMissing
                  ? "收盘价表还没建,昨收只能用成交价,不准"
                  : date === today && !etMarketClosedToday()
                    ? "盘中实时价,收盘后同步行情变为最终值"
                    : date === today
                      ? "已收盘,收盘价还没同步:点右边\"更新行情\""
                      : "部分价格未同步,数字还会变"}
              </span>
            )}
          </div>
        </div>
      )}

      {positions.length > 0 && (
        <div>
          <div className="text-[10px] tracking-widest mb-1.5" style={{ ...mono, color: MUTED }}>
            持仓明细 ({positions.length})
          </div>
          {positions.map((p) => {
            const pnlDisp = toDisplayCcy(p.pnl, p.currency, ccy, fx);
            const trades: string[] = [];
            if (p.bought > 0) trades.push(`买 ${fmtQty(p.bought)} @ ${fmtPx(p.buyCost / p.bought)}`);
            if (p.sold > 0) trades.push(`卖 ${fmtQty(p.sold)} @ ${fmtPx(p.sellProceeds / p.sold)}`);
            const legs: string[] = [];
            if (Math.abs(p.qtyStart) > 1e-9)
              legs.push(`昨收 ${fmtPx(p.prevMark)}${p.prevSource !== "close" && p.prevSource !== "none" ? `(${SOURCE_LABEL[p.prevSource]})` : ""}`);
            if (Math.abs(p.qtyEnd) > 1e-9)
              legs.push(`今收 ${fmtPx(p.mark)}${p.markSource !== "close" && p.markSource !== "none" ? `(${SOURCE_LABEL[p.markSource]})` : ""}`);
            return (
              <div key={p.key} className="py-1.5 text-xs" style={rowBorder}>
                <div className="flex justify-between items-center gap-3">
                  <span className="min-w-0 truncate" style={{ ...mono, color: TEXT }}>
                    {p.ticker}
                    <span
                      className="text-[9px] px-1 py-0.5 rounded ml-1.5"
                      style={{ background: "rgba(139,92,246,0.12)", color: "#a78bfa" }}
                    >
                      {p.account === "NON-REG" ? "NR" : p.account}
                    </span>
                    {p.currency === "CAD" && <span style={{ color: MUTED }}> CAD</span>}
                    {Math.abs(p.qtyEnd) < 1e-9 && <span style={{ color: MUTED }}> · 已清仓</span>}
                    {p.warning && <span style={{ color: WARN }}> ⚠</span>}
                  </span>
                  <span className="shrink-0" style={{ ...mono, color: netColor(pnlDisp) }}>
                    {fmtCad(pnlDisp, { sign: true, ccy })}
                  </span>
                </div>
                <div className="text-[10px] mt-0.5" style={{ ...mono, color: MUTED }}>
                  {fmtQty(p.qtyStart)} → {fmtQty(p.qtyEnd)} 股
                  {legs.length > 0 && ` · ${legs.join(" · ")}`}
                  {trades.length > 0 && ` · ${trades.join(" · ")}`}
                </div>
                {p.warning && (
                  <div className="text-[10px] mt-0.5" style={{ ...mono, color: WARN }}>
                    {p.warning}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {cashEvents.length > 0 && (
        <div>
          <div className="text-[10px] tracking-widest mb-1.5" style={{ ...mono, color: MUTED }}>
            券商 · 出入金 ({cashEvents.length})
          </div>
          {cashEvents.map((c) => (
            <div key={c.id} className="flex justify-between items-center gap-3 py-1.5 text-xs" style={rowBorder}>
              <span className="truncate min-w-0" style={{ ...mono, color: SUB }}>
                {c.type === "deposit" ? "入金" : "出金"} · {c.account ?? "TFSA"}
                {c.note && <span style={{ color: MUTED }}> · {c.note.slice(0, 40)}</span>}
              </span>
              <span className="shrink-0" style={{ ...mono, color: SUB }}>
                {c.type === "deposit" ? "+" : "−"}
                {c.amount.toFixed(2)} {c.currency}
              </span>
            </div>
          ))}
        </div>
      )}

      {txns.length > 0 && (
        <div>
          <div className="text-[10px] tracking-widest mb-1.5" style={{ ...mono, color: MUTED }}>
            日常 · 收支 ({txns.length})
          </div>
          {txns.map((t) => (
            <div key={t.id} className="flex justify-between items-center gap-3 py-1.5 text-xs" style={rowBorder}>
              <span className="truncate min-w-0" style={{ ...mono, color: t.is_transfer ? MUTED : TEXT }}>
                {t.merchant || t.name || "—"}
                {t.is_transfer && " · 转账"}
                {t.category && !t.is_transfer && (
                  <span style={{ color: SUB }}> · {t.category.toLowerCase()}</span>
                )}
              </span>
              <span
                className="shrink-0"
                style={{ ...mono, color: t.is_transfer ? MUTED : netColor(-t.amount) }}
              >
                {fmtCad(ccy === "CAD" ? -t.amount : -t.amount / fx, { sign: true, ccy })}
              </span>
            </div>
          ))}
        </div>
      )}

      {txns.length === 0 && positions.length === 0 && cashEvents.length === 0 && (
        <div className="text-xs py-6 text-center" style={{ ...mono, color: MUTED }}>
          这一天没有记录
        </div>
      )}
    </div>
  );
}

// ---------- 同步状态 ----------

const SYNC_ITEMS = [
  { key: "wealthsimple", label: "Wealthsimple", source: "stock", match: ["wealthsimple", "ws"] },
  { key: "rogers", label: "Rogers Bank", source: "daily", match: ["rogers"] },
  { key: "triangle", label: "Triangle Bank", source: "daily", match: ["triangle", "canadian tire", "ctfs"] },
  { key: "scotiabank", label: "Scotiabank", source: "daily", match: ["scotiabank", "scotia"] },
  { key: "cibc", label: "CIBC", source: "daily", match: ["cibc"] },
  { key: "rbc", label: "RBC", source: "daily", match: ["rbc", "royal bank"] },
] as const;

function lastIso(values: (string | null | undefined)[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!latest || value > latest) latest = value;
  }
  return latest;
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return "从未同步";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function daysSince(iso: string | null): string {
  if (!iso) return "还没有更新记录";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "同步时间异常";
  const today = new Date();
  const thenDay = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.max(0, Math.floor((todayDay - thenDay) / 86400000));
  return days === 0 ? "今天已更新" : `已经 ${days} 天没更新了`;
}

function institutionMatches(name: string | null, terms: readonly string[]): boolean {
  const text = (name ?? "").toLowerCase();
  if (!text) return false;
  // 双向匹配:银行连接里存的名字有时是缩写(比如 "Sco"),不一定是能包住 "scotiabank" 的全名,
  // 反过来才对得上,所以两个方向都要试
  return terms.some((term) => text.includes(term) || term.includes(text));
}

function fmtTotals(t: Record<string, number> | null): string {
  if (!t) return "—";
  const parts = Object.entries(t).filter(([, v]) => Math.abs(v) >= 0.005);
  if (parts.length === 0) return "0";
  return parts.map(([ccy, v]) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} ${ccy}`).join(" / ");
}

function diffLine(kind: "added" | "changed" | "removed", d: PnlDiffDay): { text: string; color: string } {
  const label = kind === "added" ? "新增" : kind === "removed" ? "消失" : "修改";
  const reason = d.reason === "both" ? "交易+行情" : d.reason === "trades" ? "交易变动" : d.reason === "prices" ? "行情更新" : "";
  const amounts =
    kind === "added" ? fmtTotals(d.after) : kind === "removed" ? fmtTotals(d.before) : `${fmtTotals(d.before)} → ${fmtTotals(d.after)}`;
  return {
    text: `${d.date} ${label} ${amounts}${reason ? ` · ${reason}` : ""}`,
    color: kind === "added" ? POS : kind === "removed" ? NEG : TEXT,
  };
}

function ImportLogCard({ log }: { log: ImportLog }) {
  const [open, setOpen] = useState(false);
  const diff = log.pnl_diff;
  const lines = diff
    ? [
        ...diff.added.map((d) => diffLine("added", d)),
        ...diff.changed.map((d) => diffLine("changed", d)),
        ...diff.removed.map((d) => diffLine("removed", d)),
      ].sort((a, b) => a.text.localeCompare(b.text))
    : [];
  const changedCount = diff ? diff.added.length + diff.changed.length + diff.removed.length : 0;
  const tradeChanges = log.trade_changes?.trades ?? [];
  const ps = log.price_sync;
  return (
    <div
      className="rounded-lg px-3 py-2.5"
      style={{ background: "rgba(139,92,246,0.04)", border: "1px solid rgba(139,92,246,0.1)" }}
    >
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between gap-2 text-left">
        <div className="min-w-0">
          <div className="text-[10px]" style={{ ...mono, color: SUB }}>
            {formatSyncTime(log.ran_at)} · 交易 +{log.trades_inserted}/改{log.trades_updated} · 现金 +{log.cash_inserted}/改{log.cash_updated}
          </div>
          <div className="text-[10px] mt-0.5" style={{ ...mono, color: changedCount ? TEXT : MUTED }}>
            {diff
              ? `日历: 新增 ${diff.added.length} 天 · 修改 ${diff.changed.length} 天 · 消失 ${diff.removed.length} 天`
              : log.summary ?? "—"}
            {ps?.lastClosed && ` · 收盘价至 ${ps.lastClosed}`}
            {ps?.warning && ` · ⚠ ${ps.warning}`}
          </div>
        </div>
        <ChevronDown size={12} style={{ color: MUTED, transform: open ? "rotate(180deg)" : "none", flexShrink: 0 }} />
      </button>
      {open && (
        <div className="mt-2 pt-2 space-y-0.5" style={{ borderTop: "1px solid rgba(139,92,246,0.1)" }}>
          {lines.length === 0 && (
            <div className="text-[10px]" style={{ ...mono, color: MUTED }}>
              日历没有变化
            </div>
          )}
          {lines.slice(0, 30).map((l) => (
            <div key={l.text} className="text-[10px]" style={{ ...mono, color: l.color }}>
              {l.text}
            </div>
          ))}
          {lines.length > 30 && (
            <div className="text-[10px]" style={{ ...mono, color: MUTED }}>
              … 还有 {lines.length - 30} 条
            </div>
          )}
          {tradeChanges.length > 0 && (
            <div className="pt-1.5 mt-1.5" style={{ borderTop: "1px solid rgba(139,92,246,0.1)" }}>
              <div className="text-[10px] mb-0.5" style={{ ...mono, color: MUTED }}>
                成交变动 ({tradeChanges.length})
              </div>
              {tradeChanges.slice(0, 20).map((t, i) => (
                <div key={i} className="text-[10px]" style={{ ...mono, color: SUB }}>
                  {t.op === "insert" ? "＋" : "改"} {t.date} {t.side === "buy" ? "买" : "卖"} {t.ticker} {fmtQty(t.qty)} @ {fmtPx(t.price)} {t.currency} · {t.account}
                  {t.changes && Object.keys(t.changes).length > 0 && (
                    <span style={{ color: MUTED }}>
                      {" "}
                      ({Object.entries(t.changes)
                        .map(([f, [a, b]]) => `${f}: ${String(a)} → ${String(b)}`)
                        .join(", ")})
                    </span>
                  )}
                </div>
              ))}
              {tradeChanges.length > 20 && (
                <div className="text-[10px]" style={{ ...mono, color: MUTED }}>
                  … 还有 {tradeChanges.length - 20} 条
                </div>
              )}
            </div>
          )}
          {ps && (ps.notFound?.length || ps.errors?.length) ? (
            <div className="text-[10px] pt-1" style={{ ...mono, color: WARN }}>
              {ps.notFound?.length ? `雅虎无行情: ${ps.notFound.map((n) => n.key).join(", ")}` : ""}
              {ps.errors?.length ? ` 行情出错: ${ps.errors.map((e) => `${e.key}(${e.error})`).join(", ")}` : ""}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SyncPanel(props: { data: DashboardData; onReload: () => Promise<void>; today: string }) {
  const { data, onReload, today } = props;
  const { session } = useAuth();
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  // SnapTrade 定时同步(每 10 分钟,在 Supabase 上跑)最后一次检查
  const snapRun = data.syncRuns.find((r) => r.source === "snaptrade");
  const coverage = useMemo(() => priceCoverage(data), [data]);
  const lastClosed = lastClosedEtDate();
  const priceStale = coverage.heldThrough !== null && coverage.heldThrough < lastClosed;

  const rows = SYNC_ITEMS.map((item) => {
    const syncedAt =
      item.source === "stock"
        ? lastIso([
            ...data.trades.map((t) => t.synced_at ?? t.ts ?? t.date),
            ...data.cash.map((c) => c.synced_at ?? c.ts ?? c.date),
            ...data.splits.map((s) => s.synced_at ?? s.ts ?? s.date),
          ])
        : lastIso(
            data.transactions
              .filter((t) => institutionMatches(t.institution_name, item.match))
              .map((t) => t.synced_at ?? t.date)
          );
    return { ...item, syncedAt };
  });

  const waitForWealthsimple = async () => {
    const status = await waitForHelper((s) => s.running, 180);
    if (!status) {
      setSyncMessage("Wealthsimple 还在同步中,稍后刷新页面查看。");
      return;
    }
    const output = (status.lastRun?.output ?? []) as string[];
    const failed = output.find((line) => /failed|error/i.test(line) && !/errors? 0\b|出错 0/.test(line));
    if (status.lastRun?.exitCode && status.lastRun.exitCode !== 0) {
      setSyncMessage(`Wealthsimple 下载完成,但导入失败: ${failed ?? `exit ${status.lastRun.exitCode}`}`);
      await onReload();
      return;
    }
    setSyncMessage("Wealthsimple 同步完成,日历已刷新 —— 变动明细见下方同步日志。");
    await onReload();
  };

  const handlePriceSync = async () => {
    setSyncing("prices");
    setSyncMessage(null);
    try {
      const r = await startPriceSync(session?.user.id);
      setSyncMessage(r.message === "Price sync is already running." ? "行情同步已经在运行。" : "行情同步已启动…");
      const status = await waitForHelper((s) => Boolean(s.prices?.running), 120);
      if (!status) {
        setSyncMessage("行情同步还在跑,稍后刷新。");
      } else if (status.prices?.lastRun?.exitCode) {
        const out = status.prices.lastRun.output ?? [];
        setSyncMessage(`行情同步失败: ${out[out.length - 1] ?? `exit ${status.prices.lastRun.exitCode}`}`);
      } else {
        const out = status.prices?.lastRun?.output ?? [];
        setSyncMessage(`行情已更新: ${out[out.length - 1] ?? "完成"}`);
      }
      await onReload();
    } catch (e) {
      setSyncMessage(`请先启动本地 helper: npm run ws:helper (${String((e as Error).message ?? e)})`);
    } finally {
      setSyncing(null);
    }
  };

  const handleUpdate = async (key: string, label: string, terms: readonly string[]) => {
    setSyncing(key);
    setSyncMessage(null);
    if (key === "wealthsimple") {
      try {
        const result = await startWealthsimpleSync(session?.user.id);
        if (result.message === "Wealthsimple sync is already running.") {
          setSyncMessage("Wealthsimple 同步已经在运行,继续在打开的浏览器里登录并下载 CSV。");
        } else if (result.canApply) {
          setSyncMessage("Wealthsimple 同步已启动,登录后下载 CSV 会自动导入 + 同步收盘价。");
        } else {
          setSyncMessage("Wealthsimple 同步已启动,但缺少 Supabase 导入配置或登录用户。");
        }
        waitForWealthsimple().catch((e) => setSyncMessage(`无法读取本地同步状态: ${String((e as Error).message ?? e)}`));
      } catch (e) {
        setSyncMessage(`请先启动本地 helper: npm run ws:helper (${String((e as Error).message ?? e)})`);
      } finally {
        setSyncing(null);
      }
      return;
    }

    try {
      const count = await syncBankItems([...terms]);
      setSyncMessage(count > 0 ? `${label} 后台同步已启动。` : `没有找到已连接的 ${label}。`);
      setTimeout(() => {
        onReload().catch(() => {});
      }, 3500);
    } catch (e) {
      setSyncMessage(`${label} 同步失败: ${String((e as Error).message ?? e)}`);
    } finally {
      setSyncing(null);
    }
  };

  const btnStyle = (active: boolean) => ({
    ...mono,
    color: "#fff",
    background: "linear-gradient(135deg,#8b5cf6,#7c3aed)",
    opacity: active ? 0.6 : 1,
  });

  return (
    <div
      className="rounded-xl p-5 h-full"
      style={{ background: "rgba(10,14,28,0.82)", border: "1px solid rgba(139,92,246,0.18)" }}
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-sm font-bold text-white" style={display}>
            同步
          </div>
          <div className="text-[10px] mt-1" style={{ ...mono, color: MUTED }}>
            DATA SOURCES
          </div>
        </div>
        <RefreshCw size={16} style={{ color: "#a78bfa" }} />
      </div>

      {data.priceTableMissing && (
        <div
          className="rounded-md px-3 py-2 mb-3 text-[10px]"
          style={{ ...mono, color: WARN, background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.3)" }}
        >
          收盘价表(stock_prices)还没建:在 Supabase SQL Editor 执行 supabase/schema.sql 末尾那段,再点"更新行情"。
          在那之前日历只能用成交价/实时价推算。
        </div>
      )}

      {syncMessage && (
        <div
          className="rounded-md px-3 py-2 mb-3 text-[10px]"
          style={{
            ...mono,
            color: /失败|请先/.test(syncMessage) ? NEG : SUB,
            background: "rgba(139,92,246,0.06)",
            border: "1px solid rgba(139,92,246,0.12)",
          }}
        >
          {syncMessage}
        </div>
      )}

      <div className="space-y-2.5">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex items-center justify-between gap-3 rounded-lg px-3 py-3"
            style={{ background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.12)" }}
          >
            <div className="min-w-0">
              <div className="text-xs font-bold truncate" style={{ ...mono, color: TEXT }}>
                {row.label}
              </div>
              <div className="text-[10px] mt-1" style={{ ...mono, color: SUB }}>
                上次同步 {formatSyncTime(row.syncedAt)}
              </div>
              <div className="text-[10px] mt-0.5" style={{ ...mono, color: row.syncedAt ? MUTED : NEG }}>
                {daysSince(row.syncedAt)}
              </div>
              {row.key === "wealthsimple" && snapRun && (
                <div className="text-[10px] mt-0.5" style={{ ...mono, color: snapRun.ok ? MUTED : NEG }}>
                  自动检查 {formatSyncTime(snapRun.checked_at)} ·{" "}
                  {snapRun.ok
                    ? snapRun.new_trades || snapRun.new_cash
                      ? `新增交易 ${snapRun.new_trades} / 现金 ${snapRun.new_cash}`
                      : "没有新交易"
                    : `失败: ${snapRun.message ?? ""}`}
                </div>
              )}
              {row.key === "wealthsimple" && (
                <div className="text-[10px] mt-0.5" style={{ ...mono, color: priceStale ? WARN : MUTED }}>
                  {coverage.heldThrough
                    ? `收盘价至 ${coverage.heldThrough}${priceStale ? `(应到 ${lastClosed})` : ""}`
                    : coverage.latestClose
                      ? `收盘价至 ${coverage.latestClose}`
                      : "还没有收盘价"}
                  {coverage.heldMissing.length > 0 && ` · 无行情: ${coverage.heldMissing.map((k) => k.split("|")[0]).join(", ")}`}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1.5 shrink-0">
              <button
                onClick={() => handleUpdate(row.key, row.label, row.match)}
                disabled={syncing === row.key}
                className="px-3 py-1.5 rounded-md text-[10px] font-bold transition-all hover:opacity-90"
                style={btnStyle(syncing === row.key)}
              >
                {syncing === row.key ? "启动中" : "更新"}
              </button>
              {row.key === "wealthsimple" && (
                <button
                  onClick={handlePriceSync}
                  disabled={syncing === "prices"}
                  title="只同步收盘价(不下载 WS)。收盘后点一下,今天的盈亏就从实时价变成收盘价。"
                  className="px-3 py-1.5 rounded-md text-[10px] font-bold transition-all hover:opacity-90"
                  style={{ ...mono, color: "#a78bfa", background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.3)", opacity: syncing === "prices" ? 0.6 : 1 }}
                >
                  {syncing === "prices" ? "同步中" : "更新行情"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {data.importLogs.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setLogsOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 text-left"
          >
            <span className="text-[10px] tracking-widest" style={{ ...mono, color: MUTED }}>
              同步日志 · 日历变动{!logsOpen && ` · 最近 ${formatSyncTime(data.importLogs[0].ran_at)}`}
            </span>
            <ChevronDown size={12} style={{ color: MUTED, transform: logsOpen ? "rotate(180deg)" : "none", flexShrink: 0 }} />
          </button>
          {logsOpen && (
            <div className="space-y-1.5 mt-2">
              {data.importLogs.slice(0, 5).map((log) => (
                <ImportLogCard key={log.id} log={log} />
              ))}
            </div>
          )}
        </div>
      )}
      <div className="text-[10px] mt-3" style={{ ...mono, color: MUTED }}>
        今天 {today}(美东)
      </div>
    </div>
  );
}

// ---------- 页面 ----------

const SCOPES: { key: Scope; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "daily", label: "日常" },
  { key: "stock", label: "股票" },
];

export default function DashboardPage(props: { initialData?: DashboardData; initialScope?: Scope; initialSelected?: string }) {
  const { initialData, initialScope, initialSelected } = props;
  const { currency: ccy } = useCurrency();
  const { session } = useAuth();
  const [data, setData] = useState<DashboardData | null>(initialData ?? null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>(initialScope ?? "all");
  const today = etToday();
  const [ym, setYm] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return { year: y, month: m - 1 };
  });
  const [selected, setSelected] = useState<string | null>(initialSelected ?? today);
  const [liveMarks, setLiveMarks] = useState<LiveMarks | null>(null);
  const [liveFx, setLiveFx] = useState<number | null>(null);

  const reloadData = useCallback(async () => {
    try {
      const next = await fetchDashboardData();
      setData(next);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    if (initialData) return;
    reloadData();
  }, [initialData, reloadData]);

  // 实时行情只用于"今天"这一格:还持有的 + 今天成交过的(今天已清仓的票也要用实时价算当天盈亏)。
  useEffect(() => {
    if (!data) return;
    const positions = computePositions(data.trades, data.splits);
    const relevant = [
      ...positions.map((p) => ({ ticker: p.ticker, currency: p.currency })),
      ...data.trades.filter((t) => t.date === today).map((t) => ({ ticker: t.ticker.toUpperCase(), currency: t.currency })),
    ];
    const usdTickers = [...new Set(relevant.filter((p) => p.currency === "USD").map((p) => p.ticker))];
    const cadTickers = [...new Set(relevant.filter((p) => p.currency === "CAD").map((p) => p.ticker))];
    if (usdTickers.length === 0 && cadTickers.length === 0) return;
    fetchQuotes(usdTickers, cadTickers)
      .then((q) => {
        const map: LiveMarks = new Map();
        for (const [ticker, quote] of Object.entries(q.usd)) if (quote && quote.c > 0) map.set(priceKey(ticker, "USD"), quote.c);
        for (const [ticker, quote] of Object.entries(q.cad)) if (quote && quote.c > 0) map.set(priceKey(ticker, "CAD"), quote.c);
        setLiveMarks(map);
        if (q.fx) setLiveFx(q.fx);
      })
      .catch(() => {
        // 拿不到实时行情就算了,退回收盘价/成交价的兜底逻辑
      });
  }, [data, today]);

  // 收盘价落后于最近一个交易日、且本地 helper 在跑 → 自动补一次行情,不用手点
  useEffect(() => {
    if (!data || data.priceTableMissing) return;
    const coverage = priceCoverage(data);
    const lastClosed = lastClosedEtDate();
    if (!coverage.heldThrough || coverage.heldThrough >= lastClosed) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await helperStatus();
        if (cancelled || status.prices?.running) return;
        await startPriceSync(session?.user.id);
        const done = await waitForHelper((s) => Boolean(s.prices?.running), 120);
        if (!cancelled && done && !done.prices?.lastRun?.exitCode) await reloadData();
      } catch {
        // helper 没开就算了,面板上会提示"收盘价至 X(应到 Y)"
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在数据的覆盖范围变化时判断一次,避免反复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data ? priceCoverage(data).heldThrough : null, data?.priceTableMissing]);

  const fx = useMemo(() => (data ? latestFx(data, liveFx) : 1.37), [data, liveFx]);
  const pnlByDay = useMemo(() => (data ? buildDailyPnl(data, today, liveMarks ?? undefined) : new Map<string, DayPnl>()), [data, today, liveMarks]);
  const dayAgg = useMemo(() => (data ? aggregateByDay(data, pnlByDay, ccy, fx) : new Map()), [data, pnlByDay, ccy, fx]);
  const totals = useMemo(() => (data ? computeTotals(data, ccy, today, fx, liveMarks ?? undefined) : null), [data, ccy, today, fx, liveMarks]);

  const navMonth = (delta: number) =>
    setYm(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  return (
    <div className="min-h-screen" style={{ background: "#060a14", fontFamily: "'Inter', sans-serif" }}>
      <DashboardNavbar />
      <main className="pt-24 pb-16 px-6 lg:px-10 max-w-6xl mx-auto space-y-6">
        {error && (
          <div
            className="rounded-xl p-4 text-xs"
            style={{ ...mono, color: NEG, background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.3)" }}
          >
            数据加载失败:{error}
          </div>
        )}

        {!data && !error && (
          <div className="flex items-center gap-2 justify-center py-24 text-xs" style={{ ...mono, color: MUTED }}>
            <RefreshCw size={13} className="animate-spin" />
            LOADING ASSETS...
          </div>
        )}

        {data && totals && (
          <>
            {/* 总资产 */}
            <div
              className="rounded-xl p-6"
              style={{
                background: "linear-gradient(135deg, rgba(139,92,246,0.14), rgba(10,14,28,0.85))",
                border: "1px solid rgba(139,92,246,0.3)",
                boxShadow: "0 0 60px rgba(139,92,246,0.1)",
              }}
            >
              <div className="text-[10px] tracking-widest mb-2 flex items-center gap-2" style={{ ...mono, color: SUB }}>
                <Wallet size={12} />
                总资产(推算 · {ccy} · {totals.marks.live > 0 ? "含实时价" : "按收盘价"})
              </div>
              <div className="text-4xl font-black text-white mb-4" style={display}>
                {fmtCad(totals.total, { ccy })}
              </div>
              <div className="flex flex-wrap gap-3">
                <StatCard
                  label="股票市值"
                  value={fmtCad(totals.stockValue, { ccy })}
                  sub={`持仓 ${fmtCad(totals.positionsValue, { ccy })} · 现金 ${fmtCad(totals.stockCash, { ccy })} · FX ${fx.toFixed(4)}${
                    totals.marks.other > 0 ? `\n${totals.marks.other} 个持仓没有实时价/收盘价,按最近价格估` : ""
                  }`}
                />
                <StatCard
                  label="日常累计净收支"
                  value={fmtCad(totals.dailyCum, { ccy })}
                  color={netColor(totals.dailyCum)}
                  sub="从首笔记录累计,转账已剔除"
                />
              </div>
            </div>

            {/* 范围切换 */}
            <div className="flex items-center gap-2">
              <TrendingUp size={13} style={{ color: MUTED }} />
              {SCOPES.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setScope(s.key)}
                  className="px-4 py-1.5 rounded-full text-xs font-semibold transition-all"
                  style={{
                    ...mono,
                    color: scope === s.key ? "#fff" : SUB,
                    background: scope === s.key ? "linear-gradient(135deg,#8b5cf6,#7c3aed)" : "rgba(139,92,246,0.08)",
                    border: scope === s.key ? "1px solid transparent" : "1px solid rgba(139,92,246,0.2)",
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* 日历 + 明细 */}
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-6 items-stretch">
              <CalendarView
                year={ym.year}
                month={ym.month}
                dayAgg={dayAgg}
                scope={scope}
                ccy={ccy}
                today={today}
                selected={selected}
                onSelect={setSelected}
                onNav={navMonth}
              />
              {scope === "all" ? (
                <SyncPanel data={data} onReload={reloadData} today={today} />
              ) : (
                <DayDetail
                  date={selected}
                  data={data}
                  scope={scope}
                  ccy={ccy}
                  fx={fx}
                  dayPnl={selected ? pnlByDay.get(selected) : undefined}
                  today={today}
                />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
