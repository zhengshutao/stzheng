import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
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
import { fetchDashboardData, fmtCad, type DailyTx, type DashboardData } from "@/app/lib/dashboardData";
import { deleteDailyTx, insertDailyTx, updateDailyTx } from "@/app/lib/dailyApi";

const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Exo 2', sans-serif" };

const POS = "#34d399";
const NEG = "#f87171";
const MUTED = "#4a5568";
const TEXT = "#e2e8f4";
const SUB = "#6b7fa8";

const box = { background: "rgba(10,14,28,0.82)", border: "1px solid rgba(139,92,246,0.18)" };
const netColor = (n: number) => (n > 0 ? POS : n < 0 ? NEG : MUTED);

const CAT_ZH: Record<string, string> = {
  FOOD_AND_DRINK: "餐饮",
  GENERAL_MERCHANDISE: "购物",
  TRANSPORTATION: "交通",
  TRAVEL: "旅行",
  RENT_AND_UTILITIES: "房租水电",
  ENTERTAINMENT: "娱乐",
  PERSONAL_CARE: "个人护理",
  GENERAL_SERVICES: "服务",
  MEDICAL: "医疗",
  HOME_IMPROVEMENT: "家居",
  LOAN_PAYMENTS: "还款",
  BANK_FEES: "银行手续费",
  GOVERNMENT_AND_NON_PROFIT: "政府/公益",
  TRANSFER_OUT: "转出",
  TRANSFER_IN: "转入",
  INCOME: "收入",
  OTHER: "其他",
};
const catName = (c: string | null) => (c ? CAT_ZH[c] ?? c : "其他");

type RangeKey = "all" | "this-month" | "last-month" | "7d" | "30d" | "ytd";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "this-month", label: "本月" },
  { key: "last-month", label: "上月" },
  { key: "7d", label: "最近 7 天" },
  { key: "30d", label: "最近 30 天" },
  { key: "ytd", label: "今年" },
];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rangeDates(key: RangeKey): { from: string | null; to: string | null } {
  const now = new Date();
  if (key === "all") return { from: null, to: null };
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  if (key === "this-month") return { from: iso(startOfMonth), to: iso(now) };
  if (key === "last-month") {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: iso(s), to: iso(e) };
  }
  if (key === "7d") {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    return { from: iso(s), to: iso(now) };
  }
  if (key === "30d") {
    const s = new Date(now);
    s.setDate(s.getDate() - 29);
    return { from: iso(s), to: iso(now) };
  }
  return { from: `${now.getFullYear()}-01-01`, to: iso(now) };
}

function todayLocalDate(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

const th = "text-left text-[10px] tracking-widest py-2 px-3";
const td = "py-2 px-3 text-xs";

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

const inputStyle = { ...selectStyle, width: "100%" };

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

function CategoryBars({ txns }: { txns: DailyTx[] }) {
  const rows = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const t of txns) {
      if (t.is_transfer || t.amount <= 0) continue;
      const key = catName(t.category);
      byCat.set(key, (byCat.get(key) ?? 0) + t.amount);
    }
    return [...byCat.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
  }, [txns]);

  if (rows.length === 0) {
    return (
      <div className="text-xs py-6 text-center" style={{ ...mono, color: MUTED }}>
        此时间段暂无支出
      </div>
    );
  }

  const max = Math.max(...rows.map((r) => r.total));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.category} className="flex items-center gap-3 text-xs">
          <div className="w-24 shrink-0 truncate" style={{ ...mono, color: SUB }} title={r.category}>
            {r.category}
          </div>
          <div className="flex-1 h-4 relative rounded overflow-hidden" style={{ background: "rgba(139,92,246,0.06)" }}>
            <div
              className="h-4 rounded"
              style={{ width: `${Math.max(1, (100 * r.total) / max)}%`, background: "linear-gradient(90deg,#8b5cf6,#7c3aed)" }}
            />
          </div>
          <div className="w-24 shrink-0 text-right" style={{ ...mono, color: TEXT }}>
            {fmtCad(r.total)}
          </div>
        </div>
      ))}
    </div>
  );
}

