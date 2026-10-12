// SnapTrade 返回 → 页面用的小 view model。纯函数、零依赖:
//   - edge function snaptrade-portfolio 用它把 SDK 响应整理好再返回(浏览器只拿得到这些字段,拿不到原始响应)
//   - 前端 portfolioApi.ts 只 `import type` 这里的类型
//   - deno test 直接测
//
// 输入类型只声明用到的字段(SDK 的类型都带 [key: string]: any,字段基本都是可选/可空),
// 所以这里对每个字段都按"可能缺"处理,缺了就是 null,不编数。

// ---------- 输出(浏览器看到的) ----------

export interface Money {
  amount: number;
  currency: string;
}

/** 每个板块单独成功/失败:一个账户的某一块失败不影响其它块。 */
export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ConnectionView {
  id: string;
  brokerage: string;
  name: string | null;
  /** read / trade —— SnapTrade 的连接类型,不是本页的权限(本页只读) */
  type: string | null;
  disabled: boolean;
  disabledDate: string | null;
  updatedDate: string | null;
}

export interface BalanceView {
  currency: string;
  cash: number | null;
  buyingPower: number | null;
}

export interface OptionDetails {
  type: string; // CALL / PUT
  strike: number | null;
  expiration: string | null;
  underlying: string | null;
}

export interface PositionView {
  symbol: string;
  description: string | null;
  kind: string;
  units: number | null;
  /** 每股价格(期权也是每股权利金) */
  price: number | null;
  /** 每股平均成本 */
  costBasis: number | null;
  currency: string | null;
  /** 期权一张合约的股数(通常 100);其它 1 */
  multiplier: number;
  marketValue: number | null;
  bookValue: number | null;
  unrealized: number | null;
  unrealizedPct: number | null;
  /** SnapTrade 标记为已计入现金余额的持仓 —— 汇总时不能再加一遍 */
  cashEquivalent: boolean;
  option: OptionDetails | null;
}

export interface PositionsView {
  /** SnapTrade 给的持仓数据时间(不是本页拉取时间) */
  asOf: string | null;
  items: PositionView[];
}

export interface OrderView {
  id: string;
  symbol: string;
  action: string | null;
  status: string | null;
  orderType: string | null;
  totalQuantity: number | null;
  filledQuantity: number | null;
  executionPrice: number | null;
  limitPrice: number | null;
  currency: string | null;
  timePlaced: string | null;
  timeExecuted: string | null;
}

export interface ActivityView {
  id: string;
  date: string | null;
  type: string;
  optionType: string | null;
  symbol: string | null;
  description: string | null;
  units: number | null;
  price: number | null;
  amount: number | null;
  currency: string | null;
  fee: number | null;
}

export interface AccountView {
  id: string;
  institution: string;
  name: string;
  /** 账号后 4 位 */
  numberSuffix: string;
  /** SnapTrade 的统一账户类型(SELF_DIRECTED_TFSA 等),没有就用券商原始类型 */
  type: string | null;
  category: string | null;
  status: "open" | "closed" | "unknown";
  currency: string | null;
  total: Money | null;
  holdingsSyncedAt: string | null;
  transactionsSyncedAt: string | null;
  /** 已关闭的账户和非投资账户不拉明细,这四个是 null */
  balances: Section<BalanceView[]> | null;
  positions: Section<PositionsView> | null;
  orders: Section<OrderView[]> | null;
  activity: Section<ActivityView[]> | null;
  /** 活动条数达到单页上限,更早的没有拉 */
  activityTruncated: boolean;
}

/** 投资账户(股票/基金/加密)。信用卡、信用额度(LOC)、现金账户(DEPOSIT)只在账户列表里出现,不算进汇总和明细。 */
export const isInvestment = (a: Pick<AccountView, "category">) => a.category === null || a.category === "INVESTMENT";

export interface PortfolioView {
  /** 本页(edge function)拉取的时间 */
  retrievedAt: string;
  activityDays: number;
  connections: Section<ConnectionView[]>;
  accounts: Section<AccountView[]>;
}

// ---------- 输入(SDK 响应里用到的字段) ----------

type Nullable<T> = T | null | undefined;

