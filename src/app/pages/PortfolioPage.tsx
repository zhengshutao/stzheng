// 只读投资组合(SnapTrade)—— 账户、余额、持仓、按账户分配、最近订单、最近活动、连接状态。
// 数据由 snaptrade-portfolio edge function 现拉现给,不落库;页面只做展示,没有任何交易操作。
// 金额一律按 API 给的币种显示,不同币种分开汇总、不做汇率换算。

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AlertTriangle, ArrowLeft, Lock, RefreshCw } from "lucide-react";
import DashboardNavbar from "@/app/pages/DashboardNavbar";
import { stockFaviconHref, useFavicon } from "@/app/lib/favicon";
import {
  accountLabel,
  failedSections,
  fetchPortfolio,
  isInvestment,
  summarize,
  type AccountView,
  type ActivityView,
  type OrderView,
  type PortfolioView,
  type PositionView,
} from "@/app/lib/portfolioApi";

const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Exo 2', sans-serif" };

const POS = "#34d399";
const NEG = "#f87171";
const WARN = "#fbbf24";
const MUTED = "#4a5568";
const TEXT = "#e2e8f4";
const SUB = "#6b7fa8";

const box = { background: "rgba(10,14,28,0.82)", border: "1px solid rgba(139,92,246,0.18)" };
const rowBorder = { borderBottom: "1px solid rgba(139,92,246,0.08)" };
const pnlColor = (n: number | null) => (n === null ? SUB : n > 0 ? POS : n < 0 ? NEG : SUB);

// ---------- 格式化 ----------

const moneyFmt = new Map<string, Intl.NumberFormat>();
function fmtMoney(amount: number | null, currency: string | null, opts: { sign?: boolean } = {}): string {
  if (amount === null) return "—";
  if (!currency) return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const key = `${currency}|${opts.sign ? 1 : 0}`;
  let f = moneyFmt.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        currencyDisplay: "code",
        signDisplay: opts.sign ? "exceptZero" : "auto",
      });
    } catch {
      // 非 ISO 代码(比如某些加密币)—— 数字 + 代码
      f = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8, signDisplay: opts.sign ? "exceptZero" : "auto" });
    }
    moneyFmt.set(key, f);
  }
  const s = f.format(amount);
  return f.resolvedOptions().style === "currency" ? s : `${s} ${currency}`;
}

const fmtQty = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 6 }));
const fmtPct = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

const TYPE_ZH: Record<string, string> = {
  SELF_DIRECTED_TFSA: "TFSA",
  SELF_DIRECTED_RRSP: "RRSP",
  SELF_DIRECTED_FHSA: "FHSA",
  SELF_DIRECTED_NON_REGISTERED: "非注册",
  SELF_DIRECTED_NON_REGISTERED_MARGIN: "非注册 · 保证金",
  SELF_DIRECTED_CRYPTO: "加密",
  CASH: "现金账户 CAD",
  CASH_USD: "现金账户 USD",
  CREDIT_CARD: "信用卡",
  PORTFOLIO_LINE_OF_CREDIT: "投资组合信用额度",
};
const typeName = (t: string | null) => (t ? TYPE_ZH[t] ?? t : "—");

// ---------- 通用小组件 ----------

