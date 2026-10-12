-- ============ 止损单记录(K 线页左侧持仓下面显示的"止损 xx.xx") ============
-- Wealthsimple 经 SnapTrade 查订单时不回报 stop_price(一直是 null),
-- 所以 snaptrade-stop 每下一笔止损就在这里记一行,显示时按 brokerage_order_id 对上。
-- 在 Wealthsimple App 里手动设的止损这里没有记录,页面上显示为"价格未知"。
-- 在 Supabase SQL Editor 里跑一次即可(可重复跑)。
create table if not exists public.stock_stop_orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade default auth.uid(),
  ticker             text not null,
  account_id         text not null,
  brokerage_order_id text not null unique,
  stop_price         numeric not null,
  units              numeric not null,
  created_at         timestamptz not null default now(),
  canceled_at        timestamptz
);
create index if not exists stock_stop_orders_user_idx on public.stock_stop_orders (user_id, ticker);

alter table public.stock_stop_orders enable row level security;
drop policy if exists "own read" on public.stock_stop_orders;
create policy "own read" on public.stock_stop_orders for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own insert" on public.stock_stop_orders;
create policy "own insert" on public.stock_stop_orders for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "own update" on public.stock_stop_orders;
create policy "own update" on public.stock_stop_orders for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 止损怎么定的:ema10 / ema20 = 日线 EMA − 1%,批量更新时会跟着当天 EMA 重算;custom = 手动价格,批量更新不动它。
alter table public.stock_stop_orders add column if not exists basis text not null default 'custom';
alter table public.stock_stop_orders drop constraint if exists stock_stop_orders_basis_check;
alter table public.stock_stop_orders add constraint stock_stop_orders_basis_check check (basis in ('ema10', 'ema20', 'custom'));
