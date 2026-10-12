// 并发拉取 SnapTrade 账户数据并整理成 PortfolioView。
// 不直接依赖 SDK:edge function 传进来一个只有只读方法的 PortfolioClient,测试传假的。
// 这样"一个账户/一个板块失败,其它照常显示"的行为可以离线测。

import {
  type AccountView,
  isInvestment,
  type PortfolioView,
  type RawAccount,
  type RawActivity,
  type RawBalance,
  type RawConnection,
  type RawOrder,
  type RawPositions,
  type Section,
  toAccountBase,
  toActivities,
  toBalances,
  toConnection,
  toOrders,
  toPositions,
} from "./snaptradeViewModels.ts";

/** SnapTrade 活动接口单页上限 */
export const ACTIVITY_PAGE_LIMIT = 1000;

/** 只读。没有任何下单/改单/撤单方法 —— 也不要往这里加。 */
export interface PortfolioClient {
  listConnections(): Promise<RawConnection[]>;
  listAccounts(): Promise<RawAccount[]>;
  balances(accountId: string): Promise<RawBalance[]>;
  positions(accountId: string): Promise<RawPositions>;
  recentOrders(accountId: string): Promise<RawOrder[]>;
  /** 返回 startDate 之后的活动,最多 ACTIVITY_PAGE_LIMIT 条 */
  activities(accountId: string, startDate: string): Promise<RawActivity[]>;
}

/**
 * 给页面看的错误信息:只留 HTTP 状态和简短原因。
 * SDK 的错误对象里有完整请求(含 query 里的 clientId),SnapTrade 401 的 detail 还会把收到的
 * clientId 原样回显("Invalid clientId provided - <值>"),都要截掉。
 */
export function describeError(e: unknown): string {
  const err = e as {
    status?: number;
    response?: { status?: number; data?: { detail?: unknown } };
    responseBody?: { detail?: unknown };
    message?: unknown;
  };
  const status = err?.status ?? err?.response?.status;
  const detail = err?.responseBody?.detail ?? err?.response?.data?.detail ?? err?.message ?? "unknown error";
  const clean = String(detail)
    .replace(/(provided)\s*-\s*\S+/gi, "$1")
    .replace(/(clientId|consumerKey|timestamp|Signature)=[^&\s]+/gi, "$1=[REDACTED]")
    .slice(0, 160);
  return status ? `HTTP ${status}: ${clean}` : clean;
}

async function section<T>(run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);

/** 最多同时几个 SnapTrade 请求。全部账户 × 4 块一起发,很容易撞上 429(个人用户有每账户/每分钟限流)。 */
export const DEFAULT_CONCURRENCY = 4;

/** 简单的并发闸门:同时最多 n 个 run 在跑,其余排队。 */
export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    // 满了就排队;放行时名额直接交给排队者(active 不减),新来的不会插队超出上限
    if (active >= n) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

export interface BuildOptions {
  now?: Date;
  /** 同时进行的 SnapTrade 请求上限 */
  concurrency?: number;
  /** 最近活动看多少天(活动是每日缓存数据,太短会经常是空的) */
  activityDays?: number;
}

export async function buildPortfolio(client: PortfolioClient, opts: BuildOptions = {}): Promise<PortfolioView> {
  const now = opts.now ?? new Date();
  const activityDays = opts.activityDays ?? 30;
  const startDate = daysAgo(now, activityDays);
  const run = limiter(opts.concurrency ?? DEFAULT_CONCURRENCY);

  const [connections, accountsRaw] = await Promise.all([
    section(async () => (await client.listConnections()).map(toConnection)),
    section(() => client.listAccounts()),
  ]);

  let accounts: Section<AccountView[]>;
  if (!accountsRaw.ok) {
    accounts = accountsRaw;
  } else {
    // 每个账户的四块各自独立。已关闭的账户、信用卡/信用额度/现金账户不拉明细
    // (省请求,SnapTrade 对个人用户有每账户每分钟 10 次的限流)
    const data = await Promise.all(
      accountsRaw.data.map(async (raw): Promise<AccountView> => {
        const base = toAccountBase(raw);
        if (base.status === "closed" || !isInvestment(base)) {
          return { ...base, balances: null, positions: null, orders: null, activity: null, activityTruncated: false };
        }
        const [balances, positions, orders, activity] = await Promise.all([
          section(async () => toBalances(await run(() => client.balances(raw.id)))),
          section(async () => toPositions(await run(() => client.positions(raw.id)))),
          section(async () => toOrders(await run(() => client.recentOrders(raw.id)))),
          section(async () => toActivities(await run(() => client.activities(raw.id, startDate)))),
        ]);
        const activityTruncated = activity.ok && activity.data.length >= ACTIVITY_PAGE_LIMIT;
        return { ...base, balances, positions, orders, activity, activityTruncated };
      }),
    );
    // 开着的在前,同状态按机构+名称
    data.sort(
      (a, b) =>
        Number(a.status === "closed") - Number(b.status === "closed") ||
        a.institution.localeCompare(b.institution) ||
        a.name.localeCompare(b.name),
    );
    accounts = { ok: true, data };
  }

  return { retrievedAt: now.toISOString(), activityDays, connections, accounts };
}
