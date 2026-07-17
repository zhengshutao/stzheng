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

-- ============ 网页端下单/出入金: 登录用户可写自己的记录 ============
drop policy if exists "own insert" on public.stock_trades;
create policy "own insert" on public.stock_trades for insert to authenticated with check (auth.uid() = user_id);
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
