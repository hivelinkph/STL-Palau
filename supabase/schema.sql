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
