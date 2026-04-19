-- STL Palau — Supabase schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run)

-- ─── PROFILES ─────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  wallet_balance numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

-- ─── WALLET TRANSACTIONS ──────────────────────────────
create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('topup','withdraw','bet','payout')),
  method text,
  amount numeric(12,2) not null check (amount > 0),
  direction text not null check (direction in ('credit','debit')),
  status text not null default 'completed',
  reference text,
  balance_after numeric(12,2),
  created_at timestamptz not null default now()
);
create index if not exists wtx_user_time_idx on public.wallet_transactions(user_id, created_at desc);

-- ─── BETS ─────────────────────────────────────────────
create table if not exists public.bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  game text not null,
  numbers text not null,
  bet_type text,
  stake numeric(12,2) not null check (stake > 0),
  draw_time timestamptz not null,
  status text not null default 'pending' check (status in ('pending','won','lost','voided')),
  winning_numbers text,
  payout numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists bets_user_time_idx on public.bets(user_id, created_at desc);
create index if not exists bets_draw_idx on public.bets(draw_time, game);

-- ─── AUTO-CREATE PROFILE ON SIGNUP ────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── RLS ──────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.bets enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update using (auth.uid() = id);

drop policy if exists wtx_select_own on public.wallet_transactions;
create policy wtx_select_own on public.wallet_transactions for select using (auth.uid() = user_id);

drop policy if exists bets_select_own on public.bets;
create policy bets_select_own on public.bets for select using (auth.uid() = user_id);

-- ─── RPC: atomic topup ────────────────────────────────
create or replace function public.topup_wallet(p_amount numeric, p_method text)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_new numeric;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if p_method not in ('debit','credit','pw_cash') then raise exception 'invalid method'; end if;
  update public.profiles set wallet_balance = wallet_balance + p_amount
    where id = v_user returning wallet_balance into v_new;
  insert into public.wallet_transactions(user_id, type, method, amount, direction, balance_after)
    values (v_user, 'topup', p_method, p_amount, 'credit', v_new);
  return v_new;
end $$;

-- ─── RPC: atomic withdraw ─────────────────────────────
create or replace function public.withdraw_wallet(p_amount numeric, p_method text)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_cur numeric;
  v_new numeric;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  select wallet_balance into v_cur from public.profiles where id = v_user for update;
  if v_cur < p_amount then raise exception 'insufficient balance'; end if;
  update public.profiles set wallet_balance = wallet_balance - p_amount
    where id = v_user returning wallet_balance into v_new;
  insert into public.wallet_transactions(user_id, type, method, amount, direction, balance_after)
    values (v_user, 'withdraw', p_method, p_amount, 'debit', v_new);
  return v_new;
end $$;

-- ─── LIVE FEED STATE (admin-controlled singleton) ────
create table if not exists public.live_feed_state (
  id int primary key default 1,
  mode text not null default 'photos' check (mode in ('photos','live')),
  updated_at timestamptz not null default now(),
  constraint live_feed_state_singleton check (id = 1)
);
insert into public.live_feed_state(id, mode) values (1, 'photos')
  on conflict (id) do nothing;

alter table public.live_feed_state enable row level security;

drop policy if exists lfs_select_all on public.live_feed_state;
create policy lfs_select_all on public.live_feed_state
  for select using (true);

drop policy if exists lfs_update_admin on public.live_feed_state;
create policy lfs_update_admin on public.live_feed_state
  for update
  using (auth.jwt() ->> 'email' = 'hivelinkph@gmail.com')
  with check (auth.jwt() ->> 'email' = 'hivelinkph@gmail.com');

-- Enable realtime on live_feed_state (ignore if already enabled)
do $$ begin
  execute 'alter publication supabase_realtime add table public.live_feed_state';
exception when others then null;
end $$;

-- ─── DRAW RESULTS (OCR or manual) ─────────────────────
create table if not exists public.draw_results (
  id uuid primary key default gen_random_uuid(),
  draw_time timestamptz not null,
  game text not null check (game in ('d2','d3','pairs')),
  numbers text not null,
  source text not null default 'ocr' check (source in ('ocr','manual')),
  raw_text text,
  created_at timestamptz not null default now(),
  unique (draw_time, game)
);
create index if not exists draw_results_time_idx on public.draw_results(draw_time desc);

alter table public.draw_results enable row level security;

drop policy if exists dr_select_all on public.draw_results;
create policy dr_select_all on public.draw_results
  for select using (true);

drop policy if exists dr_write_admin on public.draw_results;
create policy dr_write_admin on public.draw_results
  for all
  using (auth.jwt() ->> 'email' = 'hivelinkph@gmail.com')
  with check (auth.jwt() ->> 'email' = 'hivelinkph@gmail.com');

do $$ begin
  execute 'alter publication supabase_realtime add table public.draw_results';
exception when others then null;
end $$;

-- ─── music_tracks: shared broadcast playlist (admin-write, public-read) ─────
create table if not exists public.music_tracks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  vibe text not null default 'Custom',
  url text not null,
  is_preset boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists music_tracks_sort_idx on public.music_tracks(sort_order, created_at);

