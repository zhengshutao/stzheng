// deno test supabase/functions/_shared/
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import {
  num,
  type PortfolioView,
  summarize,
  toAccountBase,
  toActivity,
  toBalances,
  toConnection,
  toOrder,
  toPosition,
  toPositions,
} from "./snaptradeViewModels.ts";
import {
  ACTIVITY_PAGE_LIMIT,
  buildPortfolio,
  DEFAULT_CONCURRENCY,
  describeError,
  type PortfolioClient,
} from "./snaptradePortfolio.ts";

// ---------- 整理 ----------

Deno.test("num: strings, numbers, blanks, garbage", () => {
  assertEquals(num("12.5"), 12.5);
  assertEquals(num(3), 3);
  assertEquals(num(""), null);
  assertEquals(num(null), null);
  assertEquals(num(undefined), null);
  assertEquals(num("abc"), null);
  assertEquals(num("0"), 0);
});

Deno.test("account: suffix, unified type, currency from total, missing total stays null", () => {
  const a = toAccountBase({
    id: "a1",
    name: "Wealthsimple Trade TFSA",
    number: "ABCDSQNg",
    institution_name: "Wealthsimple Trade",
    raw_type: "TFSA",
    status: "open",
    meta: { unifiedAccountType: "SELF_DIRECTED_TFSA", currency: "cad" },
    balance: { total: { amount: 1234.5, currency: "cad" } },
    sync_status: { holdings: { last_successful_sync: "2026-10-11" } },
  });
  assertEquals(a.numberSuffix, "SQNg");
  assertEquals(a.type, "SELF_DIRECTED_TFSA");
  assertEquals(a.total, { amount: 1234.5, currency: "CAD" });
  assertEquals(a.holdingsSyncedAt, "2026-10-11");
  assertEquals(a.transactionsSyncedAt, null);

  const missing = toAccountBase({ id: "a2", status: "weird", balance: { total: null } });
  assertEquals(missing.total, null);
  assertEquals(missing.status, "unknown");
  assertEquals(missing.name, "Unnamed account");
});

Deno.test("balances: per currency, sorted, nulls kept as null", () => {
  assertEquals(
    toBalances([
      { currency: { code: "USD" }, cash: 10, buying_power: null },
      { currency: { code: "CAD" }, cash: "5" as unknown as number, buying_power: 20 },
    ]),
    [
      { currency: "CAD", cash: 5, buyingPower: 20 },
      { currency: "USD", cash: 10, buyingPower: null },
    ],
  );
});

Deno.test("position: stock market value, book value, unrealized", () => {
  const p = toPosition({
    instrument: { kind: "stock", symbol: "AAPL", description: "Apple", currency: "USD" },
    units: "10",
    price: "200",
    cost_basis: "150",
    currency: "usd",
  });
  assertEquals(p.marketValue, 2000);
  assertEquals(p.bookValue, 1500);
  assertEquals(p.unrealized, 500);
  assertEquals(Math.round(p.unrealizedPct! * 100) / 100, 33.33);
  assertEquals(p.currency, "USD");
  assertEquals(p.multiplier, 1);
  assertEquals(p.option, null);
});

Deno.test("position: option uses contract multiplier (price is per share)", () => {
  const p = toPosition({
    instrument: {
      kind: "option",
      symbol: "TSLA  260706C00405000",
      option_type: "call",
      strike_price: "405",
      expiration_date: "2026-07-06",
      multiplier: "100",
      underlying: { symbol: "tsla" },
    },
    units: "2",
    price: "4.55",
    cost_basis: "3",
    currency: "USD",
  });
  assertEquals(p.marketValue, 910);
  assertEquals(p.bookValue, 600);
  assertEquals(p.option, { type: "CALL", strike: 405, expiration: "2026-07-06", underlying: "TSLA" });
});

Deno.test("position: short position pct has same sign as P&L", () => {
  const p = toPosition({
    instrument: { kind: "stock", symbol: "X" },
    units: -10,
    price: 8,
    cost_basis: 10,
    currency: "USD",
  });
  assertEquals(p.marketValue, -80);
  assertEquals(p.bookValue, -100);
  assertEquals(p.unrealized, 20);
  assertEquals(p.unrealizedPct, 20);
});

Deno.test("position: missing price → null values, never 0", () => {
  const p = toPosition({ instrument: { kind: "stock", symbol: "X" }, units: 5, price: null, currency: "USD" });
  assertEquals(p.marketValue, null);
  assertEquals(p.unrealized, null);
  assertEquals(p.unrealizedPct, null);
});

Deno.test("positions: empty account is empty, sorted by |value|", () => {
  assertEquals(toPositions({ results: [], data_freshness: { as_of: "t" } }), { asOf: "t", items: [] });
  assertEquals(toPositions({}).items, []);
  const sorted = toPositions({
    results: [
      { instrument: { symbol: "SMALL" }, units: 1, price: 1, currency: "USD" },
      { instrument: { symbol: "BIG" }, units: 1, price: 100, currency: "USD" },
    ],
  });
  assertEquals(sorted.items.map((i) => i.symbol), ["BIG", "SMALL"]);
});

