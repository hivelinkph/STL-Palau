/* ═══════════════════════════════════════════════════════════
   STL Palau — app.js
   Auth, Wallet, Betting, History
   ─────────────────────────────────────────────────────────── */

// ═══ CONFIG ════════════════════════════════════════════════
// Paste your Supabase credentials here to go live.
// Leave blank to run in demo / localStorage mode.
const SUPABASE_URL = window.STL_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.STL_SUPABASE_ANON_KEY || '';
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// ═══ GAME CATALOG ══════════════════════════════════════════
const GAMES = {
  digits2: { id:'digits2', name:'Palau Digits 2', digits:2, range:[0,9], min:0.25, mult:70,  max:3500  },
  digits3: { id:'digits3', name:'Palau Digits 3', digits:3, range:[0,9], min:0.25, mult:400, max:20000 },
  pairs:   { id:'pairs',   name:'Palau Pairs',    digits:2, range:[1,40],min:0.50, mult:400, max:20000 },
};

// ═══ BACKEND ABSTRACTION ═══════════════════════════════════
const backend = USE_SUPABASE ? supabaseBackend() : localBackend();

function supabaseBackend() {
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return {
    mode: 'supabase',
    async signUp(email, password, fullName) {
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { data: { full_name: fullName } }
      });
      if (error) throw error;
      return data.user;
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data.user;
    },
    async signOut() { await sb.auth.signOut(); },
    async getUser() {
      const { data } = await sb.auth.getSession();
      return data?.session?.user || null;
    },
    async getProfile(userArg) {
      const user = userArg || await this.getUser();
      if (!user) return null;
      const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
      if (error) throw error;
      return data;
    },
    async topUp(amount, method) {
      const { data, error } = await sb.rpc('topup_wallet', { p_amount: amount, p_method: method });
      if (error) throw error;
      return Number(data);
    },
    async withdraw(amount, method) {
      const { data, error } = await sb.rpc('withdraw_wallet', { p_amount: amount, p_method: method });
      if (error) throw error;
      return Number(data);
    },
    async placeBet(game, numbers, betType, stake, drawTime) {
      const { data, error } = await sb.rpc('place_bet', {
        p_game: game, p_numbers: numbers, p_bet_type: betType,
        p_stake: stake, p_draw_time: drawTime
      });
      if (error) throw error;
      return data;
    },
    async listBets(limit=50) {
      const { data, error } = await sb.from('bets').select('*').order('created_at', { ascending:false }).limit(limit);
      if (error) throw error;
      return data;
    },
    async listWalletTx(limit=50) {
      const { data, error } = await sb.from('wallet_transactions').select('*').order('created_at', { ascending:false }).limit(limit);
      if (error) throw error;
      return data;
    },
    onAuthChange(cb) {
      sb.auth.onAuthStateChange((_evt, sess) => {
        // Queue to a microtask so we never re-enter the auth lock held by the SDK
        Promise.resolve().then(() => cb(sess?.user || null));
      });
    },
  };
}