type TxType = "expense" | "income";

interface TxForm {
  date: string;
  merchant: string;
  amount: string;
  category: string;
  note: string;
  notCounted: boolean;
}

function emptyTxForm(): TxForm {
  return { date: todayLocalDate(), merchant: "", amount: "", category: "", note: "", notCounted: false };
}

export default function DailyRecordsPage() {
  const { session } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("this-month");
  const [search, setSearch] = useState("");

  const [txOpen, setTxOpen] = useState(false);
  const [txType, setTxType] = useState<TxType>("expense");
  const [txForm, setTxForm] = useState<TxForm>(emptyTxForm());
  const [txError, setTxError] = useState("");
  const [txSaving, setTxSaving] = useState(false);
  const [editingTx, setEditingTx] = useState<DailyTx | null>(null);

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

  const { from, to } = rangeDates(range);

  const rangedTxns = useMemo(() => {
    if (!data) return [];
    return data.transactions.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
  }, [data, from, to]);

  const filteredTxns = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = q
      ? rangedTxns.filter((t) => (t.merchant ?? t.name ?? "").toLowerCase().includes(q))
      : rangedTxns;
    return rows.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [rangedTxns, search]);

  const totals = useMemo(() => {
    let spent = 0;
    let received = 0;
    let count = 0;
    for (const t of rangedTxns) {
      if (t.is_transfer) continue;
      count++;
      if (t.amount > 0) spent += t.amount;
      else received += -t.amount;
    }
    return { spent, received, net: received - spent, count };
  }, [rangedTxns]);

  const dayCount =
    from && to ? Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1) : null;

  // ---------- 手动新增 / 编辑 ----------

  function openAdd() {
    setEditingTx(null);
    setTxType("expense");
    setTxForm(emptyTxForm());
    setTxError("");
    setTxOpen(true);
  }

  function openEdit(t: DailyTx) {
    setEditingTx(t);
    setTxType(t.amount > 0 ? "expense" : "income");
    setTxForm({
      date: t.date,
      merchant: t.merchant ?? t.name ?? "",
      amount: String(Math.abs(t.amount)),
      category: t.category ?? "",
      note: t.note ?? "",
      notCounted: t.is_transfer,
    });
    setTxError("");
    setTxOpen(true);
  }

  const editingLocked = editingTx !== null && editingTx.source !== "manual";

  async function submitTx(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    const rawAmount = Number(txForm.amount);
    if (!editingLocked && (!txForm.merchant.trim() || !(rawAmount > 0))) {
      setTxError("请填写商家/说明,以及大于 0 的金额");
      return;
    }
    setTxSaving(true);
    setTxError("");
    try {
      if (editingTx) {
        if (editingLocked) {
          await updateDailyTx(editingTx.id, { note: txForm.note, is_transfer: txForm.notCounted });
        } else {
          await updateDailyTx(editingTx.id, {
            date: txForm.date,
            merchant: txForm.merchant,
            amount: txType === "expense" ? rawAmount : -rawAmount,
            category: txForm.category || null,
            note: txForm.note,
            is_transfer: txForm.notCounted,
          });
        }
      } else {
        await insertDailyTx(
          {
            date: txForm.date,
            merchant: txForm.merchant,
            amount: txType === "expense" ? rawAmount : -rawAmount,
            category: txForm.category || null,
            note: txForm.note,
            is_transfer: txForm.notCounted,
          },
          session.user.id
        );
      }
      setTxOpen(false);
      setEditingTx(null);
      await reloadData();
    } catch (err) {
      setTxError(String((err as Error).message ?? err));
    } finally {
      setTxSaving(false);
    }
  }

  async function handleDeleteTx(id: string) {
    if (!window.confirm("确定删除这笔手动记录?")) return;
    try {
      await deleteDailyTx(id);
      await reloadData();
    } catch (e) {
      window.alert(`删除失败: ${String((e as Error).message ?? e)}`);
    }
  }

  async function toggleNotCounted(t: DailyTx, checked: boolean) {
    try {
      await updateDailyTx(t.id, { is_transfer: checked });
      await reloadData();
    } catch (e) {
      window.alert(`更新失败: ${String((e as Error).message ?? e)}`);
    }
  }

  const dialogContentStyle = {
    background: "#0a0e1c",
    border: "1px solid rgba(139,92,246,0.3)",
    color: TEXT,
  };

  return (
    <div className="min-h-screen" style={{ background: "#060a14", fontFamily: "'Inter', sans-serif" }}>
      <DashboardNavbar sub="SYS/ASSETS · DAILY" />
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

        {data && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-2xl font-black text-white" style={display}>
                日常收支记录
              </h1>
              <div className="flex flex-wrap gap-2">
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setRange(r.key)}
                    className="px-3 py-1.5 rounded-full text-xs font-semibold transition-all"
                    style={{
                      ...mono,
                      color: range === r.key ? "#fff" : SUB,
                      background: range === r.key ? "linear-gradient(135deg,#8b5cf6,#7c3aed)" : "rgba(139,92,246,0.08)",
                      border: range === r.key ? "1px solid transparent" : "1px solid rgba(139,92,246,0.2)",
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <StatCard label="总支出" value={fmtCad(totals.spent)} />
              <StatCard label="入账 / 退款" value={fmtCad(totals.received)} />
              <StatCard label="净收支" value={fmtCad(totals.net, { sign: true })} color={netColor(totals.net)} />
              <StatCard label="交易笔数" value={totals.count.toLocaleString()} />
              <StatCard label="日均支出" value={fmtCad(dayCount ? totals.spent / dayCount : 0)} />
            </div>

            <div className="rounded-xl p-5" style={box}>
              <div className="text-sm font-bold text-white mb-3" style={display}>
                按类别
              </div>
              <CategoryBars txns={rangedTxns} />
            </div>

            <div className="rounded-xl p-5" style={box}>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div className="text-sm font-bold text-white" style={display}>
                  交易明细 ({filteredTxns.length})
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索商家…"
                    style={{ ...selectStyle, width: 200 }}
                  />
                  <button onClick={openAdd} style={{ ...actionBtn, background: "#16a34a", color: "#fff" }}>
                    + 手动添加
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(139,92,246,0.18)" }}>
                      {["日期", "商家 / 备注", "类别", "金额", "不记录", ""].map((h) => (
                        <th
                          key={h}
                          className={th}
                          style={{ ...mono, color: MUTED, position: "sticky", top: 0, background: "#0a0e1c" }}
                          title={h === "不记录" ? "勾选后不计入收支统计(比如内部转账/无关记录)" : undefined}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTxns.map((t) => (
                      <tr key={t.id} style={{ borderBottom: "1px solid rgba(139,92,246,0.07)" }}>
                        <td className={td} style={{ ...mono, color: SUB, whiteSpace: "nowrap" }}>
                          {t.date}
                        </td>
                        <td className={td}>
                          <div style={{ ...mono, color: t.is_transfer ? MUTED : TEXT }}>
                            {t.merchant || t.name || "–"}
                            {t.pending && (
                              <span
                                className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded"
                                style={{ ...mono, color: MUTED, border: "1px solid rgba(139,92,246,0.2)" }}
                              >
                                待入账
                              </span>
                            )}
                          </div>
                          {t.note && (
                            <div className="text-[10px] mt-0.5" style={{ ...mono, color: SUB }}>
                              {t.note}
                            </div>
                          )}
                        </td>
                        <td className={td} style={{ ...mono, color: SUB }}>
                          {catName(t.category)}
                        </td>
                        <td
                          className={td}
                          style={{ ...mono, color: t.is_transfer ? MUTED : t.amount > 0 ? TEXT : POS, fontWeight: 600 }}
                        >
                          {t.amount > 0 ? "-" : "+"}
                          {fmtCad(Math.abs(t.amount))}
                        </td>
                        <td className={`${td} text-center`}>
                          <input
                            type="checkbox"
                            checked={t.is_transfer}
                            onChange={(e) => toggleNotCounted(t, e.target.checked)}
                            title="不计入收支统计"
                          />
                        </td>
                        <td className={td}>
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => openEdit(t)}
                              className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-violet-500/15"
                              style={{ ...mono, color: "#a78bfa", border: "1px solid rgba(139,92,246,0.3)" }}
                            >
                              编辑
                            </button>
                            {t.source === "manual" && (
                              <button
                                onClick={() => handleDeleteTx(t.id)}
                                className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-red-500/15"
                                style={{ ...mono, color: NEG, border: "1px solid rgba(248,113,113,0.3)" }}
                              >
                                删除
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredTxns.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-xs" style={{ ...mono, color: MUTED }}>
                          此时间段暂无交易
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>

      {/* 新增 / 编辑 Dialog */}
      <Dialog
        open={txOpen}
        onOpenChange={(open) => {
          setTxOpen(open);
          if (!open) setEditingTx(null);
        }}
      >
        <DialogContent style={dialogContentStyle}>
          <DialogHeader>
            <DialogTitle style={{ ...display, color: TEXT }}>
              {editingTx ? "编辑记录" : "手动添加一笔"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submitTx} className="space-y-3">
            {editingLocked && (
              <div className="text-[11px]" style={{ ...mono, color: MUTED }}>
                银行同步的记录只能编辑备注和"不记录"标记
              </div>
            )}

            {!editingLocked && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setTxType("expense")}
                  className="flex-1 py-2 rounded text-xs font-bold"
                  style={{ ...mono, background: txType === "expense" ? "#dc2626" : "rgba(139,92,246,0.08)", color: txType === "expense" ? "#fff" : SUB }}
                >
                  支出
                </button>
                <button
                  type="button"
                  onClick={() => setTxType("income")}
                  className="flex-1 py-2 rounded text-xs font-bold"
                  style={{ ...mono, background: txType === "income" ? "#16a34a" : "rgba(139,92,246,0.08)", color: txType === "income" ? "#fff" : SUB }}
                >
                  收入
                </button>
              </div>
            )}

            {!editingLocked && (
              <>
                <div>
                  <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>日期</label>
                  <input
                    type="date"
                    style={inputStyle}
                    value={txForm.date}
                    onChange={(e) => setTxForm((f) => ({ ...f, date: e.target.value }))}
                    required
                  />
                </div>
                <div>
                  <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>商家 / 说明</label>
                  <input
                    style={inputStyle}
                    value={txForm.merchant}
                    onChange={(e) => setTxForm((f) => ({ ...f, merchant: e.target.value }))}
                    placeholder="比如: 现金买菜"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>金额</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      style={inputStyle}
                      value={txForm.amount}
                      onChange={(e) => setTxForm((f) => ({ ...f, amount: e.target.value }))}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>类别</label>
                    <select
                      style={inputStyle}
                      value={txForm.category}
                      onChange={(e) => setTxForm((f) => ({ ...f, category: e.target.value }))}
                    >
                      <option value="">未分类</option>
                      {Object.entries(CAT_ZH).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </>
            )}

            <div>
              <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>备注(可选)</label>
              <input
                style={inputStyle}
                value={txForm.note}
                onChange={(e) => setTxForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>

            <label className="flex items-center gap-2 text-xs" style={{ ...mono, color: SUB }}>
              <input
                type="checkbox"
                checked={txForm.notCounted}
                onChange={(e) => setTxForm((f) => ({ ...f, notCounted: e.target.checked }))}
              />
              不记录(不计入收支统计)
            </label>

            {txError && <div className="text-xs" style={{ ...mono, color: NEG }}>{txError}</div>}

            <DialogFooter>
              <button
                type="submit"
                disabled={txSaving}
                className="w-full py-2.5 rounded text-sm font-bold"
                style={{
                  ...mono,
                  background: !editingLocked && txType === "income" ? "#16a34a" : "#8b5cf6",
                  color: "#fff",
                  opacity: txSaving ? 0.6 : 1,
                }}
              >
                {txSaving ? "保存中..." : "保存"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
