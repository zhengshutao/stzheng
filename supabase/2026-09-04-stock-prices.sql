-- ============ 每日收盘价(每日盈亏的唯一价格来源;替代原来的 stock_snapshots 快照体系) ============
-- 只存原始事实:某只票某天的收盘价。每日盈亏不落库,前端和同步脚本都用 src/app/lib/dailyPnl.ts
-- 从 stock_trades + stock_splits + stock_prices 现算,交易记录一改日历立刻跟着变,不存在"快照过期"。
-- 价格不分用户(全局共享);由本地脚本 scripts/prices/sync-prices.mjs 用 secret key 写入
-- (雅虎财经 chart 接口拉日K),浏览器端只读。
-- 存的是"当时的原始收盘价"(雅虎返回的是按后来拆股回调过的价,脚本用拆股事件还原回去),
-- 和 stock_trades.price 同一口径,所以历史价一旦存下就不会再变。
-- 汇率也存在这张表里:ticker='USDCAD', currency='FX'。
-- 期权:WS 导出的 OCC 代码(如 "TSLA  260706C00405000")按"每张合约"存价(雅虎每股价 ×100),
-- 和 stock_trades.price 同一口径。
create table if not exists public.stock_prices (
  ticker     text not null,
  currency   text not null,
  date       date not null,
  close      numeric not null,
  symbol     text,                       -- 实际取价用的雅虎代码(XSP.TO / TSLA260706C00405000 / USDCAD=X)
  fetched_at timestamptz not null default now(),
  primary key (ticker, currency, date)
);
alter table public.stock_prices enable row level security;
drop policy if exists "read all" on public.stock_prices;
create policy "read all" on public.stock_prices for select to authenticated using (true);

-- 每个 ticker+币种 的同步状态:雅虎代码解析结果、已同步到哪天、拆股数(变了要整段重拉,
-- 因为雅虎会把拆股前的历史价回调)、最近一次错误。
create table if not exists public.stock_price_symbols (
  ticker        text not null,
  currency      text not null,
  symbol        text,                    -- 解析出来的雅虎代码;null = 雅虎没有这只票的数据
  price_scale   numeric not null default 1,
  through_date  date,                    -- 收盘价已完整同步到这一天(含)
  split_count   integer not null default 0,   -- stock_splits 里这只票的拆股记录数(仅供核对)
  yahoo_splits  jsonb,                   -- 雅虎返回的拆股事件 [{date, ratio}],用来核对 stock_splits 有没有漏记
  status        text not null default 'ok',   -- 'ok' | 'not_found' | 'error'
  last_error    text,
  updated_at    timestamptz not null default now(),
  primary key (ticker, currency)
);
alter table public.stock_price_symbols enable row level security;
drop policy if exists "read all" on public.stock_price_symbols;
create policy "read all" on public.stock_price_symbols for select to authenticated using (true);

-- 导入日志加两列:同步前后每日盈亏对比(哪几天新增/修改/消失,金额从多少到多少)+ 行情同步结果。
alter table public.import_logs add column if not exists pnl_diff jsonb;
alter table public.import_logs add column if not exists price_sync jsonb;
alter table public.import_logs add column if not exists trade_changes jsonb;   -- 本次新增/修改的成交明细(给人看)
