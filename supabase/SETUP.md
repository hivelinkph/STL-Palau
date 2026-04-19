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
- `live_feed_state` — singleton row driving the homepage hero (photos vs. live draw)
- `draw_results` — OCR or manual draw results per slot (10 AM / 3 PM / 7 PM) per game (d2 / d3 / pairs)
- A trigger that auto-creates a profile on signup
- RPC functions `topup_wallet`, `withdraw_wallet`, `place_bet`, `resolve_draw` (atomic, SECURITY DEFINER)
- Row Level Security so users only ever see their own data; `draw_results` is public-read, admin-write
- Realtime enabled on `live_feed_state` and `draw_results` so updates propagate instantly

## Admin account

The admin is hard-coded to **`hivelinkph@gmail.com`**. Sign up (or sign in) with that email on the homepage and you'll be redirected to `admin.html`. Only this email can `UPDATE live_feed_state` (enforced by RLS via `auth.jwt() ->> 'email'`).

The admin dashboard lets you:
- Toggle the homepage hero between **Photo Gallery** and **Live Draw**.
- Broadcast your phone camera over WebRTC to every viewer on the homepage. Signaling runs on the Supabase Realtime channel `stl-live-draw` — no extra infrastructure.
- **Auto-detect draw results (Gemini 3 Pro vision)**: toggle on the Broadcast tab. Every 10 seconds the scanner grabs a frame from the local camera preview, POSTs it to `gemini-3-pro:generateContent` with a strict JSON-only extraction prompt, and upserts any detected `DIGIT 2 XX`, `DIGIT 3 XXX`, or `PAIRS XX` to `draw_results`. Paste a Gemini API key ([get one free](https://aistudio.google.com/app/apikey)) into the field next to the checkbox — the key is stored in `localStorage` on the admin browser, never in the repo. The draw slot (10 AM / 3 PM / 7 PM) is chosen by nearest local time.
- **Manual override / payout**: use the "Manual entry / override" panel if OCR misreads. Calls `resolve_draw(p_draw_time, p_game, p_numbers)` which upserts the result AND atomically pays every winning pending bet in a ±6h window around the slot (multipliers: D2=70×, D3=500×, Pairs=40×).

For broadcasts across symmetric NATs (cellular → cellular), you'll eventually need a TURN server; the STUN-only config ships as default and works on most Wi-Fi/home networks.

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