Deno.test("order / activity / connection: field mapping and fallbacks", () => {
  const o = toOrder(
    {
      brokerage_order_id: "o1",
      universal_symbol: { symbol: "AAPL", currency: { code: "usd" } },
      action: "buy",
      status: "executed",
      total_quantity: "3",
      filled_quantity: "3",
      execution_price: "199.5",
    },
    0,
  );
  assertEquals([o.id, o.symbol, o.action, o.status, o.totalQuantity, o.executionPrice, o.currency], [
    "o1",
    "AAPL",
    "BUY",
    "EXECUTED",
    3,
    199.5,
    "USD",
  ]);
  assertEquals(toOrder({}, 4).id, "order-4");

  const a = toActivity({
    id: "x",
    type: "sell",
    option_symbol: { ticker: "AAPL 261218C00240000" },
    symbol: { symbol: "AAPL" },
    amount: "263.82",
    currency: { code: "USD" },
  }, 0);
  assertEquals([a.type, a.symbol, a.amount], ["SELL", "AAPL 261218C00240000", 263.82]);

  const c = toConnection({
    id: "c1",
    brokerage: { name: "Wealthsimple Trade" },
    disabled: true,
    disabled_date: "2026-10-01",
  });
  assertEquals([c.brokerage, c.disabled, c.disabledDate], ["Wealthsimple Trade", true, "2026-10-01"]);
});

// ---------- 并发 + 部分失败 ----------

function fakeClient(overrides: Partial<PortfolioClient> = {}): PortfolioClient {
  return {
    listConnections: () => Promise.resolve([{ id: "c1", brokerage: { name: "WS" }, disabled: false }]),
    listAccounts: () =>
      Promise.resolve([
        {
          id: "tfsa",
          name: "TFSA",
          number: "1111",
          status: "open",
          balance: { total: { amount: 1000, currency: "CAD" } },
        },
        {
          id: "nonreg",
          name: "Non-reg",
          number: "2222",
          status: "open",
          balance: { total: { amount: 3000, currency: "CAD" } },
        },
        {
          id: "usd",
          name: "USD",
          number: "3333",
          status: "open",
          balance: { total: { amount: 500, currency: "USD" } },
        },
        {
          id: "old",
          name: "Old",
          number: "9999",
          status: "closed",
          balance: { total: { amount: 0, currency: "CAD" } },
        },
        {
          id: "card",
          name: "Card",
          number: "4444",
          status: "open",
          account_category: "LOC",
          balance: { total: { amount: -250, currency: "CAD" } },
        },
      ]),
    balances: () => Promise.resolve([{ currency: { code: "CAD" }, cash: 100, buying_power: 100 }]),
    positions: () =>
      Promise.resolve({
        results: [
          { instrument: { kind: "stock", symbol: "XYZ" }, units: 10, price: 50, cost_basis: 40, currency: "CAD" },
          {
            instrument: { kind: "mutualfund", symbol: "CASHX" },
            units: 100,
            price: 1,
            currency: "CAD",
            cash_equivalent: true,
          },
        ],
        data_freshness: { as_of: "2026-10-12T00:00:00Z" },
      }),
    recentOrders: () => Promise.resolve([]),
    activities: () => Promise.resolve([]),
    ...overrides,
  };
}

const NOW = new Date("2026-10-12T12:00:00Z");

Deno.test("buildPortfolio: one account's positions fail, everything else still loads", async () => {
  const view = await buildPortfolio(
    fakeClient({
      positions: (
        id,
      ) => (id === "nonreg"
        ? Promise.reject({ status: 503, responseBody: { detail: "brokerage timeout" } })
        : fakeClient().positions(id)),
    }),
    { now: NOW },
  );
  assert(view.accounts.ok);
  const byId = Object.fromEntries(view.accounts.data.map((a) => [a.id, a]));
  assertEquals(byId.nonreg.positions, { ok: false, error: "HTTP 503: brokerage timeout" });
  assert(byId.nonreg.balances?.ok, "balances of the failing account still load");
  assert(byId.tfsa.positions?.ok, "other accounts unaffected");

  const s = summarize(view);
  assertEquals(s.partialAccounts, 1);
  assertEquals(s.openAccounts, 3);
});

Deno.test("buildPortfolio: closed accounts are listed but not fetched", async () => {
  const calls: string[] = [];
  const base = fakeClient();
  const view = await buildPortfolio(
    fakeClient({ balances: (id) => (calls.push(id), base.balances(id)) }),
    { now: NOW },
  );
  assert(view.accounts.ok);
  assertEquals(calls.sort(), ["nonreg", "tfsa", "usd"], "closed and non-investment (card) accounts are not fetched");
  const old = view.accounts.data.find((a) => a.id === "old")!;
  assertEquals([old.balances, old.positions, old.orders, old.activity], [null, null, null, null]);
  assertEquals(view.accounts.data.at(-1)!.id, "old", "closed accounts sort last");
  const card = view.accounts.data.find((a) => a.id === "card")!;
  assertEquals(card.positions, null);
});

