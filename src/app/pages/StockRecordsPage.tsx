import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ArrowLeft, RefreshCw } from "lucide-react";
import DashboardNavbar from "./DashboardNavbar";
import { useAuth } from "@/app/lib/AuthContext";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  fetchDashboardData,
  fmtCad,
  type DashboardData,
  type StockTrade,
} from "@/app/lib/dashboardData";
import {
  computeCashBalance,
  computeDayPnl,
  computePositions,
  computeStockSummary,
  matchSell,
  stopAnchorAndFloor,
  type Position,
} from "@/app/lib/stockPositions";
import {
  deleteStockCash,
  deleteStockTrade,
  fetchQuotes,
  fetchStops,
  insertStockCash,
  insertStockTrade,
  updateStockTrade,
  type Account,
  type Currency,
  type QuotesResponse,
  type StopsInfo,
} from "@/app/lib/stockApi";

const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Exo 2', sans-serif" };

const POS = "#34d399";
const NEG = "#f87171";
const MUTED = "#4a5568";
const TEXT = "#e2e8f4";
const SUB = "#6b7fa8";

const box = { background: "rgba(10,14,28,0.82)", border: "1px solid rgba(139,92,246,0.18)" };
const netColor = (n: number) => (n > 0 ? POS : n < 0 ? NEG : MUTED);

const ACCOUNTS: Account[] = ["TFSA", "NON-REG"];
const CURRENCIES: Currency[] = ["USD", "CAD"];
const DEFAULT_FX = 1.37;