export interface RawConnection {
  id?: string;
  name?: Nullable<string>;
  type?: Nullable<string>;
  disabled?: Nullable<boolean>;
  disabled_date?: Nullable<string>;
  updated_date?: Nullable<string>;
  brokerage?: Nullable<{ name?: Nullable<string>; display_name?: Nullable<string> }>;
}

export interface RawAccount {
  id: string;
  name?: Nullable<string>;
  number?: Nullable<string>;
  institution_name?: Nullable<string>;
  raw_type?: Nullable<string>;
  status?: Nullable<string>;
  account_category?: Nullable<string>;
  meta?: Nullable<{ unifiedAccountType?: Nullable<string>; currency?: Nullable<string> }>;
  balance?: Nullable<{ total?: Nullable<{ amount?: Nullable<number>; currency?: Nullable<string> }> }>;
  sync_status?: Nullable<{
    holdings?: Nullable<{ last_successful_sync?: Nullable<string> }>;
    transactions?: Nullable<{ last_successful_sync?: Nullable<string> }>;
  }>;
}

export interface RawBalance {
  currency?: Nullable<{ code?: Nullable<string> }>;
  cash?: Nullable<number>;
  buying_power?: Nullable<number>;
}

export interface RawInstrument {
  kind?: Nullable<string>;
  symbol?: Nullable<string>;
  description?: Nullable<string>;
  currency?: Nullable<string>;
  option_type?: Nullable<string>;
  strike_price?: Nullable<string | number>;
  expiration_date?: Nullable<string>;
  multiplier?: Nullable<string | number>;
  underlying?: Nullable<{ symbol?: Nullable<string> }>;
}

export interface RawPosition {
  instrument?: Nullable<RawInstrument>;
  units?: Nullable<string | number>;
  price?: Nullable<string | number>;
  cost_basis?: Nullable<string | number>;
  currency?: Nullable<string>;
  cash_equivalent?: Nullable<boolean>;
}

export interface RawPositions {
  results?: Nullable<RawPosition[]>;
  data_freshness?: Nullable<{ as_of?: Nullable<string> }>;
}

export interface RawOrder {
  brokerage_order_id?: Nullable<string>;
  symbol?: Nullable<string>;
  universal_symbol?: Nullable<{ symbol?: Nullable<string>; currency?: Nullable<{ code?: Nullable<string> }> }>;
  option_symbol?: Nullable<{ ticker?: Nullable<string> }>;
  quote_currency?: Nullable<{ code?: Nullable<string> }>;
  action?: Nullable<string>;
  status?: Nullable<string>;
  order_type?: Nullable<string>;
  total_quantity?: Nullable<string | number>;
  filled_quantity?: Nullable<string | number>;
  execution_price?: Nullable<string | number>;
  limit_price?: Nullable<string | number>;
  time_placed?: Nullable<string>;
  time_executed?: Nullable<string>;
}

export interface RawActivity {
  id?: Nullable<string>;
  trade_date?: Nullable<string>;
  type?: Nullable<string>;
  option_type?: Nullable<string>;
  symbol?: Nullable<{ symbol?: Nullable<string> }>;
  option_symbol?: Nullable<{ ticker?: Nullable<string> }>;
  description?: Nullable<string>;
  units?: Nullable<number | string>;
  price?: Nullable<number | string>;
  amount?: Nullable<number | string>;
  currency?: Nullable<{ code?: Nullable<string> }>;
  fee?: Nullable<number | string>;
}

// ---------- 整理 ----------

