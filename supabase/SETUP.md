# STL Palau — Supabase Setup

The app ships in **DEMO MODE** (saves to browser `localStorage`). Follow these steps to switch it to a real Supabase project.

## 1. Create the project
1. Go to https://supabase.com → **New Project**
2. Pick a region (Singapore recommended for Palau latency)
3. Save the DB password somewhere safe

## 2. Apply the schema
1. Open **SQL Editor** in your Supabase dashboard
2. New query → paste the contents of [`schema.sql`](./schema.sql) → **Run**

You now have:
- `profiles` — one row per user, wallet_balance included
- `wallet_transactions` — topup / withdraw / bet / payout ledger
- `bets` — every bet with status + payout
- A trigger that auto-creates a profile on signup
- RPC functions `topup_wallet`, `withdraw_wallet`, `place_bet` (atomic, SECURITY DEFINER)
- Row Level Security so users only ever see their own data

## 3. Wire the credentials
Open `index.html`, find this block near the bottom:

```html
<script>
  window.STL_SUPABASE_URL = '';
  window.STL_SUPABASE_ANON_KEY = '';
</script>
```

Paste your values from **Project Settings → API**:
- `URL` → `STL_SUPABASE_URL`
- `anon public` key → `STL_SUPABASE_ANON_KEY`

Reload the page. The navbar badge switches from **DEMO MODE** → **LIVE**, and all auth / wallet / bet data now persists to Postgres.

## 4. (Optional) Email confirmation
By default Supabase sends a confirmation email on signup. For faster testing:
- **Auth → Providers → Email** → toggle **Confirm email** OFF

Turn it back on for production.

## Data model cheat sheet

| Table | Purpose |
|---|---|
| `profiles.wallet_balance` | Source of truth for wallet amount |
| `wallet_transactions` | Every debit/credit with `balance_after` snapshot |
| `bets` | `status` moves pending → won/lost; `payout` is set when resolved |

Atomic RPCs (cannot be bypassed from the client):
- `topup_wallet(amount, method)` — method ∈ `debit`, `credit`, `pw_cash`
- `withdraw_wallet(amount, method)` — fails if insufficient balance
- `place_bet(game, numbers, bet_type, stake, draw_time)` — fails if insufficient balance

## Resolving bets (future work)
Bets are created as `pending`. To settle them after a draw, run something like:

```sql
-- After a draw concludes:
update bets set
  status = case when numbers = :winning then 'won' else 'lost' end,
  winning_numbers = :winning,
  payout = case when numbers = :winning then least(stake * :multiplier, :max) else 0 end
where game = :game and date_trunc('day', draw_time) = current_date;

-- Credit winners:
-- (do this per winning bet, inside a transaction)
```

A scheduled Edge Function or Cron Job is the right place for this.