function localBackend() {
  const K = {
    users: 'stl_users',
    session: 'stl_session',
    profiles: 'stl_profiles',
    wtx: 'stl_wallet_tx',
    bets: 'stl_bets',
  };
  const read = (k, def=[]) => JSON.parse(localStorage.getItem(k) || JSON.stringify(def));
  const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const uid = () => 'u_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
  const listeners = [];

  const getProfiles = () => read(K.profiles, {});
  const setProfile = (id, p) => {
    const all = getProfiles(); all[id] = p; write(K.profiles, all);
  };

  return {
    mode: 'local',
    async signUp(email, password, fullName) {
      const users = read(K.users, {});
      if (users[email]) throw new Error('Email already registered');
      const id = uid();
      users[email] = { id, email, password, full_name: fullName };
      write(K.users, users);
      setProfile(id, { id, email, full_name: fullName, wallet_balance: 0, created_at: new Date().toISOString() });
      write(K.session, { id, email });
      listeners.forEach(cb => cb({ id, email }));
      return { id, email };
    },
    async signIn(email, password) {
      const users = read(K.users, {});
      const u = users[email];
      if (!u || u.password !== password) throw new Error('Invalid email or password');
      write(K.session, { id: u.id, email });
      listeners.forEach(cb => cb({ id: u.id, email }));
      return { id: u.id, email };
    },
    async signOut() {
      localStorage.removeItem(K.session);
      listeners.forEach(cb => cb(null));
    },
    async getUser() {
      return read(K.session, null);
    },
    async getProfile(userArg) {
      const s = userArg || read(K.session, null);
      if (!s) return null;
      return getProfiles()[s.id] || null;
    },
    async topUp(amount, method) {
      const s = read(K.session, null); if (!s) throw new Error('not authenticated');
      if (amount <= 0) throw new Error('amount must be positive');
      const p = getProfiles()[s.id];
      p.wallet_balance = Number(p.wallet_balance) + Number(amount);
      setProfile(s.id, p);
      const tx = read(K.wtx, []);
      tx.unshift({
        id: uid(), user_id: s.id, type:'topup', method,
        amount, direction:'credit', status:'completed',
        balance_after: p.wallet_balance, created_at: new Date().toISOString()
      });
      write(K.wtx, tx);
      return p.wallet_balance;
    },
    async withdraw(amount, method) {
      const s = read(K.session, null); if (!s) throw new Error('not authenticated');
      if (amount <= 0) throw new Error('amount must be positive');
      const p = getProfiles()[s.id];
      if (Number(p.wallet_balance) < amount) throw new Error('insufficient balance');
      p.wallet_balance = Number(p.wallet_balance) - Number(amount);
      setProfile(s.id, p);
      const tx = read(K.wtx, []);
      tx.unshift({
        id: uid(), user_id: s.id, type:'withdraw', method,
        amount, direction:'debit', status:'completed',
        balance_after: p.wallet_balance, created_at: new Date().toISOString()
      });
      write(K.wtx, tx);
      return p.wallet_balance;
    },
    async placeBet(game, numbers, betType, stake, drawTime) {
      const s = read(K.session, null); if (!s) throw new Error('not authenticated');
      if (stake <= 0) throw new Error('stake must be positive');
      const p = getProfiles()[s.id];
      if (Number(p.wallet_balance) < stake) throw new Error('insufficient balance');
      p.wallet_balance = Number(p.wallet_balance) - Number(stake);
      setProfile(s.id, p);
      const betId = uid();
      const bets = read(K.bets, []);
      bets.unshift({
        id: betId, user_id: s.id, game, numbers, bet_type: betType,
        stake, draw_time: drawTime, status:'pending', payout: 0,
        created_at: new Date().toISOString()
      });
      write(K.bets, bets);
      const tx = read(K.wtx, []);
      tx.unshift({
        id: uid(), user_id: s.id, type:'bet', amount: stake, direction:'debit',
        status:'completed', reference: betId, balance_after: p.wallet_balance,
        created_at: new Date().toISOString()
      });
      write(K.wtx, tx);
      return betId;
    },
    async listBets(limit=50) {
      const s = read(K.session, null); if (!s) return [];
      return read(K.bets, []).filter(b => b.user_id === s.id).slice(0, limit);
    },
    async listWalletTx(limit=50) {
      const s = read(K.session, null); if (!s) return [];
      return read(K.wtx, []).filter(t => t.user_id === s.id).slice(0, limit);
    },
    onAuthChange(cb) { listeners.push(cb); },
  };
}

