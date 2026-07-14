import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, RefreshCw } from "lucide-react";
import DashboardNavbar from "./DashboardNavbar";
import {
  fetchDashboardData,
  fmtCad,
  type DashboardData,
  type StockTrade,
} from "@/app/lib/dashboardData";

const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Exo 2', sans-serif" };

const POS = "#34d399";
const NEG = "#f87171";
const MUTED = "#4a5568";
const TEXT = "#e2e8f4";
const SUB = "#6b7fa8";

const box = { background: "rgba(10,14,28,0.82)", border: "1px solid rgba(139,92,246,0.18)" };
const netColor = (n: number) => (n > 0 ? POS : n < 0 ? NEG : MUTED);

function StatCard(props: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="rounded-xl px-5 py-4 flex-1 min-w-[150px]" style={box}>
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

export default function StockRecordsPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string>("all");
  const [ticker, setTicker] = useState<string>("all");

  useEffect(() => {
    fetchDashboardData().then(setData).catch((e) => setError(String(e.message ?? e)));
  }, []);

  const latest = data?.snapshots[data.snapshots.length - 1] ?? null;

  const stats = useMemo(() => {
    if (!data) return null;
    const pnlByCcy: Record<string, number> = {};
    let wins = 0;
    let closed = 0;
    for (const t of data.trades) {
      if (t.side !== "sell" || t.realized_pnl === null) continue;
      closed++;
      if (t.realized_pnl > 0) wins++;
      pnlByCcy[t.currency] = (pnlByCcy[t.currency] ?? 0) + t.realized_pnl;
    }
    return { pnlByCcy, wins, closed };
  }, [data]);

  const tickers = useMemo(
    () => (data ? [...new Set(data.trades.map((t) => t.ticker))].sort() : []),
    [data]
  );

  const filteredTrades = useMemo(() => {
    if (!data) return [];
    return data.trades
      .filter((t) => (account === "all" || t.account === account) && (ticker === "all" || t.ticker === ticker))
      .slice()
      .reverse(); // 最新在前
  }, [data, account, ticker]);

  const positions = useMemo(() => {
    if (!latest?.positions) return [];
    const fx = latest.fx_usdcad ?? 1.37;
    return latest.positions
      .map((p) => ({ ...p, valueCad: p.qty * p.price * (p.currency === "CAD" ? 1 : fx) }))
      .sort((a, b) => b.valueCad - a.valueCad);
  }, [latest]);

  const posTotal = positions.reduce((s, p) => s + p.valueCad, 0);

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

        {data && stats && (
          <>
            <h1 className="text-2xl font-black text-white" style={display}>
              股票记录
            </h1>

            {/* 统计卡 */}
            <div className="flex flex-wrap gap-3">
              <StatCard
                label="组合市值 (CAD)"
                value={latest ? fmtCad(latest.value_cad) : "–"}
                sub={latest ? `截至 ${latest.date} · FX ${latest.fx_usdcad ?? "–"}` : undefined}
              />
              <StatCard
                label="现金 (CAD)"
                value={latest?.cash_cad !== null && latest ? fmtCad(latest.cash_cad!) : "–"}
              />
              <StatCard
                label="已实现盈亏"
                value={Object.entries(stats.pnlByCcy)
                  .map(([c, v]) => `${fmtCad(v, { sign: true })} ${c}`)
                  .join("  ")}
                color={netColor(Object.values(stats.pnlByCcy).reduce((a, b) => a + b, 0))}
              />
              <StatCard
                label="胜率"
                value={stats.closed ? `${((stats.wins / stats.closed) * 100).toFixed(1)}%` : "–"}
                sub={`${stats.wins}/${stats.closed} 笔平仓`}
              />
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
                      {["代码", "数量", "收盘价", "币种", "市值 (CAD)", "占比"].map((h) => (
                        <th key={h} className={th} style={{ ...mono, color: MUTED }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => (
                      <tr key={`${p.ticker}-${p.currency}`} style={{ borderBottom: "1px solid rgba(139,92,246,0.07)" }}>
                        <td className={td} style={{ ...mono, color: TEXT, fontWeight: 600 }}>{p.ticker}</td>
                        <td className={td} style={{ ...mono, color: TEXT }}>{p.qty}</td>
                        <td className={td} style={{ ...mono, color: TEXT }}>{p.price.toLocaleString()}</td>
                        <td className={td} style={{ ...mono, color: SUB }}>{p.currency}</td>
                        <td className={td} style={{ ...mono, color: TEXT }}>{fmtCad(p.valueCad)}</td>
                        <td className={td} style={{ ...mono, color: SUB }}>
                          {posTotal ? `${((p.valueCad / posTotal) * 100).toFixed(1)}%` : "–"}
                        </td>
                      </tr>
                    ))}
                    {positions.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-xs" style={{ ...mono, color: MUTED }}>
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
                      {["日期", "方向", "代码", "数量", "价格", "币种", "账户", "已实现盈亏"].map((h) => (
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
                      {["日期", "类型", "金额", "币种", "账户", "备注"].map((h) => (
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
