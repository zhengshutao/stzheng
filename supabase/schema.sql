-- Dashboard 数据表: 日常收支 + 股票交易/入出金 + 每日组合市值快照
-- 在 Supabase Dashboard → SQL Editor 里整段执行一次即可。
-- 写入全部由本地同步脚本用 secret key 完成(绕过 RLS);
-- 浏览器端(publishable key + 登录 session)只读自己的数据。

-- ============ 日常收支(来自 记账/data.db) ============
create table if not exists public.daily_transactions (
  id          text primary key,          -- 本地 transaction_id
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  name        text,
  merchant    text,
  amount      numeric not null,          -- Plaid 约定: >0 支出, <0 收入
  currency    text not null default 'CAD',
  category    text,
  note        text,
  is_transfer boolean not null default false,
  pending     boolean not null default false,
  source      text,
  synced_at   timestamptz not null default now()
);
create index if not exists idx_daily_tx_user_date on public.daily_transactions (user_id, date);

-- ============ 股票交易(来自 stock/trades.json) ============
create table if not exists public.stock_trades (
  id           text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  date         date not null,
  ts           text,
  ticker       text not null,
  side         text not null check (side in ('buy','sell')),
  qty          numeric not null,
  price        numeric not null,
  currency     text not null,
  fees         numeric not null default 0,
  account      text,
  realized_pnl numeric,
  note         text,
  initial_stop numeric,             -- 买入时设置的开仓止损,作为动量止损棘轮的下限
  synced_at    timestamptz not null default now()
);
create index if not exists idx_stock_trades_user_date on public.stock_trades (user_id, date);

-- ============ 券商入金/出金 ============
create table if not exists public.stock_cash (
  id        text primary key,
  user_id   uuid not null references auth.users(id) on delete cascade,
  date      date not null,
  ts        text,
  type      text not null check (type in ('deposit','withdraw')),
  amount    numeric not null,
  currency  text not null,
  account   text,
  note      text,
  synced_at timestamptz not null default now()
);
create index if not exists idx_stock_cash_user_date on public.stock_cash (user_id, date);

-- ============ 拆股/合股/并购换股(改变持仓股数但没有成交价的公司行为) ============
-- ratio: 换股后股数 = 换股前股数 * ratio(比如 2:1 拆股 ratio=2,1:10 合股 ratio=0.1)。
-- replay() 撮合时按 ts 顺序插入,把当时该 ticker+currency+account 名下所有未平仓 lot 的
-- qty 乘以 ratio、price 除以 ratio(总成本不变),这样后续 FIFO 卖出才能正确配对股数。
create table if not exists public.stock_splits (
  id        text primary key,
  user_id   uuid not null references auth.users(id) on delete cascade,
  date      date not null,
  ts        text,
  ticker    text not null,
  currency  text not null,
  account   text,
  ratio     numeric not null,
  note      text,
  synced_at timestamptz not null default now()
);
create index if not exists idx_stock_splits_user_date on public.stock_splits (user_id, date);
alter table public.stock_splits enable row level security;
drop policy if exists "own read" on public.stock_splits;
create policy "own read" on public.stock_splits for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own insert" on public.stock_splits;
create policy "own insert" on public.stock_splits for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "own update" on public.stock_splits;
create policy "own update" on public.stock_splits for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own delete" on public.stock_splits;
create policy "own delete" on public.stock_splits for delete to authenticated using (auth.uid() = user_id);

-- ============ 每日组合市值快照(现金+持仓, 折 CAD) ============
create table if not exists public.stock_snapshots (
  user_id             uuid not null references auth.users(id) on delete cascade,
  date                date not null,
  value_cad           numeric not null,  -- 现金 + 持仓市值, 全部折 CAD
  cash_cad            numeric,
  positions_value_cad numeric,
  fx_usdcad           numeric,           -- 当日折算用的 USD→CAD 汇率
  positions           jsonb,             -- [{ticker, qty, price, currency}]
  synced_at           timestamptz not null default now(),
  primary key (user_id, date)
);

-- ============ RLS: 登录用户只读自己的数据 ============
alter table public.daily_transactions enable row level security;
alter table public.stock_trades       enable row level security;
alter table public.stock_cash         enable row level security;
alter table public.stock_snapshots    enable row level security;