// ═══ HELPERS ═══════════════════════════════════════════════
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const fmtMoney = n => '$' + Number(n||0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
const fmtDate = iso => {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
};
function toast(msg, type='info') {
  const t = document.createElement('div');
  t.className = `stl-toast stl-toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}
function nextDrawTime() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone:'Pacific/Palau' }));
  const draws = [10, 15, 20];
  const h = now.getHours(), m = now.getMinutes();
  const nowMin = h*60+m;
  let nextH = draws.find(dh => dh*60 > nowMin);
  const target = new Date(now);
  if (!nextH) { nextH = draws[0]; target.setDate(target.getDate()+1); }
  target.setHours(nextH, 0, 0, 0);
  return target.toISOString();
}

// ═══ MODALS ════════════════════════════════════════════════
function openModal(id) {
  $(`#${id}`).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  $(`#${id}`).classList.remove('open');
  document.body.style.overflow = '';
}
function closeAllModals() {
  $$('.stl-modal.open').forEach(m => m.classList.remove('open'));
  document.body.style.overflow = '';
}

// ═══ AUTH UI ═══════════════════════════════════════════════
function showAuthTab(tab) {
  $$('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#auth-signup-form').style.display = tab === 'signup' ? 'flex' : 'none';
  $('#auth-login-form').style.display  = tab === 'login'  ? 'flex' : 'none';
  $('#auth-error').textContent = '';
}

async function handleSignup(e) {
  e.preventDefault();
  const name = $('#su-name').value.trim();
  const email = $('#su-email').value.trim();
  const pw = $('#su-password').value;
  const err = $('#auth-error');
  err.textContent = '';
  if (pw.length < 6) { err.textContent = 'Password must be at least 6 characters'; return; }
  try {
    $('#su-submit').disabled = true;
    await backend.signUp(email, pw, name);
    toast('Account created — welcome!', 'success');
    closeModal('auth-modal');
    window.location.href = 'play.html';
  } catch (ex) {
    err.textContent = ex.message || 'Could not create account';
  } finally {
    $('#su-submit').disabled = false;
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $('#li-email').value.trim();
  const pw = $('#li-password').value;
  const err = $('#auth-error');
  err.textContent = '';
  try {
    $('#li-submit').disabled = true;
    await backend.signIn(email, pw);
    toast('Signed in', 'success');
    closeModal('auth-modal');
    window.location.href = 'play.html';
  } catch (ex) {
    err.textContent = ex.message || 'Could not sign in';
  } finally {
    $('#li-submit').disabled = false;
  }
}

async function handleLogout() {
  await backend.signOut();
  toast('Signed out');
  if (window.STL_PAGE === 'play') {
    window.location.href = 'index.html';
  } else {
    await refreshUser();
  }
}

// ═══ SESSION STATE ═════════════════════════════════════════
let currentProfile = null;

async function refreshUser(userArg) {
  // userArg may be passed by onAuthChange to skip a second session fetch
  const user = userArg !== undefined ? userArg : await backend.getUser();
  if (user) {
    try {
      currentProfile = await backend.getProfile(user);
    } catch (_) {
      currentProfile = null;
    }
  } else {
    currentProfile = null;
  }
  renderAuthUI();
}

function renderAuthUI() {
  const loggedOut = $('#nav-loggedout');
  const loggedIn = $('#nav-loggedin');
  if (currentProfile) {
    loggedOut.style.display = 'none';
    loggedIn.style.display = 'flex';
    $('#wallet-amount').textContent = fmtMoney(currentProfile.wallet_balance);
    $('#user-email').textContent = currentProfile.email;
    $('#user-avatar').textContent = (currentProfile.full_name || currentProfile.email)[0].toUpperCase();
  } else {
    loggedOut.style.display = 'flex';
    loggedIn.style.display = 'none';
  }
  renderPlayDashboard();
}

// ═══ PLAY PAGE DASHBOARD ═══════════════════════════════════
function renderPlayDashboard() {
  if (window.STL_PAGE !== 'play') return;
  const guard = $('#play-guard');
  const shell = $('#play-shell');
  if (!guard || !shell) return;
  if (!currentProfile) {
    guard.style.display = 'flex';
    shell.style.display = 'none';
    return;
  }
  guard.style.display = 'none';
  shell.style.display = 'block';
  $('#welcome-name').textContent = currentProfile.full_name || currentProfile.email.split('@')[0];
  $('#welcome-email').textContent = currentProfile.email;
  $('#welcome-balance').textContent = fmtMoney(currentProfile.wallet_balance);
  renderRecentBets();
}

async function renderRecentBets() {
  const body = $('#recent-bets-body');
  if (!body) return;
  const bets = await backend.listBets(5);
  if (!bets.length) {
    body.innerHTML = `<tr><td colspan="5" class="pr-empty">No bets yet — pick a game above to place your first bet.</td></tr>`;
    return;
  }
  body.innerHTML = bets.map(b => {
    const g = GAMES[b.game];
    const gameName = g ? g.name : b.game;
    const st = b.status || 'pending';
    return `<tr>
      <td>${fmtDate(b.created_at)}</td>
      <td>${gameName}</td>
      <td><span class="pr-num">${b.numbers}</span></td>
      <td>${fmtMoney(b.stake)}</td>
      <td><span class="pr-badge st-${st}">${st.toUpperCase()}</span></td>
    </tr>`;
  }).join('');
}

function updateNextDrawLabel() {
  const el = $('#welcome-countdown');
  const sub = $('#welcome-nextdraw');
  if (!el) return;
  const target = new Date(nextDrawTime()).getTime();
  const diff = Math.max(0, target - Date.now());
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  if (sub) {
    const t = new Date(target);
    const hh = t.getHours();
    const label = hh < 12 ? '10:00 AM' : hh < 17 ? '3:00 PM' : '8:00 PM';
    sub.textContent = `Next draw · ${label} PWT`;
  }
}

// ═══ WALLET — TOPUP / WITHDRAW ═════════════════════════════
let walletAction = 'topup'; // or 'withdraw'
let walletMethod = 'debit';

function openWallet(action) {
  if (!currentProfile) { openAuth('login'); return; }
  walletAction = action;
  $('#wallet-title').textContent = action === 'topup' ? 'Top Up Wallet' : 'Withdraw Funds';
  $('#wallet-submit').textContent = action === 'topup' ? 'Top Up Now' : 'Withdraw Now';
  $('#wallet-current').textContent = fmtMoney(currentProfile.wallet_balance);
  $('#wallet-amount-input').value = '';
  $('#wallet-error').textContent = '';
  walletMethod = 'debit';
  $$('.method-btn').forEach(b => b.classList.toggle('active', b.dataset.method === 'debit'));
  openModal('wallet-modal');
}

function selectMethod(method) {
  walletMethod = method;
  $$('.method-btn').forEach(b => b.classList.toggle('active', b.dataset.method === method));
}

function quickAmount(v) { $('#wallet-amount-input').value = v; }

async function handleWalletSubmit(e) {
  e.preventDefault();
  const amt = Number($('#wallet-amount-input').value);
  const err = $('#wallet-error');
  err.textContent = '';
  if (!amt || amt <= 0) { err.textContent = 'Enter a valid amount'; return; }
  try {
    $('#wallet-submit').disabled = true;
    if (walletAction === 'topup') {
      const newBal = await backend.topUp(amt, walletMethod);
      currentProfile.wallet_balance = newBal;
      toast(`Topped up ${fmtMoney(amt)} via ${methodLabel(walletMethod)}`, 'success');
    } else {
      const newBal = await backend.withdraw(amt, walletMethod);
      currentProfile.wallet_balance = newBal;
      toast(`Withdrew ${fmtMoney(amt)} via ${methodLabel(walletMethod)}`, 'success');
    }
    renderAuthUI();
    closeModal('wallet-modal');
    renderHistory();
  } catch (ex) {
    err.textContent = ex.message || 'Transaction failed';
  } finally {
    $('#wallet-submit').disabled = false;
  }
}

function methodLabel(m) {
  return { debit:'Debit Card', credit:'Credit Card', pw_cash:'PW Cash' }[m] || m;
}

// ═══ BETTING ═══════════════════════════════════════════════
let betGame = 'digits2';
let betPicks = [];

function openBet(gameId) {
  if (!currentProfile) { openAuth('login'); return; }
  betGame = gameId;
  betPicks = [];
  const g = GAMES[gameId];
  $('#bet-title').textContent = g.name;
  $('#bet-meta').textContent = `Min ${fmtMoney(g.min)} · ${g.mult}× multiplier · pick ${g.digits} from ${g.range[0]}–${g.range[1]}`;
  $('#bet-stake').value = g.min.toFixed(2);
  $('#bet-error').textContent = '';
  renderPicker();
  renderPicks();
  updatePayout();
  openModal('bet-modal');
}

function renderPicker() {
  const g = GAMES[betGame];
  const grid = $('#bet-picker');
  grid.innerHTML = '';
  for (let n = g.range[0]; n <= g.range[1]; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick-ball';
    b.textContent = g.digits === 2 && g.range[1] <= 9 ? n : String(n).padStart(2,'0');
    b.dataset.n = n;
    b.onclick = () => togglePick(n);
    grid.appendChild(b);
  }
}

function togglePick(n) {
  const g = GAMES[betGame];
  if (betPicks.length >= g.digits) betPicks = [];
  betPicks.push(n);
  renderPicks();
}

function renderPicks() {
  const g = GAMES[betGame];
  const box = $('#bet-picks');
  const slots = [];
  for (let i = 0; i < g.digits; i++) {
    const v = betPicks[i];
    const has = v !== undefined;
    const txt = has ? (g.digits === 2 && g.range[1] <= 9 ? v : String(v).padStart(2,'0')) : '?';
    slots.push(`<div class="pick-slot ${has?'filled':''}">${txt}</div>`);
  }
  box.innerHTML = slots.join('<span class="pick-sep">—</span>');
  $$('.pick-ball').forEach(b => {
    b.classList.toggle('picked', betPicks.includes(Number(b.dataset.n)));
  });
  $('#bet-submit').disabled = betPicks.length !== g.digits;
}

function clearPicks() { betPicks = []; renderPicks(); }

function updatePayout() {
  const stake = Number($('#bet-stake').value) || 0;
  const g = GAMES[betGame];
  const payout = Math.min(stake * g.mult, g.max);
  $('#bet-payout').textContent = fmtMoney(payout);
}

async function handleBetSubmit(e) {
  e.preventDefault();
  const g = GAMES[betGame];
  const stake = Number($('#bet-stake').value);
  const err = $('#bet-error');
  err.textContent = '';
  if (betPicks.length !== g.digits) { err.textContent = `Pick ${g.digits} numbers`; return; }
  if (stake < g.min) { err.textContent = `Minimum stake is ${fmtMoney(g.min)}`; return; }
  if (stake > currentProfile.wallet_balance) { err.textContent = 'Insufficient wallet balance — top up first'; return; }
  const numbers = betPicks.map(n => g.digits === 2 && g.range[1] <= 9 ? n : String(n).padStart(2,'0')).join('-');
  try {
    $('#bet-submit').disabled = true;
    await backend.placeBet(betGame, numbers, 'straight', stake, nextDrawTime());
    currentProfile.wallet_balance = Number(currentProfile.wallet_balance) - stake;
    renderAuthUI();
    toast(`Bet placed: ${numbers} for ${fmtMoney(stake)}`, 'success');
    closeModal('bet-modal');
    renderHistory();
  } catch (ex) {
    err.textContent = ex.message || 'Could not place bet';
  } finally {
    $('#bet-submit').disabled = false;
  }
}

// ═══ HISTORY ═══════════════════════════════════════════════
async function openHistory() {
  if (!currentProfile) { openAuth('login'); return; }
  showHistoryTab('bets');
  await renderHistory();
  openModal('history-modal');
}

function showHistoryTab(tab) {
  $$('.hist-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#hist-bets').style.display = tab === 'bets' ? 'block' : 'none';
  $('#hist-wallet').style.display = tab === 'wallet' ? 'block' : 'none';
}

async function renderHistory() {
  if (!currentProfile) return;
  const [bets, tx] = await Promise.all([backend.listBets(100), backend.listWalletTx(100)]);

  const betRows = bets.length ? bets.map(b => {
    const g = GAMES[b.game];
    const gameName = g ? g.name : b.game;
    const st = b.status;
    const statusBadge = `<span class="hist-badge st-${st}">${st.toUpperCase()}</span>`;
    const result = b.winning_numbers ? b.winning_numbers : '—';
    const payout = Number(b.payout||0) > 0 ? fmtMoney(b.payout) : '—';
    return `<tr>
      <td>${fmtDate(b.created_at)}</td>
      <td><strong>${gameName}</strong></td>
      <td><span class="hist-num">${b.numbers}</span></td>
      <td>${fmtMoney(b.stake)}</td>
      <td>${result}</td>
      <td>${payout}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="hist-empty">No bets yet — play a game to get started.</td></tr>`;

  $('#hist-bets-body').innerHTML = betRows;

  const txRows = tx.length ? tx.map(t => {
    const sign = t.direction === 'credit' ? '+' : '−';
    const cls = t.direction === 'credit' ? 'amt-credit' : 'amt-debit';
    const label = t.type === 'topup' ? `Top Up · ${methodLabel(t.method)}`
               : t.type === 'withdraw' ? `Withdraw · ${methodLabel(t.method)}`
               : t.type === 'bet' ? 'Bet Placed'
               : t.type === 'payout' ? 'Winnings' : t.type;
    return `<tr>
      <td>${fmtDate(t.created_at)}</td>
      <td>${label}</td>
      <td class="${cls}">${sign}${fmtMoney(t.amount)}</td>
      <td>${fmtMoney(t.balance_after)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="4" class="hist-empty">No transactions yet.</td></tr>`;

  $('#hist-wallet-body').innerHTML = txRows;
}

// ═══ AUTH MODAL OPENER ═════════════════════════════════════
function openAuth(tab='login') {
  showAuthTab(tab);
  $('#auth-error').textContent = '';
  openModal('auth-modal');
}

// ═══ BOOT ══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Mode badge
  const badge = $('#stl-mode-badge');
  if (badge) badge.textContent = USE_SUPABASE ? 'LIVE' : 'DEMO MODE';

  // Navbar bindings
  $('#btn-login').onclick = () => openAuth('login');
  $('#btn-register').onclick = () => openAuth('signup');
  $('#btn-topup').onclick = () => openWallet('topup');
  $('#btn-withdraw').onclick = () => openWallet('withdraw');
  $('#btn-history').onclick = () => openHistory();
  $('#btn-logout').onclick = () => handleLogout();

  // Auth modal
  $$('.auth-tab').forEach(t => t.onclick = () => showAuthTab(t.dataset.tab));
  $('#auth-signup-form').onsubmit = handleSignup;
  $('#auth-login-form').onsubmit = handleLogin;

  // Wallet modal
  $$('.method-btn').forEach(b => b.onclick = () => selectMethod(b.dataset.method));
  $$('.quick-amt').forEach(b => b.onclick = () => quickAmount(b.dataset.v));
  $('#wallet-form').onsubmit = handleWalletSubmit;

  // Bet modal
  $('#bet-stake').oninput = updatePayout;
  $('#bet-clear').onclick = clearPicks;
  $('#bet-form').onsubmit = handleBetSubmit;

  // History tabs
  $$('.hist-tab').forEach(t => t.onclick = () => showHistoryTab(t.dataset.tab));

  // Close buttons + backdrop
  $$('.stl-modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) closeAllModals(); });
  });
  $$('[data-close]').forEach(b => b.onclick = () => closeModal(b.dataset.close));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllModals(); });

  // Wire game cards "Play ..." buttons (index.html)
  document.querySelectorAll('.game-card').forEach(card => {
    const btn = card.querySelector('.btn-play');
    if (!btn) return;
    const gameId = card.classList.contains('card-d2') ? 'digits2'
                 : card.classList.contains('card-d3') ? 'digits3'
                 : card.classList.contains('card-pairs') ? 'pairs' : null;
    if (gameId) btn.onclick = () => openBet(gameId);
  });

  // Wire play.html game tiles
  document.querySelectorAll('.play-game').forEach(tile => {
    const gameId = tile.dataset.game;
    if (!gameId) return;
    const fire = e => { e.stopPropagation(); openBet(gameId); };
    tile.onclick = fire;
    const cta = tile.querySelector('.pg-cta');
    if (cta) cta.onclick = fire;
  });

  // Hero "Play Now" → redirect logged-in users to play.html, else scroll to games
  const heroPrimary = document.querySelector('.btn-hero-primary');
  if (heroPrimary) heroPrimary.onclick = () => {
    if (currentProfile) { window.location.href = 'play.html'; return; }
    document.getElementById('games')?.scrollIntoView({ behavior:'smooth' });
  };

  // "View full history" link on play.html
  const viewAll = $('#view-all-history');
  if (viewAll) viewAll.onclick = (e) => { e.preventDefault(); openHistory(); };

  // Play-page countdown
  if (window.STL_PAGE === 'play') {
    updateNextDrawLabel();
    setInterval(updateNextDrawLabel, 1000);
  }

  backend.onAuthChange(refreshUser);
  await refreshUser();
});

// Expose for inline handlers if needed
window.STL = { openAuth, openWallet, openBet, openHistory };