/** SDK 里数量/价格有的是字符串("12.5"),有的是数字;空、非数字都当缺失。 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const upper = (v: unknown): string | null => str(v)?.toUpperCase() ?? null;

export function toConnection(c: RawConnection): ConnectionView {
  return {
    id: c.id ?? "",
    brokerage: str(c.brokerage?.display_name) ?? str(c.brokerage?.name) ?? "Unknown brokerage",
    name: str(c.name),
    type: str(c.type),
    disabled: c.disabled === true,
    disabledDate: str(c.disabled_date),
    updatedDate: str(c.updated_date),
  };
}

export function toAccountBase(
  a: RawAccount,
): Omit<AccountView, "balances" | "positions" | "orders" | "activity" | "activityTruncated"> {
  const amount = num(a.balance?.total?.amount);
  const currency = upper(a.balance?.total?.currency) ?? upper(a.meta?.currency);
  const status = a.status === "open" || a.status === "closed" ? a.status : "unknown";
  return {
    id: a.id,
    institution: str(a.institution_name) ?? "Unknown institution",
    name: str(a.name) ?? "Unnamed account",
    numberSuffix: (a.number ?? "").slice(-4),
    type: str(a.meta?.unifiedAccountType) ?? str(a.raw_type),
    category: str(a.account_category),
    status,
    currency,
    total: amount !== null && currency ? { amount, currency } : null,
    holdingsSyncedAt: str(a.sync_status?.holdings?.last_successful_sync),
    transactionsSyncedAt: str(a.sync_status?.transactions?.last_successful_sync),
  };
}

export function toBalances(rows: RawBalance[]): BalanceView[] {
  return rows
    .map((b) => ({ currency: upper(b.currency?.code) ?? "?", cash: num(b.cash), buyingPower: num(b.buying_power) }))
    .sort((x, y) => x.currency.localeCompare(y.currency));
}

export function toPosition(p: RawPosition): PositionView {
  const inst = p.instrument ?? {};
  const kind = str(inst.kind) ?? "other";
  const isOption = kind === "option" || kind === "future_option";
  const multiplier = isOption ? num(inst.multiplier) ?? 100 : 1;
  const units = num(p.units);
  const price = num(p.price);
  const costBasis = num(p.cost_basis);
  const marketValue = units !== null && price !== null ? units * price * multiplier : null;
  const bookValue = units !== null && costBasis !== null ? units * costBasis * multiplier : null;
  const unrealized = marketValue !== null && bookValue !== null ? marketValue - bookValue : null;
  return {
    symbol: str(inst.symbol) ?? "?",
    description: str(inst.description),
    kind,
    units,
    price,
    costBasis,
    currency: upper(p.currency) ?? upper(inst.currency),
    multiplier,
    marketValue,
    bookValue,
    unrealized,
    // 空头的 bookValue 是负数,用绝对值做分母,收益率方向才和盈亏一致
    unrealizedPct: unrealized !== null && bookValue ? (unrealized / Math.abs(bookValue)) * 100 : null,
    cashEquivalent: p.cash_equivalent === true,
    option: isOption
      ? {
        type: upper(inst.option_type) ?? "?",
        strike: num(inst.strike_price),
        expiration: str(inst.expiration_date),
        underlying: upper(inst.underlying?.symbol),
      }
      : null,
  };
}

export function toPositions(r: RawPositions): PositionsView {
  const items = (r.results ?? []).map(toPosition);
  items.sort((a, b) => Math.abs(b.marketValue ?? 0) - Math.abs(a.marketValue ?? 0));
  return { asOf: str(r.data_freshness?.as_of), items };
}

export function toOrder(o: RawOrder, index: number): OrderView {
  return {
    id: str(o.brokerage_order_id) ?? `order-${index}`,
    symbol: str(o.option_symbol?.ticker) ?? str(o.universal_symbol?.symbol) ?? str(o.symbol) ?? "?",
    action: upper(o.action),
    status: upper(o.status),
    orderType: str(o.order_type),
    totalQuantity: num(o.total_quantity),
    filledQuantity: num(o.filled_quantity),
    executionPrice: num(o.execution_price),
    limitPrice: num(o.limit_price),
    currency: upper(o.quote_currency?.code) ?? upper(o.universal_symbol?.currency?.code),
    timePlaced: str(o.time_placed),
    timeExecuted: str(o.time_executed),
  };
}

export function toOrders(rows: RawOrder[]): OrderView[] {
  return rows.map(toOrder).sort((a, b) => (b.timePlaced ?? "").localeCompare(a.timePlaced ?? ""));
}

export function toActivity(a: RawActivity, index: number): ActivityView {
  return {
    id: str(a.id) ?? `activity-${index}`,
    date: str(a.trade_date),
    type: upper(a.type) ?? "UNKNOWN",
    optionType: upper(a.option_type),
    symbol: str(a.option_symbol?.ticker) ?? str(a.symbol?.symbol),
    description: str(a.description),
    units: num(a.units),
    price: num(a.price),
    amount: num(a.amount),
    currency: upper(a.currency?.code),
    fee: num(a.fee),
  };
}

export function toActivities(rows: RawActivity[]): ActivityView[] {
  return rows.map(toActivity).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

// ---------- 汇总(按币种分开,不做汇率换算) ----------

/**
 * 按"交易币种"汇总的现金和持仓。和账户总值是两套口径:
 * 券商的账户总值按账户基准币种(WS 是 CAD)报,已经把 USD 持仓折算进去;
 * 现金和持仓按各自的交易币种报。所以两者不能放进同一个币种桶里相加。
 */