function StatCard(props: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="rounded-xl px-5 py-4 flex-1 min-w-[170px]" style={box}>
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

const th = "text-left text-[10px] tracking-widest py-2 px-3";
const td = "py-2 px-3 text-xs whitespace-nowrap";

const selectStyle = {
  ...mono,
  background: "rgba(139,92,246,0.06)",
  border: "1px solid rgba(139,92,246,0.2)",
  borderRadius: 6,
  padding: "7px 10px",
  color: TEXT,
  fontSize: 12,
  outline: "none",
};

const inputStyle = {
  ...selectStyle,
  width: "100%",
};

const actionBtn = {
  ...mono,
  fontSize: 11,
  fontWeight: 700 as const,
  letterSpacing: "0.05em",
  padding: "8px 14px",
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid transparent",
};

function todayLocalDate(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nowLocalInputValue(): string {
  return toLocalInputValue(new Date());
}

function toCad(amount: number, currency: string, fx: number): number {
  return currency === "CAD" ? amount : amount * fx;
}

function livePrice(p: Position, quotes: QuotesResponse | null): number | null {
  if (!quotes) return null;
  const q = p.currency === "CAD" ? quotes.cad[p.ticker] : quotes.usd[p.ticker];
  return q?.c ?? null;
}

function prevClose(p: Position, quotes: QuotesResponse | null): number | null {
  if (!quotes) return null;
  const q = p.currency === "CAD" ? quotes.cad[p.ticker] : quotes.usd[p.ticker];
  return q?.pc ?? null;
}

function stopColor(pct: number | null): string {
  if (pct === null) return MUTED;
  if (pct >= 0) return "#cc3333";
  const abs = Math.abs(pct);
  if (abs < 4) return "#e05c5c";
  if (abs < 8) return "#f0a040";
  if (abs <= 15) return "#26c281";
  return "#a76cf0";
}

function MomCell({ position, info }: { position: Position; info: StopsInfo | undefined }) {
  if (!info || info.error || info.stop_mom === null || info.stop_mom === undefined) {
    return <span style={{ ...mono, color: MUTED }}>--</span>;
  }
  const { initial_floor } = stopAnchorAndFloor(position);
  const floorActive =
    initial_floor !== null &&
    Math.abs(info.stop_mom - initial_floor) < 0.01 &&
    !(info.stop_mom_raw !== null && info.stop_mom_raw !== undefined && info.stop_mom < info.stop_mom_raw - 0.01);
  const icon = info.trend_quality === "broken" ? "⚠️ " : info.trend_quality === "new" ? "🆕 " : "";
  const lineLabel = floorActive ? "开仓止损" : `${info.chosen_line} × ${(info.buffer ?? 0).toFixed(2)}`;
  const trendLabel =
    info.trend_quality === "broken"
      ? "趋势已破"
      : info.trend_days && info.trend_days > 0
        ? `趋势 ${info.trend_days}d${info.leg_restarted ? " ✨" : ""}`
        : "";
  const color = stopColor(info.stop_mom_pct ?? null);
  const prefix = position.currency === "CAD" ? "C$" : "$";
  return (
    <div>
      <div style={{ ...mono, color, fontWeight: 700 }}>
        {icon}
        {prefix}
        {info.stop_mom.toFixed(2)}
      </div>
      <div className="text-[9px] mt-0.5" style={{ ...mono, color: MUTED }}>
        {[lineLabel, trendLabel].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}

const MOM_TOOLTIP =
  "从当前趋势起点(10EMA 上穿 20EMA)算\n· 破 10EMA 率 < 15% → 10EMA\n· 否则 → 20EMA\n· 缓冲: 按 ATR 0.97/0.98/0.99\n· 破 20EMA 率 > 25% → ⚠️ 破位\n触发: 日收盘 < 该位 → 次日开盘出\n颜色: 绿色安全 橙色注意 红色临近 紫色过宽";

interface TradeForm {
  ticker: string;
  qty: string;
  price: string;
  currency: Currency;
  account: Account;
  initialStop: string;
  ts: string;
  note: string;
  positionKey: string;
}

function emptyTradeForm(): TradeForm {
  return {
    ticker: "",
    qty: "",
    price: "",
    currency: "USD",
    account: "TFSA",
    initialStop: "",
    ts: nowLocalInputValue(),
    note: "",
    positionKey: "",
  };
}

interface CashForm {
  amount: string;
  currency: Currency;
  account: Account;
  ts: string;
  note: string;
}

function emptyCashForm(): CashForm {
  return { amount: "", currency: "USD", account: "TFSA", ts: nowLocalInputValue(), note: "" };
}

export default function StockRecordsPage() {
  const { session } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string>("all");
  const [ticker, setTicker] = useState<string>("all");

  const [quotes, setQuotes] = useState<QuotesResponse | null>(null);
  const [stops, setStops] = useState<Record<string, StopsInfo>>({});
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const refreshingRef = useRef(false);

  const [tradeOpen, setTradeOpen] = useState(false);
  const [tradeSide, setTradeSide] = useState<"buy" | "sell">("buy");
  const [tradeForm, setTradeForm] = useState<TradeForm>(emptyTradeForm());
  const [tradeError, setTradeError] = useState("");
  const [tradeSaving, setTradeSaving] = useState(false);
  const [editingTrade, setEditingTrade] = useState<StockTrade | null>(null);

  const [cashOpen, setCashOpen] = useState(false);
  const [cashType, setCashType] = useState<"deposit" | "withdraw">("deposit");
  const [cashForm, setCashForm] = useState<CashForm>(emptyCashForm());
  const [cashError, setCashError] = useState("");
  const [cashSaving, setCashSaving] = useState(false);

  const reloadData = useCallback(async () => {
    try {
      const d = await fetchDashboardData();
      setData(d);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    reloadData();
  }, [reloadData]);

  const positions = useMemo(() => (data ? computePositions(data.trades) : []), [data]);
  const cashBalance = useMemo(() => (data ? computeCashBalance(data.cash, data.trades) : {}), [data]);
  const summary = useMemo(() => (data ? computeStockSummary(data.trades) : null), [data]);

  const usdTickers = useMemo(
    () => [...new Set(positions.filter((p) => p.currency === "USD").map((p) => p.ticker))],
    [positions]
  );
  const cadTickers = useMemo(
    () => [...new Set(positions.filter((p) => p.currency === "CAD").map((p) => p.ticker))],
    [positions]
  );

  const refreshPrices = useCallback(async () => {
    if (refreshingRef.current || positions.length === 0) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const [q, s] = await Promise.all([fetchQuotes(usdTickers, cadTickers), fetchStops(positions)]);
      setQuotes(q);
      setStops(s);
      setLastUpdated(new Date());
    } catch (e) {
      console.error("刷新价格失败", e);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usdTickers.join(","), cadTickers.join(","), positions.length]);

  useEffect(() => {
    if (positions.length > 0 && !lastUpdated) refreshPrices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions.length]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!autoRefresh || document.hidden || refreshingRef.current || positions.length === 0) return;
      refreshPrices();
    }, 60000);
    return () => window.clearInterval(id);
  }, [autoRefresh, positions.length, refreshPrices]);

  const fx = quotes?.fx ?? DEFAULT_FX;

  const allLive = positions.length > 0 && positions.every((p) => livePrice(p, quotes) !== null);

  const positionsValueCad = useMemo(
    () =>
      positions.reduce((sum, p) => {
        const live = livePrice(p, quotes) ?? p.avg_cost;
        return sum + toCad(p.qty * live, p.currency, fx);
      }, 0),
    [positions, quotes, fx]
  );

  const cashCad = useMemo(() => {
    let total = 0;
    for (const acct of Object.values(cashBalance)) {
      for (const [ccy, amt] of Object.entries(acct)) total += toCad(amt, ccy, fx);
    }
    return total;
  }, [cashBalance, fx]);

  const totalAssetsCad = positionsValueCad + cashCad;
  const cashRatio = totalAssetsCad > 0 ? (cashCad / totalAssetsCad) * 100 : null;

  const floatingPnlCad = useMemo(
    () =>
      positions.reduce((sum, p) => {
        const live = livePrice(p, quotes);
        if (live === null) return sum;
        return sum + toCad((live - p.avg_cost) * p.qty, p.currency, fx);
      }, 0),
    [positions, quotes, fx]
  );

  const realizedPnlCad = useMemo(() => {
    if (!summary) return 0;
    return Object.entries(summary.realizedByCcy).reduce((sum, [ccy, v]) => sum + toCad(v, ccy, fx), 0);
  }, [summary, fx]);

  const totalPnlCad = floatingPnlCad + realizedPnlCad;

  const todayStr = todayLocalDate();
  const todayTrades = useMemo(
    () => (data ? data.trades.filter((t) => t.date === todayStr) : []),
    [data, todayStr]
  );

  const tickers = useMemo(
    () => (data ? [...new Set(data.trades.map((t) => t.ticker))].sort() : []),
    [data]
  );

  const filteredTrades = useMemo(() => {
    if (!data) return [];
    return data.trades
      .filter((t) => (account === "all" || t.account === account) && (ticker === "all" || t.ticker === ticker))
      .slice()
      .reverse();
  }, [data, account, ticker]);

  // ---------- 买卖 ----------

  function openTrade(side: "buy" | "sell") {
    setTradeSide(side);
    setEditingTrade(null);
    setTradeForm(emptyTradeForm());
    setTradeError("");
    setTradeOpen(true);
  }

  function openEditTrade(t: StockTrade) {
    setTradeSide(t.side);
    setEditingTrade(t);
    setTradeForm({
      ticker: t.ticker,
      qty: String(t.qty),
      price: String(t.price),
      currency: (t.currency as Currency) ?? "USD",
      account: (t.account as Account) ?? "TFSA",
      initialStop: t.initial_stop !== null ? String(t.initial_stop) : "",
      ts: toLocalInputValue(t.ts ? new Date(t.ts) : new Date(t.date)),
      note: t.note ?? "",
      positionKey: "",
    });
    setTradeError("");
    setTradeOpen(true);
  }

  function onPositionSelected(key: string) {
    const p = positions.find((x) => `${x.ticker}|${x.currency}|${x.account}` === key);
    if (!p) {
      setTradeForm((f) => ({ ...f, positionKey: key }));
      return;
    }
    const live = livePrice(p, quotes);
    setTradeForm((f) => ({
      ...f,
      positionKey: key,
      ticker: p.ticker,
      currency: p.currency as Currency,
      account: p.account as Account,
      qty: String(p.qty),
      price: String(live ?? p.avg_cost),
    }));
  }

  async function submitTrade(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    const qty = Number(tradeForm.qty);
    const price = Number(tradeForm.price);
    if (!tradeForm.ticker.trim() || !(qty > 0) || !(price > 0)) {
      setTradeError("请填写股票代码,数量和价格需大于 0");
      return;
    }
    setTradeSaving(true);
    setTradeError("");
    try {
      if (editingTrade) {
        await updateStockTrade(editingTrade.id, {
          ticker: tradeForm.ticker,
          side: tradeSide,
          qty,
          price,
          currency: tradeForm.currency,
          account: tradeForm.account,
          ts: new Date(tradeForm.ts).toISOString(),
          note: tradeForm.note,
          initial_stop: tradeSide === "buy" && tradeForm.initialStop ? Number(tradeForm.initialStop) : null,
          realized_pnl: tradeSide === "sell" ? editingTrade.realized_pnl : null,
        });
      } else {
        let realizedPnl: number | null = null;
        let warning: string | undefined;
        if (tradeSide === "sell") {
          const pos = positions.find(
            (p) => p.ticker === tradeForm.ticker.toUpperCase() && p.currency === tradeForm.currency && p.account === tradeForm.account
          );
          const settled = matchSell(pos, qty, price, 0);
          realizedPnl = settled.realized_pnl;
          warning = settled.warning;
        }
        await insertStockTrade(
          {
            ticker: tradeForm.ticker,
            side: tradeSide,
            qty,
            price,
            currency: tradeForm.currency,
            account: tradeForm.account,
            ts: new Date(tradeForm.ts).toISOString(),
            note: tradeForm.note,
            initial_stop: tradeSide === "buy" && tradeForm.initialStop ? Number(tradeForm.initialStop) : null,
            realized_pnl: realizedPnl,
          },
          session.user.id
        );
        if (warning) window.alert(`⚠️ ${warning}`);
      }
      setTradeOpen(false);
      setEditingTrade(null);
      await reloadData();
      refreshPrices();
    } catch (err) {
      setTradeError(String((err as Error).message ?? err));
    } finally {
      setTradeSaving(false);
    }
  }

  async function handleDeleteTrade(id: string) {
    if (!window.confirm("确定删除这笔交易记录?")) return;
    try {
      await deleteStockTrade(id);
      await reloadData();
    } catch (e) {
      window.alert(`删除失败: ${String((e as Error).message ?? e)}`);
    }
  }

  // ---------- 出入金 ----------

  function openCash(type: "deposit" | "withdraw") {
    setCashType(type);
    setCashForm(emptyCashForm());
    setCashError("");
    setCashOpen(true);
  }

  async function submitCash(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    const amount = Number(cashForm.amount);
    if (!(amount > 0)) {
      setCashError("金额需大于 0");
      return;
    }
    setCashSaving(true);
    setCashError("");
    try {
      await insertStockCash(
        {
          type: cashType,
          amount,
          currency: cashForm.currency,
          account: cashForm.account,
          ts: new Date(cashForm.ts).toISOString(),
          note: cashForm.note,
        },
        session.user.id
      );
      setCashOpen(false);
      await reloadData();
    } catch (err) {
      setCashError(String((err as Error).message ?? err));
    } finally {
      setCashSaving(false);
    }
  }

  async function handleDeleteCash(id: string) {
    if (!window.confirm("确定删除这条出入金记录?")) return;
    try {
      await deleteStockCash(id);
      await reloadData();
    } catch (e) {
      window.alert(`删除失败: ${String((e as Error).message ?? e)}`);
    }
  }

  const dialogContentStyle = {
    background: "#0a0e1c",
    border: "1px solid rgba(139,92,246,0.3)",
    color: TEXT,
  };

  return (
    <div className="min-h-screen" style={{ background: "#060a14", fontFamily: "'Inter', sans-serif" }}>
      <DashboardNavbar sub="SYS/ASSETS · STOCK" />
      <main className="pt-24 pb-16 px-6 lg:px-10 max-w-6xl mx-auto space-y-6">
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs transition-colors hover:text-violet-300"
          style={{ ...mono, color: SUB }}
        >
          <ArrowLeft size={13} />
          返回日历
        </Link>

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
            LOADING RECORDS...
          </div>
        )}

        {data && summary && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-2xl font-black text-white" style={display}>
                股票交易记录
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => openTrade("buy")}
                  style={{ ...actionBtn, background: "#16a34a", color: "#fff" }}
                >
                  + 买入
                </button>
                <button
                  onClick={() => openTrade("sell")}
                  style={{ ...actionBtn, background: "#dc2626", color: "#fff" }}
                >
                  − 卖出
                </button>
                <button
                  onClick={() => openCash("deposit")}
                  style={{ ...actionBtn, background: "#d97706", color: "#fff" }}
                >
                  ⊕ 入账
                </button>
                <button
                  onClick={() => openCash("withdraw")}
                  style={{ ...actionBtn, background: "rgba(139,92,246,0.12)", color: SUB, border: "1px solid rgba(139,92,246,0.25)" }}
                >
                  ⊖ 出账
                </button>
                <button
                  onClick={refreshPrices}
                  disabled={refreshing || positions.length === 0}
                  style={{
                    ...actionBtn,
                    background: "#2563eb",
                    color: "#fff",
                    opacity: refreshing || positions.length === 0 ? 0.6 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
                  刷新价格
                </button>
                <label className="flex items-center gap-1.5 text-[11px]" style={{ ...mono, color: SUB }}>
                  <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
                  每分钟自动刷新
                </label>
                {lastUpdated && (
                  <span className="text-[11px]" style={{ ...mono, color: MUTED }}>
                    已更新 {lastUpdated.toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                )}
              </div>
            </div>

            {/* 统计卡 */}
            <div className="flex flex-wrap gap-3">
              <StatCard
                label="总资产 (CAD)"
                value={fmtCad(totalAssetsCad)}
                sub={
                  `股票市值 ${fmtCad(positionsValueCad)} · 现金 ${fmtCad(cashCad)}` +
                  (allLive ? "" : "\n(部分持仓价格未刷新)")
                }
              />
              <StatCard
                label="总盈亏 (CAD)"
                value={fmtCad(totalPnlCad, { sign: true })}
                color={netColor(totalPnlCad)}
                sub={`浮动 ${fmtCad(floatingPnlCad, { sign: true })} · 已实现 ${fmtCad(realizedPnlCad, { sign: true })}`}
              />
              <StatCard
                label="现金 (CAD)"
                value={fmtCad(cashCad)}
                sub={cashRatio !== null ? `占比 ${cashRatio.toFixed(1)}%` : undefined}
              />
              <StatCard
                label="胜率"
                value={summary.sellCount ? `${summary.winRate.toFixed(1)}%` : "–"}
                color={summary.sellCount ? (summary.winRate >= 50 ? POS : NEG) : undefined}
                sub={`${summary.winCount}/${summary.sellCount} 笔平仓`}
              />
            </div>
            <div className="text-[11px]" style={{ ...mono, color: MUTED }}>
              汇率 (USD→CAD): 1 USD = C${fx.toFixed(4)}
            </div>

            {/* 当前持仓 */}
            <div className="rounded-xl p-5" style={box}>
              <div className="text-sm font-bold text-white mb-3" style={display}>
                当前持仓 ({positions.length})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(139,92,246,0.18)" }}>
                      {["代码", "账户", "币种", "数量", "均价", "现价"].map((h) => (
                        <th key={h} className={th} style={{ ...mono, color: MUTED }}>
                          {h}
                        </th>
                      ))}
                      <th className={th} style={{ ...mono, color: MUTED }} title={MOM_TOOLTIP}>
                        动量止损 ⓘ
                      </th>
                      {["今日盈亏", "持仓盈亏", "市值"].map((h) => (
                        <th key={h} className={th} style={{ ...mono, color: MUTED }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => {
                      const live = livePrice(p, quotes);
                      const pc = prevClose(p, quotes);
                      const { dayPnl, dayPct } = computeDayPnl(p, live, pc, todayTrades);
                      const posPnl = live !== null ? (live - p.avg_cost) * p.qty : null;
                      const posPct = live !== null && p.avg_cost > 0 ? ((live - p.avg_cost) / p.avg_cost) * 100 : null;
                      const value = live !== null ? live * p.qty : null;
                      return (
                        <tr key={`${p.ticker}-${p.currency}-${p.account}`} style={{ borderBottom: "1px solid rgba(139,92,246,0.07)" }}>
                          <td className={td} style={{ ...mono, color: TEXT, fontWeight: 600 }}>{p.ticker}</td>
                          <td className={td}>
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{ ...mono, background: "rgba(139,92,246,0.12)", color: "#a78bfa" }}
                            >
                              {p.account === "NON-REG" ? "NR" : p.account}
                            </span>
                          </td>
                          <td className={td} style={{ ...mono, color: SUB }}>{p.currency}</td>
                          <td className={td} style={{ ...mono, color: TEXT }}>{p.qty}</td>
                          <td className={td} style={{ ...mono, color: TEXT }}>{p.avg_cost.toFixed(2)}</td>
                          <td className={td} style={{ ...mono, color: TEXT }}>{live !== null ? live.toFixed(2) : "--"}</td>
                          <td className={td}>
                            <MomCell position={p} info={stops[p.ticker]} />
                          </td>
                          <td className={td} style={{ ...mono, color: dayPnl !== null ? netColor(dayPnl) : MUTED }}>
                            {dayPnl !== null ? `${fmtCad(dayPnl, { sign: true })}${dayPct !== null ? ` (${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(1)}%)` : ""}` : "--"}
                          </td>
                          <td className={td} style={{ ...mono, color: posPnl !== null ? netColor(posPnl) : MUTED }}>
                            {posPnl !== null ? `${fmtCad(posPnl, { sign: true })}${posPct !== null ? ` (${posPct >= 0 ? "+" : ""}${posPct.toFixed(1)}%)` : ""}` : "--"}
                          </td>
                          <td className={td} style={{ ...mono, color: TEXT }}>{value !== null ? value.toFixed(2) : "--"}</td>
                        </tr>
                      );
                    })}
                    {positions.length === 0 && (
                      <tr>
                        <td colSpan={9} className="py-6 text-center text-xs" style={{ ...mono, color: MUTED }}>
                          空仓
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 交易历史 */}
            <div className="rounded-xl p-5" style={box}>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div className="text-sm font-bold text-white" style={display}>
                  交易历史 ({filteredTrades.length})
                </div>
                <div className="flex gap-2">
                  <select value={ticker} onChange={(e) => setTicker(e.target.value)} style={selectStyle}>
                    <option value="all">全部代码</option>
                    {tickers.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <select value={account} onChange={(e) => setAccount(e.target.value)} style={selectStyle}>
                    <option value="all">全部账户</option>
                    <option value="TFSA">TFSA</option>
                    <option value="NON-REG">NON-REG</option>
                  </select>
                </div>
              </div>
              <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(139,92,246,0.18)" }}>
                      {["日期", "方向", "代码", "数量", "价格", "币种", "账户", "已实现盈亏", ""].map((h) => (
                        <th key={h} className={th} style={{ ...mono, color: MUTED, position: "sticky", top: 0, background: "#0a0e1c" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrades.map((t: StockTrade) => (
                      <tr key={t.id} style={{ borderBottom: "1px solid rgba(139,92,246,0.07)" }}>
                        <td className={td} style={{ ...mono, color: SUB }}>{t.date}</td>
                        <td className={td} style={{ ...mono, color: t.side === "buy" ? POS : NEG, fontWeight: 600 }}>
                          {t.side === "buy" ? "买" : "卖"}
                        </td>
                        <td className={td} style={{ ...mono, color: TEXT, fontWeight: 600 }}>{t.ticker}</td>
                        <td className={td} style={{ ...mono, color: TEXT }}>{t.qty}</td>
                        <td className={td} style={{ ...mono, color: TEXT }}>{t.price.toLocaleString()}</td>
                        <td className={td} style={{ ...mono, color: SUB }}>{t.currency}</td>
                        <td className={td} style={{ ...mono, color: SUB }}>{t.account ?? "–"}</td>
                        <td className={td} style={{ ...mono, color: t.side === "sell" && t.realized_pnl !== null ? netColor(t.realized_pnl) : MUTED }}>
                          {t.side === "sell" && t.realized_pnl !== null ? fmtCad(t.realized_pnl, { sign: true }) : "–"}
                        </td>
                        <td className={td}>
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => openEditTrade(t)}
                              className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-violet-500/15"
                              style={{ ...mono, color: "#a78bfa", border: "1px solid rgba(139,92,246,0.3)" }}
                            >
                              编辑
                            </button>
                            <button
                              onClick={() => handleDeleteTrade(t.id)}
                              className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-red-500/15"
                              style={{ ...mono, color: NEG, border: "1px solid rgba(248,113,113,0.3)" }}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 现金记录 */}
            <div className="rounded-xl p-5" style={box}>
              <div className="text-sm font-bold text-white mb-3" style={display}>
                现金记录 ({data.cash.length})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(139,92,246,0.18)" }}>
                      {["日期", "类型", "金额", "币种", "账户", "备注", ""].map((h) => (
                        <th key={h} className={th} style={{ ...mono, color: MUTED }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.cash.slice().reverse().map((c) => (
                      <tr key={c.id} style={{ borderBottom: "1px solid rgba(139,92,246,0.07)" }}>
                        <td className={td} style={{ ...mono, color: SUB }}>{c.date}</td>
                        <td className={td} style={{ ...mono, color: c.type === "deposit" ? POS : NEG }}>
                          {c.type === "deposit" ? "入金" : "出金"}
                        </td>
                        <td className={td} style={{ ...mono, color: TEXT }}>{c.amount.toLocaleString()}</td>
                        <td className={td} style={{ ...mono, color: SUB }}>{c.currency}</td>
                        <td className={td} style={{ ...mono, color: SUB }}>{c.account ?? "–"}</td>
                        <td className={`${td} max-w-[240px] truncate`} style={{ ...mono, color: SUB }}>{c.note ?? ""}</td>
                        <td className={td}>
                          <button
                            onClick={() => handleDeleteCash(c.id)}
                            className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-red-500/15"
                            style={{ ...mono, color: NEG, border: "1px solid rgba(248,113,113,0.3)" }}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>

      {/* 买卖 Dialog */}
      <Dialog
        open={tradeOpen}
        onOpenChange={(open) => {
          setTradeOpen(open);
          if (!open) setEditingTrade(null);
        }}
      >
        <DialogContent style={dialogContentStyle}>
          <DialogHeader>
            <DialogTitle style={{ ...display, color: TEXT }}>
              {editingTrade ? "编辑交易" : tradeSide === "buy" ? "买入" : "卖出"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submitTrade} className="space-y-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTradeSide("buy")}
                className="flex-1 py-2 rounded text-xs font-bold"
                style={{ ...mono, background: tradeSide === "buy" ? "#16a34a" : "rgba(139,92,246,0.08)", color: tradeSide === "buy" ? "#fff" : SUB }}
              >
                买入
              </button>
              <button
                type="button"
                onClick={() => setTradeSide("sell")}
                className="flex-1 py-2 rounded text-xs font-bold"
                style={{ ...mono, background: tradeSide === "sell" ? "#dc2626" : "rgba(139,92,246,0.08)", color: tradeSide === "sell" ? "#fff" : SUB }}
              >
                卖出
              </button>
            </div>

            {tradeSide === "sell" && !editingTrade && (
              <div>
                <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>持仓选择</label>
                <select value={tradeForm.positionKey} onChange={(e) => onPositionSelected(e.target.value)} style={inputStyle}>
                  <option value="">-- 手动填写代码 --</option>
                  {positions.filter((p) => p.qty > 0).map((p) => {
                    const key = `${p.ticker}|${p.currency}|${p.account}`;
                    return (
                      <option key={key} value={key}>
                        {p.ticker} · {p.account} · {p.currency} · {p.qty}股 @ {p.avg_cost.toFixed(2)}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {(tradeSide === "buy" || !tradeForm.positionKey || editingTrade) && (
              <div>
                <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>股票代码</label>
                <input
                  style={inputStyle}
                  value={tradeForm.ticker}
                  onChange={(e) => setTradeForm((f) => ({ ...f, ticker: e.target.value.toUpperCase() }))}
                  placeholder="AAPL"
                  required
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>数量(股)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={tradeForm.qty}
                  onChange={(e) => setTradeForm((f) => ({ ...f, qty: e.target.value }))}
                  required
                />
              </div>
              <div>
                <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>价格</label>
                <input
                  type="number"
                  step="0.01"
                  style={inputStyle}
                  value={tradeForm.price}
                  onChange={(e) => setTradeForm((f) => ({ ...f, price: e.target.value }))}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>币种</label>
                <select
                  value={tradeForm.currency}
                  onChange={(e) => setTradeForm((f) => ({ ...f, currency: e.target.value as Currency }))}
                  style={inputStyle}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>账户</label>
                <select
                  value={tradeForm.account}
                  onChange={(e) => setTradeForm((f) => ({ ...f, account: e.target.value as Account }))}
                  style={inputStyle}
                >
                  {ACCOUNTS.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
            </div>

            {tradeSide === "buy" && (
              <div>
                <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>
                  开仓止损(可选,作为后续止损下限)
                </label>
                <input
                  type="number"
                  step="0.01"
                  style={inputStyle}
                  value={tradeForm.initialStop}
                  onChange={(e) => setTradeForm((f) => ({ ...f, initialStop: e.target.value }))}
                />
              </div>
            )}

            <div>
              <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>日期时间</label>
              <input
                type="datetime-local"
                style={inputStyle}
                value={tradeForm.ts}
                onChange={(e) => setTradeForm((f) => ({ ...f, ts: e.target.value }))}
                required
              />
            </div>

            <div>
              <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>备注</label>
              <input
                style={inputStyle}
                value={tradeForm.note}
                onChange={(e) => setTradeForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>

            {tradeError && (
              <div className="text-xs" style={{ ...mono, color: NEG }}>{tradeError}</div>
            )}

            <DialogFooter>
              <button
                type="submit"
                disabled={tradeSaving}
                className="w-full py-2.5 rounded text-sm font-bold"
                style={{
                  ...mono,
                  background: tradeSide === "buy" ? "#16a34a" : "#dc2626",
                  color: "#fff",
                  opacity: tradeSaving ? 0.6 : 1,
                }}
              >
                {tradeSaving ? "保存中..." : "保存"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 出入金 Dialog */}
      <Dialog open={cashOpen} onOpenChange={setCashOpen}>
        <DialogContent style={dialogContentStyle}>
          <DialogHeader>
            <DialogTitle style={{ ...display, color: TEXT }}>
              {cashType === "deposit" ? "入账(增加现金)" : "出账(减少现金)"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submitCash} className="space-y-3">
            <div>
              <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>金额</label>
              <input
                type="number"
                step="0.01"
                style={inputStyle}
                value={cashForm.amount}
                onChange={(e) => setCashForm((f) => ({ ...f, amount: e.target.value }))}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>币种</label>
                <select
                  value={cashForm.currency}
                  onChange={(e) => setCashForm((f) => ({ ...f, currency: e.target.value as Currency }))}
                  style={inputStyle}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>账户</label>
                <select
                  value={cashForm.account}
                  onChange={(e) => setCashForm((f) => ({ ...f, account: e.target.value as Account }))}
                  style={inputStyle}
                >
                  {ACCOUNTS.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>日期时间</label>
              <input
                type="datetime-local"
                style={inputStyle}
                value={cashForm.ts}
                onChange={(e) => setCashForm((f) => ({ ...f, ts: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>备注</label>
              <input
                style={inputStyle}
                value={cashForm.note}
                onChange={(e) => setCashForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>
            {cashError && <div className="text-xs" style={{ ...mono, color: NEG }}>{cashError}</div>}
            <DialogFooter>
              <button
                type="submit"
                disabled={cashSaving}
                className="w-full py-2.5 rounded text-sm font-bold"
                style={{ ...mono, background: "#d97706", color: "#fff", opacity: cashSaving ? 0.6 : 1 }}
              >
                {cashSaving ? "保存中..." : "保存"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