drop policy if exists "own read" on public.daily_transactions;
create policy "own read" on public.daily_transactions for select to authenticated using (auth.uid() = user_id);

-- 网页端手动记账: 登录用户可增/改/删自己的记录
drop policy if exists "own insert" on public.daily_transactions;
create policy "own insert" on public.daily_transactions for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "own update" on public.daily_transactions;
create policy "own update" on public.daily_transactions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own delete" on public.daily_transactions;
create policy "own delete" on public.daily_transactions for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "own read" on public.stock_trades;
create policy "own read" on public.stock_trades for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own read" on public.stock_cash;
create policy "own read" on public.stock_cash for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own read" on public.stock_snapshots;
create policy "own read" on public.stock_snapshots for select to authenticated using (auth.uid() = user_id);
-- 浏览器端"补录今日快照"按钮需要能写(本地同步脚本没跑时兜底用)
drop policy if exists "own insert" on public.stock_snapshots;
create policy "own insert" on public.stock_snapshots for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "own update" on public.stock_snapshots;
create policy "own update" on public.stock_snapshots for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============ 网页端下单/出入金: 登录用户可写自己的记录 ============
drop policy if exists "own insert" on public.stock_trades;
create policy "own insert" on public.stock_trades for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "own update" on public.stock_trades;
create policy "own update" on public.stock_trades for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own delete" on public.stock_trades;
create policy "own delete" on public.stock_trades for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "own insert" on public.stock_cash;
create policy "own insert" on public.stock_cash for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "own delete" on public.stock_cash;
create policy "own delete" on public.stock_cash for delete to authenticated using (auth.uid() = user_id);

