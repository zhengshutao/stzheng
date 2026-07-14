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

drop policy if exists "own read" on public.stock_trades;
create policy "own read" on public.stock_trades for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own read" on public.stock_cash;
create policy "own read" on public.stock_cash for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own read" on public.stock_snapshots;
create policy "own read" on public.stock_snapshots for select to authenticated using (auth.uid() = user_id);