alter table public.music_tracks enable row level security;
drop policy if exists mt_select_all on public.music_tracks;
create policy mt_select_all on public.music_tracks for select using (true);
drop policy if exists mt_write_admin on public.music_tracks;
create policy mt_write_admin on public.music_tracks for all
  using (auth.jwt() ->> 'email' = 'hivelinkph@gmail.com')
  with check (auth.jwt() ->> 'email' = 'hivelinkph@gmail.com');

do $$ begin
  execute 'alter publication supabase_realtime add table public.music_tracks';
exception when others then null;
end $$;

-- ─── graphics: overlay image library (admin-write, public-read) ─────
-- Images are uploaded to the 'graphics' Storage bucket; this table stores
-- name + public URL + storage_path so admin can delete / reorder later.
create table if not exists public.graphics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  storage_path text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists graphics_sort_idx on public.graphics(sort_order, created_at);

alter table public.graphics enable row level security;
drop policy if exists gfx_select_all on public.graphics;
create policy gfx_select_all on public.graphics for select using (true);
drop policy if exists gfx_write_admin on public.graphics;
create policy gfx_write_admin on public.graphics for all
  using (auth.jwt() ->> 'email' = 'hivelinkph@gmail.com')
  with check (auth.jwt() ->> 'email' = 'hivelinkph@gmail.com');

do $$ begin
  execute 'alter publication supabase_realtime add table public.graphics';
exception when others then null;
end $$;

-- ─── Storage bucket 'graphics' (public-read, admin-write) ─────
insert into storage.buckets (id, name, public)
values ('graphics', 'graphics', true)
on conflict (id) do update set public = true;

drop policy if exists "graphics_read_public" on storage.objects;
create policy "graphics_read_public" on storage.objects
  for select using (bucket_id = 'graphics');

drop policy if exists "graphics_write_admin" on storage.objects;
create policy "graphics_write_admin" on storage.objects
  for all
  using (bucket_id = 'graphics' and auth.jwt() ->> 'email' = 'hivelinkph@gmail.com')
  with check (bucket_id = 'graphics' and auth.jwt() ->> 'email' = 'hivelinkph@gmail.com');

-- ─── RPC: resolve draw + pay winners (admin only) ─────
create or replace function public.resolve_draw(
  p_draw_time timestamptz, p_game text, p_numbers text
)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_email text := auth.jwt() ->> 'email';
  v_bet record;
  v_multiplier numeric;
  v_payout numeric;
  v_bal numeric;
  v_paid int := 0;
  v_window_start timestamptz := p_draw_time - interval '6 hours';
  v_window_end timestamptz := p_draw_time + interval '6 hours';
begin
  if v_email is null or v_email <> 'hivelinkph@gmail.com' then
    raise exception 'not authorized';
  end if;
  if p_game not in ('d2','d3','pairs') then raise exception 'invalid game'; end if;

  insert into public.draw_results(draw_time, game, numbers, source)
    values (p_draw_time, p_game, p_numbers, 'manual')
    on conflict (draw_time, game) do update
      set numbers = excluded.numbers, source = excluded.source;

  v_multiplier := case p_game when 'd2' then 70 when 'd3' then 500 when 'pairs' then 40 end;

  for v_bet in
    select * from public.bets
    where status = 'pending'
      and game = p_game
      and draw_time between v_window_start and v_window_end
    for update
  loop
    if v_bet.numbers = p_numbers then
      v_payout := v_bet.stake * v_multiplier;
      update public.profiles set wallet_balance = wallet_balance + v_payout
        where id = v_bet.user_id returning wallet_balance into v_bal;
      update public.bets set status = 'won', winning_numbers = p_numbers,
        payout = v_payout where id = v_bet.id;
      insert into public.wallet_transactions(user_id, type, amount, direction, balance_after, reference)
        values (v_bet.user_id, 'payout', v_payout, 'credit', v_bal, v_bet.id::text);
      v_paid := v_paid + 1;
    else
      update public.bets set status = 'lost', winning_numbers = p_numbers
        where id = v_bet.id;
    end if;
  end loop;

  return v_paid;
end $$;

-- ─── RPC: atomic place_bet ────────────────────────────
create or replace function public.place_bet(
  p_game text, p_numbers text, p_bet_type text,
  p_stake numeric, p_draw_time timestamptz
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_cur numeric;
  v_new numeric;
  v_bet_id uuid;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if p_stake <= 0 then raise exception 'stake must be positive'; end if;
  select wallet_balance into v_cur from public.profiles where id = v_user for update;
  if v_cur < p_stake then raise exception 'insufficient balance'; end if;
  update public.profiles set wallet_balance = wallet_balance - p_stake
    where id = v_user returning wallet_balance into v_new;
  insert into public.bets(user_id, game, numbers, bet_type, stake, draw_time)
    values (v_user, p_game, p_numbers, p_bet_type, p_stake, p_draw_time)
    returning id into v_bet_id;
  insert into public.wallet_transactions(user_id, type, amount, direction, balance_after, reference)
    values (v_user, 'bet', p_stake, 'debit', v_new, v_bet_id::text);
  return v_bet_id;
end $$;