-- ============ 动量止损棘轮状态(止损只升不降,按持仓生命周期记忆最高止损) ============
create table if not exists public.stock_stop_ratchet (
  user_id       uuid not null references auth.users(id) on delete cascade,
  ticker        text not null,
  anchor        text not null,          -- 该持仓最早开仓 lot 的 ts,标识持仓生命周期
  stop          numeric not null,       -- 当前生效的棘轮止损位(只升不降)
  initial_floor numeric,                -- 用户在买入时设置的开仓止损(棘轮下限)
  since         date not null,
  updated_at    date not null,
  primary key (user_id, ticker)
);
alter table public.stock_stop_ratchet enable row level security;
drop policy if exists "own rw" on public.stock_stop_ratchet;
create policy "own rw" on public.stock_stop_ratchet for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============ 银行连接 + 每日同步 ============
-- 已连接银行(Plaid items)—— 只有 service role 能访问,浏览器端完全读写不到
-- (RLS 打开但故意不给 authenticated 建任何 policy,和顶部写入模式的信任边界一致)。
create table if not exists public.bank_items (
  item_id          text primary key,        -- Plaid item_id
  user_id          uuid not null references auth.users(id) on delete cascade,
  access_token     text not null,           -- Plaid access_token,等同银行凭证,绝不能到浏览器
  institution_id   text,
  institution_name text,
  cursor           text,                    -- transactionsSync 游标
  status           text not null default 'ok',  -- 'ok' | 'login_required'
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_bank_items_user on public.bank_items (user_id);
alter table public.bank_items enable row level security;

-- 交易明细标注来源银行
alter table public.daily_transactions add column if not exists institution_name text;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

-- pg_cron 定时任务(bank-sync-0000-utc / bank-sync-0100-utc,每天 UTC 00:00 与 01:00
-- 各触发一次 bank-sync edge function,函数内部按 America/Toronto 当地时间是否为晚 8 点
-- 自我判断是否真正执行,兼容夏令时切换)引用了 Vault 里的 project_url / cron_secret,
-- 含密钥引用,不适合放进这份可公开的 schema 文件 —— 具体 SQL 见部署记录,不在此重复。

-- ============ 合并记录(壳子)—— 原始交易完全不变,只是打个分组标签用于展示合并 ============
-- 比如聚餐花了 200,朋友 AA 转回 3 笔各 50:这 4 条原始记录都不动(银行同步/编辑照常),
-- 只是共享同一个 merge_group_id,前端把它们收起来显示成一条净额 50 的"壳子",
-- 拆开(merge_group_id 设回 null)随时可逆。
alter table public.daily_transactions add column if not exists merge_group_id uuid;
create index if not exists idx_daily_tx_merge_group on public.daily_transactions (merge_group_id) where merge_group_id is not null;

-- ============ Wealthsimple CSV 同步日志(scripts/wealthsimple/import-csv.mjs --apply 每次运行写一条) ============
create table if not exists public.import_logs (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  source               text not null default 'wealthsimple-csv',
  source_file          text,
  ran_at               timestamptz not null default now(),
  trades_inserted      integer not null default 0,
  trades_updated       integer not null default 0,
  cash_inserted        integer not null default 0,
  cash_updated         integer not null default 0,
  touched_dates        jsonb not null default '[]'::jsonb,   -- 本次新增/修改的 trade/cash 涉及的日期
  snapshot_dates_ok    jsonb not null default '[]'::jsonb,   -- 已存在快照、成功重算 cash_cad/value_cad 的日期
  snapshot_dates_skipped jsonb not null default '[]'::jsonb, -- 还没有快照、跳过的日期(需要手动补录)
  summary              text                                   -- 给人看的一段话总结
);
create index if not exists idx_import_logs_user_ran_at on public.import_logs (user_id, ran_at desc);
alter table public.import_logs enable row level security;
drop policy if exists "own read" on public.import_logs;
create policy "own read" on public.import_logs for select to authenticated using (auth.uid() = user_id);

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

-- ============ 自选列表(K 线页左侧的"半导体""储存"这类分组) ============
-- 一行一个列表,symbols 是有序的美股代码数组;同一只股票可以同时在多个列表里。
-- 在 Supabase SQL Editor 里跑一次即可(可重复跑)。
create table if not exists public.watchlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name       text not null,
  symbols    text[] not null default '{}',
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists watchlists_user_idx on public.watchlists (user_id, sort);

alter table public.watchlists enable row level security;
drop policy if exists "own read" on public.watchlists;
create policy "own read" on public.watchlists for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own insert" on public.watchlists;
create policy "own insert" on public.watchlists for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "own update" on public.watchlists;
create policy "own update" on public.watchlists for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own delete" on public.watchlists;
create policy "own delete" on public.watchlists for delete to authenticated using (auth.uid() = user_id);

-- ---------- SnapTrade 定时同步(edge function snaptrade-sync,pg_cron 每 10 分钟)----------
-- 已通过迁移 snaptrade_sync_runs_and_secret / snaptrade_sync_cron 应用,这里留档。
create table if not exists public.sync_runs (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  checked_at timestamptz not null default now(),
  ok boolean not null default true,
  message text,
  new_trades integer not null default 0,
  new_cash integer not null default 0,
  trigger text,
  primary key (user_id, source)
);
alter table public.sync_runs enable row level security;
drop policy if exists "sync_runs owner read" on public.sync_runs;
create policy "sync_runs owner read" on public.sync_runs for select to authenticated using ((select auth.uid()) = user_id);

-- 共享密钥只在 Vault 里(随机生成);edge function 通过只有 service_role 能调的 RPC 比对
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'snaptrade_sync_secret', 'pg_cron -> snaptrade-sync edge function')
where not exists (select 1 from vault.secrets where name = 'snaptrade_sync_secret');

create or replace function public.snaptrade_sync_secret_ok(candidate text)
returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'snaptrade_sync_secret' and decrypted_secret = candidate);
$$;
revoke all on function public.snaptrade_sync_secret_ok(text) from public, anon, authenticated;
grant execute on function public.snaptrade_sync_secret_ok(text) to service_role;

create or replace function public.invoke_snaptrade_sync()
returns bigint language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://mqelplxosqomyrufxrxg.supabase.co/functions/v1/snaptrade-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'snaptrade_sync_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$;
revoke all on function public.invoke_snaptrade_sync() from public, anon, authenticated;
select cron.schedule('snaptrade-sync', '*/10 * * * *', 'select public.invoke_snaptrade_sync()');