Deno.test("buildPortfolio: connections failure does not hide accounts", async () => {
  const view = await buildPortfolio(fakeClient({ listConnections: () => Promise.reject(new Error("boom")) }), {
    now: NOW,
  });
  assertEquals(view.connections, { ok: false, error: "boom" });
  assert(view.accounts.ok);
});

Deno.test("buildPortfolio: account list failure is an error, not an empty portfolio", async () => {
  const view = await buildPortfolio(
    fakeClient({ listAccounts: () => Promise.reject({ status: 500, message: "down" }) }),
    { now: NOW },
  );
  assertEquals(view.accounts, { ok: false, error: "HTTP 500: down" });
  const s = summarize(view);
  assertEquals(s.byCurrency, []);
  assertEquals(s.accountTotals, []);
  assertEquals(s.openAccounts, 0);
});

Deno.test("buildPortfolio: activity hitting the page limit is flagged as truncated", async () => {
  const many = Array.from({ length: ACTIVITY_PAGE_LIMIT }, (_, i) => ({ id: `a${i}`, type: "BUY" }));
  const view = await buildPortfolio(
    fakeClient({ activities: (id) => Promise.resolve(id === "tfsa" ? many : []) }),
    { now: NOW },
  );
  assert(view.accounts.ok);
  const byId = Object.fromEntries(view.accounts.data.map((a) => [a.id, a]));
  assertEquals(byId.tfsa.activityTruncated, true);
  assertEquals(byId.nonreg.activityTruncated, false);
});

Deno.test("buildPortfolio: never more than DEFAULT_CONCURRENCY SnapTrade calls in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const slow = <T>(v: T) => async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return v;
  };
  const base = fakeClient();
  const view = await buildPortfolio(
    {
      ...base,
      balances: (id) => slow(null)().then(() => base.balances(id)),
      positions: (id) => slow(null)().then(() => base.positions(id)),
      recentOrders: (id) => slow(null)().then(() => base.recentOrders(id)),
      activities: (id, d) => slow(null)().then(() => base.activities(id, d)),
    },
    { now: NOW },
  );
  assert(view.accounts.ok);
  assertEquals(peak, DEFAULT_CONCURRENCY);
});

Deno.test("buildPortfolio: activity window start date", async () => {
  let seen = "";
  await buildPortfolio(fakeClient({ activities: (_id, start) => ((seen = start), Promise.resolve([])) }), {
    now: NOW,
    activityDays: 30,
  });
  assertEquals(seen, "2026-09-12");
});

Deno.test("summarize: per-currency totals, cash-equivalent not double counted, allocation pct", async () => {
  const view = await buildPortfolio(fakeClient(), { now: NOW });
  const s = summarize(view);
  // 账户总值按报告币种(券商已折算);现金/持仓按交易币种,两套口径分开
  assertEquals(s.accountTotals, [
    { amount: 4000, currency: "CAD" },
    { amount: 500, currency: "USD" },
  ]);
  assertEquals(s.byCurrency, [
    // positions: 3 accounts × XYZ 500 CAD;cash-equivalent CASHX 排除
    { currency: "CAD", cash: 300, positionsValue: 1500 },
  ]);
  const cad = s.allocation.filter((a) => a.currency === "CAD");
  assertEquals(cad.map((a) => [a.accountId, a.pct]), [["nonreg", 75], ["tfsa", 25]]);
  assertEquals(s.allocation.find((a) => a.accountId === "usd")!.pct, 100);
  assert(!s.allocation.some((a) => a.accountId === "old"), "closed accounts excluded");
  assert(!s.allocation.some((a) => a.accountId === "card"), "credit card / LOC excluded");
  assertEquals(s.openAccounts, 3);
});

Deno.test("summarize: stale connections and missing values are counted", () => {
  const view: PortfolioView = {
    retrievedAt: NOW.toISOString(),
    activityDays: 30,
    connections: { ok: true, data: [toConnection({ id: "c", disabled: true })] },
    accounts: {
      ok: true,
      data: [{
        ...toAccountBase({ id: "a", status: "open", balance: { total: null } }),
        balances: { ok: true, data: [] },
        positions: {
          ok: true,
          data: {
            asOf: null,
            items: [toPosition({ instrument: { symbol: "X" }, units: 1, price: null, currency: "USD" })],
          },
        },
        orders: { ok: true, data: [] },
        activity: { ok: true, data: [] },
        activityTruncated: false,
      }],
    },
  };
  const s = summarize(view);
  assertEquals(s.staleConnections, 1);
  assertEquals(s.missingValues, 2); // 账户总值缺失 + 持仓价格缺失
});

// ---------- 错误脱敏 ----------

Deno.test("describeError: strips echoed clientId and query credentials", () => {
  assertEquals(
    describeError({ status: 401, responseBody: { detail: "Invalid clientId provided - SECRETVALUE123" } }),
    "HTTP 401: Invalid clientId provided",
  );
  const msg = describeError(new Error("GET /accounts?clientId=ABC&timestamp=123 failed, Signature=xyz"));
  assert(!msg.includes("ABC") && !msg.includes("xyz"), msg);
});
