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
import { fetchDashboardData, fmtCad, mergeGroupedTxns, type DailyTx, type DashboardData } from "@/app/lib/dashboardData";
import { deleteDailyTx, insertDailyTx, mergeDailyTx, unmergeDailyTx, updateDailyTx } from "@/app/lib/dailyApi";
import {
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  listBankItems,
  removeBankItem,
  type BankItem,
} from "@/app/lib/bankApi";
import { openPlaidLink } from "@/app/lib/plaidLink";

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
  VEHICLE: "车子",
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

const BANK_ABBR = ["WS", "Sco", "Rog", "CIBC", "CT"];

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
  return new Intl.DateTimeFormat("en-CA").format(d);
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
  bank: string;
}

function emptyTxForm(): TxForm {
  return { date: todayLocalDate(), merchant: "", amount: "", category: "", note: "", notCounted: false, bank: "" };
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

  const [bankItems, setBankItems] = useState<BankItem[]>([]);
  const [bankPanelOpen, setBankPanelOpen] = useState(false);
  const [bankError, setBankError] = useState("");
  const [linking, setLinking] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const reloadData = useCallback(async () => {
    try {
      const d = await fetchDashboardData();
      setData(d);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  const reloadBanks = useCallback(async () => {
    try {
      setBankItems(await listBankItems());
    } catch (e) {
      setBankError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    reloadData();
    reloadBanks();
  }, [reloadData, reloadBanks]);

  async function connectBank() {
    setLinking(true);
    setBankError("");
    try {
      const token = await createPlaidLinkToken();
      await openPlaidLink(
        token,
        (publicToken, institution) => {
          exchangePlaidPublicToken(publicToken, institution)
            .then(async () => {
              await reloadBanks();
              // 首次同步在后台跑,给它几秒再刷新交易列表
              setTimeout(reloadData, 3000);
            })
            .catch((e) => setBankError(String((e as Error).message ?? e)))
            .finally(() => setLinking(false));
        },
        (plaidError, metadata) => {
          setLinking(false);
          if (!plaidError) return;
          const parts = [
            plaidError.error_code,
            plaidError.error_message,
            plaidError.display_message,
            metadata.status ? `status=${metadata.status}` : null,
            metadata.link_session_id ? `link_session_id=${metadata.link_session_id}` : null,
            metadata.request_id ? `request_id=${metadata.request_id}` : null,
          ].filter(Boolean);
          setBankError(`Plaid 连接失败: ${parts.join(" · ")}`);
        }
      );
    } catch (e) {
      setBankError(String((e as Error).message ?? e));
      setLinking(false);
    }
  }

  async function handleRemoveBank(itemId: string) {
    if (!window.confirm("确定移除这家银行的连接?已同步的历史交易记录不会被删除。")) return;
    try {
      await removeBankItem(itemId);
      await reloadBanks();
    } catch (e) {
      window.alert(`移除失败: ${String((e as Error).message ?? e)}`);
    }
  }

  const { from, to } = rangeDates(range);

  // 把共享 merge_group_id 的原始记录收起来显示成一条净额壳子;原始记录本身不受影响
  const mergedTxns = useMemo(() => (data ? mergeGroupedTxns(data.transactions) : []), [data]);

  const rangedTxns = useMemo(() => {
    return mergedTxns.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
  }, [mergedTxns, from, to]);

  const filteredTxns = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = q
      ? rangedTxns.filter((t) => (t.merchant ?? t.name ?? "").toLowerCase().includes(q))
      : rangedTxns;
    return rows.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [rangedTxns, search]);

  // ---------- 合并记录(壳子) ----------

  function toggleSelect(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const selectedNet = useMemo(() => {
    let sum = 0;
    for (const t of mergedTxns) if (selectedIds.has(t.id)) sum += t.amount;
    return sum;
  }, [mergedTxns, selectedIds]);

  async function handleMergeSelected() {
    if (selectedIds.size < 2) return;
    const ids = [...selectedIds];
    const verb = selectedNet >= 0 ? "支出" : "收入";
    if (
      !window.confirm(
        `合并这 ${ids.length} 条记录?原始记录不会被改动,只是在列表里合成一条净额 ${fmtCad(Math.abs(selectedNet))} 的${verb},随时可以拆开。`
      )
    )
      return;
    try {
      await mergeDailyTx(ids);
      setSelectedIds(new Set());
      await reloadData();
    } catch (e) {
      window.alert(`合并失败: ${String((e as Error).message ?? e)}`);
    }
  }

  async function handleUnmerge(groupId: string) {
    if (!window.confirm("拆开这条合并记录?原来的几笔会各自单独显示。")) return;
    try {
      await unmergeDailyTx(groupId);
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
      await reloadData();
    } catch (e) {
      window.alert(`拆开失败: ${String((e as Error).message ?? e)}`);
    }
  }

  function toggleExpand(groupId: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

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
      bank: t.institution_name ?? "",
    });
    setTxError("");
    setTxOpen(true);
  }

  const editingLocked = editingTx !== null && editingTx.source !== "manual";
  const editingMerged = editingTx?.source === "merged";

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
        if (editingMerged) {
          if (!editingTx.primary_id) throw new Error("找不到合并记录对应的原始记录");
          await updateDailyTx(editingTx.primary_id, {
            category: txForm.category || null,
            note: txForm.note,
          });
        } else if (editingLocked) {
          await updateDailyTx(editingTx.id, {
            category: txForm.category || null,
            note: txForm.note,
            is_transfer: txForm.notCounted,
          });
        } else {
          await updateDailyTx(editingTx.id, {
            date: txForm.date,
            merchant: txForm.merchant,
            amount: txType === "expense" ? rawAmount : -rawAmount,
            category: txForm.category || null,
            note: txForm.note,
            is_transfer: txForm.notCounted,
            institution_name: txForm.bank || null,
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
            institution_name: txForm.bank || null,
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
                  <button
                    onClick={() => {
                      setBankError("");
                      setBankPanelOpen(true);
                    }}
                    style={{ ...actionBtn, background: "#8b5cf6", color: "#fff" }}
                  >
                    + 连接银行
                  </button>
                </div>
              </div>

              {selectedIds.size > 0 && (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 mb-3 px-3 py-2 rounded-lg"
                  style={{ background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.35)" }}
                >
                  <div className="text-xs" style={{ ...mono, color: TEXT }}>
                    已选 {selectedIds.size} 条 · 净额 {fmtCad(selectedNet, { sign: true })}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelectedIds(new Set())}
                      className="text-[10px] px-2.5 py-1.5 rounded"
                      style={{ ...mono, color: SUB, border: "1px solid rgba(139,92,246,0.3)" }}
                    >
                      取消
                    </button>
                    <button
                      onClick={handleMergeSelected}
                      disabled={selectedIds.size < 2}
                      className="text-[10px] px-2.5 py-1.5 rounded font-bold"
                      style={{
                        ...mono,
                        color: "#fff",
                        background: selectedIds.size < 2 ? "rgba(139,92,246,0.3)" : "#8b5cf6",
                        cursor: selectedIds.size < 2 ? "not-allowed" : "pointer",
                      }}
                      title={selectedIds.size < 2 ? "至少选 2 条才能合并" : undefined}
                    >
                      合并
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(139,92,246,0.18)" }}>
                      {["", "日期", "商家 / 备注", "类别", "银行", "金额", "不记录", ""].map((h, i) => (
                        <th
                          key={i}
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
                    {filteredTxns.flatMap((t) => {
                      const isGroup = t.source === "merged" && !!t.merge_group_id;
                      const expanded = isGroup && expandedGroups.has(t.merge_group_id!);
                      const rows = [
                        <tr key={t.id} style={{ borderBottom: "1px solid rgba(139,92,246,0.07)" }}>
                          <td className={`${td} text-center`}>
                            {isGroup ? (
                              <button
                                onClick={() => toggleExpand(t.merge_group_id!)}
                                title="展开 / 收起明细"
                                style={{ ...mono, color: SUB, background: "none", border: "none", cursor: "pointer", fontSize: 11 }}
                              >
                                {expanded ? "▾" : "▸"}
                              </button>
                            ) : (
                              <input
                                type="checkbox"
                                checked={selectedIds.has(t.id)}
                                onChange={(e) => toggleSelect(t.id, e.target.checked)}
                                title="勾选后可以和其它记录合并"
                              />
                            )}
                          </td>
                          <td className={td} style={{ ...mono, color: SUB, whiteSpace: "nowrap" }}>
                            {t.date}
                          </td>
                          <td className={td}>
                            <div style={{ ...mono, color: t.is_transfer ? MUTED : TEXT }}>
                              {t.merchant || t.name || "–"}
                              {isGroup && (
                                <span
                                  className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded"
                                  style={{ ...mono, color: "#a78bfa", border: "1px solid rgba(139,92,246,0.3)" }}
                                >
                                  合并×{t.members?.length ?? 0}
                                </span>
                              )}
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
                          <td className={td} style={{ ...mono, color: SUB }}>
                            {t.institution_name ?? (t.source === "manual" ? "手动" : "—")}
                          </td>
                          <td
                            className={td}
                            style={{ ...mono, color: t.is_transfer ? MUTED : t.amount > 0 ? TEXT : POS, fontWeight: 600 }}
                          >
                            {t.amount > 0 ? "-" : "+"}
                            {fmtCad(Math.abs(t.amount))}
                          </td>
                          <td className={`${td} text-center`}>
                            {!isGroup && (
                              <input
                                type="checkbox"
                                checked={t.is_transfer}
                                onChange={(e) => toggleNotCounted(t, e.target.checked)}
                                title="不计入收支统计"
                              />
                            )}
                          </td>
                          <td className={td}>
                            <div className="flex gap-1.5">
                              {isGroup ? (
                                <>
                                  <button
                                    onClick={() => openEdit(t)}
                                    className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-violet-500/15"
                                    style={{ ...mono, color: "#a78bfa", border: "1px solid rgba(139,92,246,0.3)" }}
                                  >
                                    编辑
                                  </button>
                                  <button
                                    onClick={() => handleUnmerge(t.merge_group_id!)}
                                    className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-red-500/15"
                                    style={{ ...mono, color: NEG, border: "1px solid rgba(248,113,113,0.3)" }}
                                  >
                                    拆开
                                  </button>
                                </>
                              ) : (
                                <>
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
                                </>
                              )}
                            </div>
                          </td>
                        </tr>,
                      ];
                      if (expanded && t.members) {
                        for (const m of t.members) {
                          rows.push(
                            <tr key={m.id} style={{ borderBottom: "1px solid rgba(139,92,246,0.05)", background: "rgba(139,92,246,0.03)" }}>
                              <td className={td}></td>
                              <td className={td} style={{ ...mono, color: MUTED, whiteSpace: "nowrap" }}>
                                {m.date}
                              </td>
                              <td className={td} style={{ ...mono, color: MUTED, paddingLeft: 24 }}>
                                {m.merchant || m.name || "–"}
                              </td>
                              <td className={td} style={{ ...mono, color: MUTED }}>
                                {catName(m.category)}
                              </td>
                              <td className={td} style={{ ...mono, color: MUTED }}>
                                {m.institution_name ?? (m.source === "manual" ? "手动" : "—")}
                              </td>
                              <td className={td} style={{ ...mono, color: MUTED }}>
                                {m.amount > 0 ? "-" : "+"}
                                {fmtCad(Math.abs(m.amount))}
                              </td>
                              <td className={td}></td>
                              <td className={td}></td>
                            </tr>
                          );
                        }
                      }
                      return rows;
                    })}
                    {filteredTxns.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-6 text-center text-xs" style={{ ...mono, color: MUTED }}>
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
            {editingMerged && (
              <div className="text-[11px]" style={{ ...mono, color: MUTED }}>
                合并记录只能编辑类别和备注,原始记录不受影响
              </div>
            )}
            {editingLocked && !editingMerged && (
              <div className="text-[11px]" style={{ ...mono, color: MUTED }}>
                银行同步的记录只能编辑类别、备注和"不记录"标记
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
                  <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>银行(可选)</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {BANK_ABBR.map((b) => (
                      <button
                        key={b}
                        type="button"
                        onClick={() => setTxForm((f) => ({ ...f, bank: f.bank === b ? "" : b }))}
                        className="px-2.5 py-1 rounded text-[11px] font-bold"
                        style={{
                          ...mono,
                          background: txForm.bank === b ? "#8b5cf6" : "rgba(139,92,246,0.08)",
                          color: txForm.bank === b ? "#fff" : SUB,
                        }}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

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

            <div>
              <label className="text-[10px] tracking-widest block mb-1" style={{ ...mono, color: MUTED }}>备注(可选)</label>
              <input
                style={inputStyle}
                value={txForm.note}
                onChange={(e) => setTxForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>

            {!editingMerged && (
              <label className="flex items-center gap-2 text-xs" style={{ ...mono, color: SUB }}>
                <input
                  type="checkbox"
                  checked={txForm.notCounted}
                  onChange={(e) => setTxForm((f) => ({ ...f, notCounted: e.target.checked }))}
                />
                不记录(不计入收支统计)
              </label>
            )}

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

      {/* 连接银行 Dialog */}
      <Dialog open={bankPanelOpen} onOpenChange={setBankPanelOpen}>
        <DialogContent style={dialogContentStyle}>
          <DialogHeader>
            <DialogTitle style={{ ...display, color: TEXT }}>连接银行</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {bankItems.length === 0 && (
              <div className="text-xs" style={{ ...mono, color: MUTED }}>
                还没有连接任何银行
              </div>
            )}
            {bankItems.map((b) => (
              <div
                key={b.item_id}
                className="flex items-center justify-between gap-2 rounded px-3 py-2"
                style={{ background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.15)" }}
              >
                <div>
                  <div className="text-xs font-semibold" style={{ ...mono, color: TEXT }}>
                    {b.institution_name ?? b.item_id}
                  </div>
                  <div className="text-[10px] mt-0.5" style={{ ...mono, color: b.status === "ok" ? POS : NEG }}>
                    {b.status === "ok" ? "正常" : "需要重新授权"}
                  </div>
                </div>
                <button
                  onClick={() => handleRemoveBank(b.item_id)}
                  className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-red-500/15"
                  style={{ ...mono, color: NEG, border: "1px solid rgba(248,113,113,0.3)" }}
                >
                  移除
                </button>
              </div>
            ))}

            {bankError && <div className="text-xs" style={{ ...mono, color: NEG }}>{bankError}</div>}

            <button
              onClick={connectBank}
              disabled={linking}
              className="w-full py-2.5 rounded text-sm font-bold"
              style={{ ...mono, background: "#8b5cf6", color: "#fff", opacity: linking ? 0.6 : 1 }}
            >
              {linking ? "连接中..." : "+ 连接新银行"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