export interface CurrencyTotals {
  currency: string;
  cash: number;
  /** 非 cash_equivalent 持仓的市值 */
  positionsValue: number;
}

export interface AccountAllocation {
  accountId: string;
  label: string;
  currency: string;
  amount: number;
  /** 占同币种账户总值合计的百分比 */
  pct: number;
}

export interface PortfolioSummary {
  /** 各账户 balance.total 按其报告币种相加(券商已按账户基准币种折算,含其它币种的持仓) */
  accountTotals: Money[];
  /** 现金 + 持仓,按交易币种 */
  byCurrency: CurrencyTotals[];
  allocation: AccountAllocation[];
  /** 开放的投资账户数 */
  openAccounts: number;
  /** 至少一个板块失败的账户数 */
  partialAccounts: number;
  /** 连接被禁用:数据是 SnapTrade 最后一次缓存的,可能过期 */
  staleConnections: number;
  /** 值缺失、没法计入汇总的账户/持仓数(页面上要提示,汇总不完整) */
  missingValues: number;
}

export const accountLabel = (a: Pick<AccountView, "name" | "numberSuffix">) =>
  a.numberSuffix ? `${a.name} ····${a.numberSuffix}` : a.name;

export function failedSections(a: AccountView): string[] {
  const out: string[] = [];
  if (a.balances && !a.balances.ok) out.push("balances");
  if (a.positions && !a.positions.ok) out.push("positions");
  if (a.orders && !a.orders.ok) out.push("orders");
  if (a.activity && !a.activity.ok) out.push("activity");
  return out;
}

export function summarize(view: PortfolioView): PortfolioSummary {
  const totals = new Map<string, CurrencyTotals>();
  const bucket = (ccy: string) => {
    let t = totals.get(ccy);
    if (!t) {
      t = { currency: ccy, cash: 0, positionsValue: 0 };
      totals.set(ccy, t);
    }
    return t;
  };
  const accountTotals = new Map<string, number>();
  const allocation: AccountAllocation[] = [];
  let missingValues = 0;
  let partialAccounts = 0;

  const accounts = view.accounts.ok ? view.accounts.data.filter((a) => a.status !== "closed" && isInvestment(a)) : [];
  for (const a of accounts) {
    if (failedSections(a).length) partialAccounts++;
    if (a.total) {
      accountTotals.set(a.total.currency, (accountTotals.get(a.total.currency) ?? 0) + a.total.amount);
      if (a.total.amount !== 0) {
        allocation.push({
          accountId: a.id,
          label: accountLabel(a),
          currency: a.total.currency,
          amount: a.total.amount,
          pct: 0,
        });
      }
    } else {
      missingValues++;
    }
    if (a.balances?.ok) {
      for (const b of a.balances.data) if (b.cash !== null) bucket(b.currency).cash += b.cash;
    }
    if (a.positions?.ok) {
      for (const p of a.positions.data.items) {
        if (p.cashEquivalent) continue;
        if (p.marketValue === null || !p.currency) missingValues++;
        else bucket(p.currency).positionsValue += p.marketValue;
      }
    }
  }

  const byCurrency = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  for (const row of allocation) {
    const denom = accountTotals.get(row.currency) ?? 0;
    row.pct = denom ? (row.amount / denom) * 100 : 0;
  }
  allocation.sort((a, b) => a.currency.localeCompare(b.currency) || b.amount - a.amount);

  return {
    accountTotals: [...accountTotals.entries()]
      .map(([currency, amount]) => ({ amount, currency }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    byCurrency,
    allocation,
    openAccounts: accounts.length,
    partialAccounts,
    staleConnections: view.connections.ok ? view.connections.data.filter((c) => c.disabled).length : 0,
    missingValues,
  };
}
