import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ChevronLeft, ChevronRight, RefreshCw, TrendingUp, Wallet } from "lucide-react";
import DashboardNavbar from "./DashboardNavbar";
import {
  aggregateByDay,
  computeStockDayPnl,
  computeTotals,
  dayNet,
  fetchDashboardData,
  fmtCad,
  type DashboardData,
  type Scope,
} from "@/app/lib/dashboardData";

const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Exo 2', sans-serif" };

const POS = "#34d399";
const NEG = "#f87171";
const MUTED = "#4a5568";
const TEXT = "#e2e8f4";
const SUB = "#6b7fa8";

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
        <div className="text-[10px] mt-1" style={{ ...mono, color: SUB }}>
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
  dayAgg: Map<string, { daily: number; stock: number }>;
  scope: Scope;
  selected: string | null;
  onSelect: (d: string) => void;
  onNav: (delta: number) => void;
}) {
  const { year, month, dayAgg, scope, selected, onSelect, onNav } = props;
  const todayStr = new Date().toISOString().slice(0, 10);

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
          本月 {fmtCad(monthNet, { sign: true })}
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
          const net = dayNet(dayAgg.get(ds), scope);
          const isToday = ds === todayStr;
          const isSelected = ds === selected;
          const hasData = Math.abs(net) >= 0.005;
          return (
            <button
              key={ds}
              onClick={() => onSelect(ds)}
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
                <span className="text-[10px] leading-none font-semibold" style={{ ...mono, color: netColor(net) }}>
                  {fmtCad(net, { sign: true })}
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

function DayDetail(props: { date: string | null; data: DashboardData; scope: Scope }) {
  const { date, data, scope } = props;

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
  const cashEvents = scope !== "daily" ? data.cash.filter((c) => c.date === date) : [];
  const tickerPnls = scope !== "daily" ? computeStockDayPnl(data, date) : [];

  const snapIdx = data.snapshots.findIndex((s) => s.date === date);
  const snap = snapIdx >= 0 ? data.snapshots[snapIdx] : null;
  const stockDelta =
    snap === null ? 0 : snapIdx === 0 ? snap.value_cad : snap.value_cad - data.snapshots[snapIdx - 1].value_cad;

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

      {scope !== "daily" && snap && Math.abs(stockDelta) >= 0.005 && (
        <div>
          <div className="text-[10px] tracking-widest mb-2" style={{ ...mono, color: MUTED }}>
            股票 · 市值变化
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-bold" style={{ ...display, color: netColor(stockDelta) }}>
              {fmtCad(stockDelta, { sign: true })}
            </span>
            <span className="text-[10px]" style={{ ...mono, color: SUB }}>
              市值 {fmtCad(snap.value_cad)} · FX {snap.fx_usdcad ?? "–"}
            </span>
          </div>
        </div>
      )}

      {tickerPnls.length > 0 && (
        <div>
          <div className="text-[10px] tracking-widest mb-1.5" style={{ ...mono, color: MUTED }}>
            股票 · 持仓盈亏 ({tickerPnls.length})
          </div>
          {tickerPnls.map((p) => (
            <div key={`${p.ticker}|${p.currency}`} className="flex justify-between items-center py-1.5 text-xs" style={rowBorder}>
              <span style={{ ...mono, color: TEXT }}>
                {p.ticker}
                <span style={{ color: SUB }}> · {p.currency}</span>
                {p.qty <= 0 && <span style={{ color: MUTED }}> · 已清仓</span>}
              </span>
              <span style={{ ...mono, color: netColor(p.pnl) }}>{fmtCad(p.pnl, { sign: true })}</span>
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
                {fmtCad(-t.amount, { sign: true })}
              </span>
            </div>
          ))}
        </div>
      )}

      {txns.length === 0 && tickerPnls.length === 0 && cashEvents.length === 0 && (!snap || Math.abs(stockDelta) < 0.005) && (
        <div className="text-xs py-6 text-center" style={{ ...mono, color: MUTED }}>
          这一天没有记录
        </div>
      )}
    </div>
  );
}

// ---------- 页面 ----------

const SCOPES: { key: Scope; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "daily", label: "日常" },
  { key: "stock", label: "股票" },
];

export default function DashboardPage({ initialData }: { initialData?: DashboardData }) {
  const [data, setData] = useState<DashboardData | null>(initialData ?? null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("all");
  const now = new Date();
  const [ym, setYm] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [selected, setSelected] = useState<string | null>(now.toISOString().slice(0, 10));

  useEffect(() => {
    if (initialData) return;
    fetchDashboardData().then(setData).catch((e) => setError(String(e.message ?? e)));
  }, [initialData]);

  const dayAgg = useMemo(() => (data ? aggregateByDay(data) : new Map()), [data]);
  const totals = useMemo(() => (data ? computeTotals(data) : null), [data]);

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
                总资产(推算 · CAD{totals.asOf ? ` · 截至 ${totals.asOf}` : ""})
              </div>
              <div className="text-4xl font-black text-white mb-4" style={display}>
                {fmtCad(totals.total)}
              </div>
              <div className="flex flex-wrap gap-3">
                <StatCard
                  label="股票市值"
                  value={fmtCad(totals.stockValue)}
                  sub={totals.stockCash !== null ? `含现金 ${fmtCad(totals.stockCash)} · FX ${totals.fx ?? "–"}` : undefined}
                />
                <StatCard
                  label="日常累计净收支"
                  value={fmtCad(totals.dailyCum)}
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
                selected={selected}
                onSelect={setSelected}
                onNav={navMonth}
              />
              <DayDetail date={selected} data={data} scope={scope} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