function Panel({ title, sub, children, right }: { title: string; sub?: ReactNode; children: ReactNode; right?: ReactNode }) {
  const id = `panel-${title.replace(/\W+/g, "-")}`;
  return (
    <section className="rounded-xl p-5 space-y-4" style={box} aria-labelledby={id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id={id} className="text-sm font-bold text-white" style={display}>
            {title}
          </h2>
          {sub && (
            <div className="text-[10px] mt-1" style={{ ...mono, color: SUB }}>
              {sub}
            </div>
          )}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Notice({ tone, children }: { tone: "error" | "warn"; children: ReactNode }) {
  const color = tone === "error" ? NEG : WARN;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="rounded-lg px-4 py-3 text-xs flex gap-2 items-start"
      style={{ ...mono, color, background: `${color}0f`, border: `1px solid ${color}4d` }}
    >
      <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden />
      <div className="space-y-1 min-w-0 break-words">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs py-6 text-center" style={{ ...mono, color: MUTED }}>
      {children}
    </div>
  );
}

/** 表格横向滚动只发生在表格容器内,页面本身不横向滚动 */
function Table({ caption, head, children }: { caption: string; head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-xs" style={mono}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-[10px] tracking-widest text-left" style={{ color: MUTED, ...rowBorder }}>
            {head}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const Th = ({ children, right }: { children: ReactNode; right?: boolean }) => (
  <th scope="col" className={`py-2 pr-3 font-normal whitespace-nowrap ${right ? "text-right" : ""}`}>
    {children}
  </th>
);
const Td = ({ children, right, color, title }: { children: ReactNode; right?: boolean; color?: string; title?: string }) => (
  <td className={`py-2 pr-3 whitespace-nowrap ${right ? "text-right tabular-nums" : ""}`} style={{ color: color ?? TEXT }} title={title}>
    {children}
  </td>
);

// ---------- 各板块 ----------

function SummaryCards({ view }: { view: PortfolioView }) {
  const s = useMemo(() => summarize(view), [view]);
  if (!view.accounts.ok) return null;
  if (s.accountTotals.length === 0 && s.byCurrency.length === 0) {
    return (
      <Panel title="总览">
        <Empty>没有可汇总的开放账户</Empty>
      </Panel>
    );
  }
  const card = { background: "rgba(139,92,246,0.05)", border: "1px solid rgba(139,92,246,0.12)" };
  return (
    <Panel
      title="总览"
      sub={`${s.openAccounts} 个开放的投资账户 · 信用卡/信用额度/现金账户不计入`}
    >
      <div className="flex flex-wrap gap-3">
        {s.accountTotals.map((t) => (
          <div key={t.currency} className="rounded-lg p-4 flex-1 min-w-[200px]" style={card}>
            <div className="text-[10px] tracking-widest" style={{ ...mono, color: MUTED }}>
              账户总值 · {t.currency}
            </div>
            <div className="text-2xl font-bold mt-1" style={{ ...display, color: TEXT }}>
              {fmtMoney(t.amount, t.currency)}
            </div>
            <div className="text-[10px] mt-1" style={{ ...mono, color: SUB }}>
              券商按账户币种报的总值,已含其它币种持仓的折算
            </div>
          </div>
        ))}
      </div>
      {s.byCurrency.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] tracking-widest" style={{ ...mono, color: MUTED }}>
            按交易币种 · 原币金额,未做汇率换算
          </div>
          <Table
            caption="按交易币种的现金和持仓"
            head={
              <>
                <Th>币种</Th>
                <Th right>现金</Th>
                <Th right>持仓市值</Th>
                <Th right>合计</Th>
              </>
            }
          >
            {s.byCurrency.map((c) => (
              <tr key={c.currency} style={rowBorder}>
                <Td color={SUB}>{c.currency}</Td>
                <Td right>{fmtMoney(c.cash, c.currency)}</Td>
                <Td right>{fmtMoney(c.positionsValue, c.currency)}</Td>
                <Td right>{fmtMoney(c.cash + c.positionsValue, c.currency)}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {s.partialAccounts > 0 && (
        <Notice tone="warn">
          {s.partialAccounts} 个账户有数据没拿到,上面按交易币种的现金/持仓不完整;账户总值不受影响。点刷新重试。
        </Notice>
      )}
      {s.missingValues > 0 && (
        <Notice tone="warn">有 {s.missingValues} 个账户总值或持仓价格缺失,没有计入上面的汇总。</Notice>
      )}
    </Panel>
  );
}

function AllocationPanel({ view }: { view: PortfolioView }) {
  const s = useMemo(() => summarize(view), [view]);
  if (!view.accounts.ok || s.allocation.length === 0) return null;
  const currencies = [...new Set(s.allocation.map((a) => a.currency))];
  return (
    <Panel title="按账户分配" sub="账户总值占同币种合计的比例">
      <div className="space-y-5">
        {currencies.map((ccy) => (
          <div key={ccy} className="space-y-2">
            <div className="text-[10px] tracking-widest" style={{ ...mono, color: MUTED }}>
              {ccy}
            </div>
            <ul className="space-y-2">
              {s.allocation
                .filter((a) => a.currency === ccy)
                .map((a) => (
                  <li key={a.accountId} className="text-xs" style={mono}>
                    <div className="flex justify-between gap-3 mb-1">
                      <span className="truncate" style={{ color: SUB }}>
                        {a.label}
                      </span>
                      <span className="shrink-0 tabular-nums" style={{ color: TEXT }}>
                        {fmtMoney(a.amount, a.currency)} · {a.pct.toFixed(1)}%
                      </span>
                    </div>
                    <div
                      className="h-2 rounded overflow-hidden"
                      style={{ background: "rgba(139,92,246,0.08)" }}
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(Math.max(0, a.pct))}
                      aria-label={`${a.label} 占 ${ccy} 合计 ${a.pct.toFixed(1)}%`}
                    >
                      <div
                        className="h-full rounded"
                        style={{ width: `${Math.min(100, Math.max(0, a.pct))}%`, background: a.amount < 0 ? NEG : "linear-gradient(90deg,#7c3aed,#a78bfa)" }}
                      />
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function AccountsPanel({ accounts }: { accounts: AccountView[] }) {
  const open = accounts.filter((a) => a.status !== "closed");
  const closed = accounts.filter((a) => a.status === "closed");
  const row = (a: AccountView) => {
    const failed = failedSections(a);
    return (
      <tr key={a.id} style={rowBorder}>
        <Td color={SUB}>{a.institution}</Td>
        <Td>{accountLabel(a)}</Td>
        <Td color={SUB}>{typeName(a.type)}</Td>
        <Td right>{a.total ? fmtMoney(a.total.amount, a.total.currency) : "—"}</Td>
        <Td color={SUB} title="SnapTrade 上次成功同步持仓的时间">
          {fmtTime(a.holdingsSyncedAt)}
        </Td>
        <Td color={failed.length ? WARN : a.status === "closed" ? MUTED : POS}>
          {a.status === "closed" ? "已关闭" : failed.length ? `部分失败(${failed.join("/")})` : "正常"}
        </Td>
      </tr>
    );
  };
  const head = (
    <>
      <Th>机构</Th>
      <Th>账户</Th>
      <Th>类型</Th>
      <Th right>总值</Th>
      <Th>持仓同步</Th>
      <Th>状态</Th>
    </>
  );
  return (
    <Panel title="账户" sub={`${open.length} 个开放 · ${closed.length} 个已关闭`}>
      {open.length === 0 ? <Empty>没有开放的账户</Empty> : <Table caption="开放账户" head={head}>{open.map(row)}</Table>}
      {closed.length > 0 && (
        <details>
          <summary className="text-[11px] cursor-pointer select-none" style={{ ...mono, color: SUB }}>
            已关闭的账户({closed.length})
          </summary>
          <div className="mt-3">
            <Table caption="已关闭账户" head={head}>{closed.map(row)}</Table>
          </div>
        </details>
      )}
    </Panel>
  );
}

/** 空状态的补充说明:有账户这一块失败时,"没有"只代表拿到的那部分 */
function partialNote(accounts: AccountView[], k: "balances" | "positions" | "orders" | "activity"): string {
  const failed = accounts.filter((a) => a[k] && !a[k]!.ok).length;
  return failed ? `(另有 ${failed} 个账户没拿到)` : "";
}

function SectionErrors({ accounts, k, what }: { accounts: AccountView[]; k: "balances" | "positions" | "orders" | "activity"; what: string }) {
  const failed = accounts.filter((a) => a[k] && !a[k]!.ok);
  if (!failed.length) return null;
  return (
    <Notice tone="error">
      <div>
        {failed.length} 个账户的{what}没拿到,下面只显示成功的部分:
      </div>
      {failed.map((a) => {
        const s = a[k]!;
        return (
          <div key={a.id} style={{ color: SUB }}>
            {accountLabel(a)} — {s.ok ? "" : s.error}
          </div>
        );
      })}
    </Notice>
  );
}

function PositionRow({ p }: { p: PositionView }) {
  const symbolCell = p.option ? (
    <span title={p.symbol}>
      {p.option.underlying ?? p.symbol} {p.option.type} {p.option.strike ?? "?"} · {fmtDate(p.option.expiration)}
    </span>
  ) : (
    p.symbol
  );
  return (
    <tr style={rowBorder}>
      <Td>
        {symbolCell}
        {p.cashEquivalent && (
          <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded" style={{ color: SUB, background: "rgba(139,92,246,0.1)" }}>
            计入现金
          </span>
        )}
      </Td>
      <Td color={SUB} title={p.description ?? undefined}>
        <span className="inline-block max-w-[200px] truncate align-bottom">{p.description ?? "—"}</span>
      </Td>
      <Td right>
        {fmtQty(p.units)}
        {p.option ? ` 张 ×${p.multiplier}` : ""}
      </Td>
      <Td right>{fmtMoney(p.price, p.currency)}</Td>
      <Td right>{fmtMoney(p.costBasis, p.currency)}</Td>
      <Td right>{fmtMoney(p.marketValue, p.currency)}</Td>
      <Td right color={pnlColor(p.unrealized)}>
        {fmtMoney(p.unrealized, p.currency, { sign: true })}
      </Td>
      <Td right color={pnlColor(p.unrealized)}>
        {fmtPct(p.unrealizedPct)}
      </Td>
    </tr>
  );
}

function PositionsPanel({ accounts }: { accounts: AccountView[] }) {
  const loaded = accounts.filter((a) => a.positions?.ok);
  const total = loaded.reduce((n, a) => n + (a.positions!.ok ? a.positions!.data.items.length : 0), 0);
  return (
    <Panel title="持仓" sub="价格和成本都是每股;期权市值 = 张数 × 每股价 × 合约乘数">
      <SectionErrors accounts={accounts} k="positions" what="持仓" />
      {loaded.length > 0 && total === 0 && (
        <Empty>没有持仓{partialNote(accounts, "positions")}</Empty>
      )}
      {loaded.map((a) => {
        if (!a.positions?.ok || a.positions.data.items.length === 0) return null;
        const { items, asOf } = a.positions.data;
        return (
          <div key={a.id} className="space-y-2">
            <div className="flex flex-wrap justify-between gap-2 text-[11px]" style={mono}>
              <span style={{ color: TEXT }}>{accountLabel(a)}</span>
              <span style={{ color: MUTED }} title="SnapTrade 返回的持仓数据时间">
                数据时间 {fmtTime(asOf)}
              </span>
            </div>
            <Table
              caption={`${accountLabel(a)} 持仓`}
              head={
                <>
                  <Th>标的</Th>
                  <Th>名称</Th>
                  <Th right>数量</Th>
                  <Th right>现价</Th>
                  <Th right>成本</Th>
                  <Th right>市值</Th>
                  <Th right>浮动盈亏</Th>
                  <Th right>%</Th>
                </>
              }
            >
              {items.map((p, i) => (
                <PositionRow key={`${p.symbol}-${i}`} p={p} />
              ))}
            </Table>
          </div>
        );
      })}
    </Panel>
  );
}

function BalancesPanel({ accounts }: { accounts: AccountView[] }) {
  const rows = accounts.flatMap((a) => (a.balances?.ok ? a.balances.data.map((b) => ({ a, b })) : []));
  return (
    <Panel title="现金与购买力" sub="按账户、按币种">
      <SectionErrors accounts={accounts} k="balances" what="余额" />
      {rows.length === 0 ? (
        accounts.some((a) => a.balances?.ok) && <Empty>没有现金余额{partialNote(accounts, "balances")}</Empty>
      ) : (
        <Table
          caption="现金与购买力"
          head={
            <>
              <Th>账户</Th>
              <Th>币种</Th>
              <Th right>现金</Th>
              <Th right>购买力</Th>
            </>
          }
        >
          {rows.map(({ a, b }) => (
            <tr key={`${a.id}-${b.currency}`} style={rowBorder}>
              <Td color={SUB}>{accountLabel(a)}</Td>
              <Td color={SUB}>{b.currency}</Td>
              <Td right>{fmtMoney(b.cash, b.currency)}</Td>
              <Td right>{fmtMoney(b.buyingPower, b.currency)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function OrdersPanel({ accounts }: { accounts: AccountView[] }) {
  const rows: { a: AccountView; o: OrderView }[] = accounts
    .flatMap((a) => (a.orders?.ok ? a.orders.data.map((o) => ({ a, o })) : []))
    .sort((x, y) => (y.o.timePlaced ?? "").localeCompare(x.o.timePlaced ?? ""));
  return (
    <Panel title="最近订单" sub="最近 24 小时内已成交的订单(SnapTrade 实时接口)">
      <SectionErrors accounts={accounts} k="orders" what="最近订单" />
      {rows.length === 0 ? (
        accounts.some((a) => a.orders?.ok) && <Empty>最近 24 小时没有成交{partialNote(accounts, "orders")}</Empty>
      ) : (
        <Table
          caption="最近订单"
          head={
            <>
              <Th>下单时间</Th>
              <Th>账户</Th>
              <Th>标的</Th>
              <Th>方向</Th>
              <Th>类型</Th>
              <Th right>成交/数量</Th>
              <Th right>成交价</Th>
              <Th>状态</Th>
            </>
          }
        >
          {rows.map(({ a, o }) => (
            <tr key={`${a.id}-${o.id}`} style={rowBorder}>
              <Td color={SUB}>{fmtTime(o.timePlaced)}</Td>
              <Td color={SUB}>{accountLabel(a)}</Td>
              <Td>{o.symbol}</Td>
              <Td color={o.action?.startsWith("BUY") ? POS : o.action?.startsWith("SELL") ? NEG : TEXT}>{o.action ?? "—"}</Td>
              <Td color={SUB}>{o.orderType ?? "—"}</Td>
              <Td right>
                {fmtQty(o.filledQuantity)} / {fmtQty(o.totalQuantity)}
              </Td>
              <Td right>{fmtMoney(o.executionPrice, o.currency)}</Td>
              <Td color={SUB}>{o.status ?? "—"}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function ActivityPanel({ accounts, days }: { accounts: AccountView[]; days: number }) {
  const [limit, setLimit] = useState(50);
  const truncated = accounts.filter((a) => a.activityTruncated);
  const rows: { a: AccountView; x: ActivityView }[] = accounts
    .flatMap((a) => (a.activity?.ok ? a.activity.data.map((x) => ({ a, x })) : []))
    .sort((p, q) => (q.x.date ?? "").localeCompare(p.x.date ?? ""));
  return (
    <Panel title="最近活动" sub={`最近 ${days} 天 · SnapTrade 每日缓存数据,当天的成交通常要第二天才出现`}>
      <SectionErrors accounts={accounts} k="activity" what="活动记录" />
      {truncated.length > 0 && (
        <Notice tone="warn">
          {truncated.map(accountLabel).join("、")} 最近 {days} 天的活动超过单次上限,只显示了最新的一部分。
        </Notice>
      )}
      {rows.length === 0 ? (
        accounts.some((a) => a.activity?.ok) && <Empty>最近 {days} 天没有活动{partialNote(accounts, "activity")}</Empty>
      ) : (
        <>
          <Table
            caption="最近活动"
            head={
              <>
                <Th>日期</Th>
                <Th>账户</Th>
                <Th>类型</Th>
                <Th>标的</Th>
                <Th right>数量</Th>
                <Th right>价格</Th>
                <Th right>金额</Th>
                <Th>说明</Th>
              </>
            }
          >
            {rows.slice(0, limit).map(({ a, x }) => (
              <tr key={`${a.id}-${x.id}`} style={rowBorder}>
                <Td color={SUB}>{fmtTime(x.date)}</Td>
                <Td color={SUB}>{accountLabel(a)}</Td>
                <Td>
                  {x.type}
                  {x.optionType ? ` · ${x.optionType}` : ""}
                </Td>
                <Td>{x.symbol ?? "—"}</Td>
                <Td right>{x.units === null || x.units === 0 ? "—" : fmtQty(x.units)}</Td>
                <Td right>{x.price ? fmtMoney(x.price, x.currency) : "—"}</Td>
                <Td right color={pnlColor(x.amount)}>
                  {fmtMoney(x.amount, x.currency, { sign: true })}
                </Td>
                <Td color={SUB} title={x.description ?? undefined}>
                  <span className="inline-block max-w-[260px] truncate align-bottom">{x.description ?? "—"}</span>
                </Td>
              </tr>
            ))}
          </Table>
          {rows.length > limit && (
            <button
              onClick={() => setLimit((n) => n + 100)}
              className="text-[11px] transition-colors hover:text-violet-300"
              style={{ ...mono, color: "#a78bfa" }}
            >
              显示更多(还有 {rows.length - limit} 条)
            </button>
          )}
        </>
      )}
    </Panel>
  );
}

function ConnectionsPanel({ view }: { view: PortfolioView }) {
  const c = view.connections;
  return (
    <Panel title="券商连接" sub="连接被禁用时 SnapTrade 只能返回最后一次缓存的数据">
      {!c.ok ? (
        <Notice tone="error">连接状态没拿到:{c.error}</Notice>
      ) : c.data.length === 0 ? (
        <Empty>没有券商连接</Empty>
      ) : (
        <ul className="space-y-2 text-xs" style={mono}>
          {c.data.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2">
              <span style={{ color: TEXT }}>
                {x.brokerage}
                {x.name && x.name !== x.brokerage ? <span style={{ color: SUB }}> · {x.name}</span> : null}
                {x.type && <span style={{ color: MUTED }}> · {x.type}</span>}
              </span>
              {x.disabled ? (
                <span style={{ color: NEG }}>
                  已禁用{x.disabledDate ? `(${fmtTime(x.disabledDate)})` : ""} ·{" "}
                  <a
                    href="https://docs.snaptrade.com/docs/fix-broken-connections"
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    如何修复
                  </a>
                </span>
              ) : (
                <span style={{ color: POS }}>正常</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------- 页面 ----------

export default function PortfolioPage() {
  useFavicon(stockFaviconHref());
  const [view, setView] = useState<PortfolioView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await fetchPortfolio());
    } catch (e) {
      // 保留上一次成功的数据,只显示这次的错误
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => (view ? summarize(view) : null), [view]);
  const accounts = view?.accounts.ok ? view.accounts.data : [];
  // 明细板块只看开放的投资账户(信用卡/信用额度/现金账户只在账户列表里出现,edge function 也不拉它们的明细)
  const openAccounts = accounts.filter((a) => a.status !== "closed" && isInvestment(a));

  return (
    <div className="min-h-screen" style={{ background: "#060a14", fontFamily: "'Inter', sans-serif" }}>
      <DashboardNavbar sub="SYS/ASSETS · PORTFOLIO" showCurrency={false} />
      <main className="pt-24 pb-16 px-4 sm:px-6 lg:px-10 max-w-6xl mx-auto space-y-6">
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs transition-colors hover:text-violet-300"
          style={{ ...mono, color: SUB }}
        >
          <ArrowLeft size={13} aria-hidden />
          返回日历
        </Link>

        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white" style={display}>
              投资组合
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-1 text-[10px]" style={{ ...mono, color: SUB }}>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: "rgba(139,92,246,0.1)" }}>
                <Lock size={10} aria-hidden /> 只读 · SnapTrade
              </span>
              <span aria-live="polite">{view ? `本页拉取于 ${fmtTime(view.retrievedAt)}` : ""}</span>
            </div>
          </div>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            style={{ ...mono, color: "#a78bfa", border: "1px solid rgba(139,92,246,0.35)" }}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden />
            {loading ? "刷新中…" : "刷新"}
          </button>
        </header>

        <div aria-live="polite" className="space-y-3">
          {error && (
            <Notice tone="error">
              <div>加载失败:{error}</div>
              {view && <div style={{ color: SUB }}>下面显示的是上一次成功拉取的数据({fmtTime(view.retrievedAt)})。</div>}
            </Notice>
          )}
          {view && !view.accounts.ok && <Notice tone="error">账户列表没拿到:{view.accounts.error}</Notice>}
          {summary && summary.staleConnections > 0 && (
            <Notice tone="warn">
              有 {summary.staleConnections} 个券商连接已被禁用,对应账户显示的是 SnapTrade 最后一次缓存的数据,可能已经过期。
            </Notice>
          )}
          {summary && summary.partialAccounts > 0 && (
            <Notice tone="warn">{summary.partialAccounts} 个账户只拿到了部分数据,失败的板块在下面各自标出。</Notice>
          )}
        </div>

        {!view && loading && (
          <div className="flex items-center gap-2 justify-center py-24 text-xs" style={{ ...mono, color: MUTED }} role="status">
            <RefreshCw size={13} className="animate-spin" aria-hidden />
            LOADING PORTFOLIO...
          </div>
        )}

        {view && (
          <>
            <SummaryCards view={view} />
            {view.accounts.ok && (
              <>
                <div className="grid gap-6 lg:grid-cols-2">
                  <AllocationPanel view={view} />
                  <ConnectionsPanel view={view} />
                </div>
                <AccountsPanel accounts={accounts} />
                <PositionsPanel accounts={openAccounts} />
                <BalancesPanel accounts={openAccounts} />
                <OrdersPanel accounts={openAccounts} />
                <ActivityPanel accounts={openAccounts} days={view.activityDays} />
              </>
            )}
            {!view.accounts.ok && <ConnectionsPanel view={view} />}
          </>
        )}
      </main>
    </div>
  );
}
