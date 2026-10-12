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
