/* ═══════════════════════════════════════════════════════════
   Lucky 21 — app.js
   Auth, Wallet, Betting, History
   ─────────────────────────────────────────────────────────── */

// ═══ CONFIG ════════════════════════════════════════════════
// Paste your Supabase credentials here to go live.
// Leave blank to run in demo / localStorage mode.
const SUPABASE_URL = window.STL_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.STL_SUPABASE_ANON_KEY || '';
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const ADMIN_EMAIL = 'hivelinkph@gmail.com';
const isAdminEmail = e => (e || '').trim().toLowerCase() === ADMIN_EMAIL;
window.STL_ADMIN_EMAIL = ADMIN_EMAIL;

// ═══ GAME CATALOG ══════════════════════════════════════════
const GAMES = {
  digits2: { id:'digits2', name:'Nauru Digits 2', digits:2, range:[0,9], min:0.25, mult:70,  max:3500  },
  digits3: { id:'digits3', name:'Nauru Digits 3', digits:3, range:[0,9], min:0.25, mult:400, max:20000 },
  pairs:   { id:'pairs',   name:'Nauru Pairs',    digits:2, range:[1,40],min:0.50, mult:400, max:20000 },
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
const DRAW_SLOTS = [10, 15, 20]; // Nauru hours: 10 AM, 3 PM, 8 PM
const SLOT_LABELS = { 10: '10:00 AM', 15: '3:00 PM', 20: '8:00 PM' };

// Nauru = UTC+9, no DST — avoid Intl.DateTimeFormat quirks by using fixed offset.
function palauNowParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Nauru', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12: false,
  });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(p => parts[p.type] = p.value);
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
  };
}
function drawTimeFromParts(ymd, slotHour) {
  const [y, m, d] = ymd.split('-').map(Number);
  // Nauru wall-clock slotHour → UTC instant (Nauru = UTC+9)
  return new Date(Date.UTC(y, m - 1, d, slotHour - 9, 0, 0)).toISOString();
}
function fmtDrawSlot(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'Pacific/Nauru', month:'short', day:'numeric',
    hour:'numeric', minute:'2-digit', hour12: true,
  });
}
function nextDrawTime() {
  const { ymd, hour, minute } = palauNowParts();
  const nowMin = hour * 60 + minute;
  const nextH = DRAW_SLOTS.find(h => h * 60 > nowMin);
  if (nextH) return drawTimeFromParts(ymd, nextH);
  // No slot left today — roll to next calendar day in Nauru
  const [y, m, d] = ymd.split('-').map(Number);
  const tmr = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrow = tmr.toISOString().slice(0, 10);
  return drawTimeFromParts(tomorrow, DRAW_SLOTS[0]);
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
    window.location.href = isAdminEmail(email) ? 'admin.html' : 'play.html';
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
    window.location.href = isAdminEmail(email) ? 'admin.html' : 'play.html';
  } catch (ex) {
    err.textContent = ex.message || 'Could not sign in';
  } finally {
    $('#li-submit').disabled = false;
  }
}

async function handleLogout() {
  await backend.signOut();
  toast('Signed out');
  if (window.STL_PAGE === 'play' || window.STL_PAGE === 'admin') {
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
  // Admin lands on play.html? push them to the dashboard.
  if (currentProfile && isAdminEmail(currentProfile.email) && window.STL_PAGE === 'play') {
    window.location.replace('admin.html');
    return;
  }
  const loggedOut = $('#nav-loggedout');
  const loggedIn = $('#nav-loggedin');
  if (!loggedOut || !loggedIn) return; // admin.html has its own nav
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
    body.innerHTML = `<tr><td colspan="6" class="pr-empty">No bets yet — pick a game above to place your first bet.</td></tr>`;
    return;
  }
  body.innerHTML = bets.map(b => {
    const g = GAMES[b.game];
    const gameName = g ? g.name : b.game;
    const st = b.status || 'pending';
    return `<tr>
      <td>${fmtDate(b.created_at)}</td>
      <td>${fmtDrawSlot(b.draw_time)}</td>
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
let betDates = new Set();     // 'YYYY-MM-DD' (Nauru local dates)
let betCalY = 0, betCalM = 0; // month currently displayed (1-12)
const BET_CAL_MAX_DAYS = 60;

function openBet(gameId) {
  if (!currentProfile) { openAuth('login'); return; }
  betGame = gameId;
  betPicks = [];
  betDates = new Set();
  const g = GAMES[gameId];
  $('#bet-title').textContent = g.name;
  $('#bet-meta').textContent = `Min ${fmtMoney(g.min)} · ${g.mult}× multiplier · pick ${g.digits} from ${g.range[0]}–${g.range[1]}`;
  $('#bet-stake').value = g.min.toFixed(2);
  $('#bet-error').textContent = '';
  renderPicker();
  renderPicks();
  initBetCalendar();
  updatePayout();
  openModal('bet-modal');
}

function initBetCalendar() {
  const { ymd, hour, minute } = palauNowParts();
  const [y, m, d] = ymd.split('-').map(Number);
  betCalY = y; betCalM = m;
  // Pre-select the next open draw date
  const nowMin = hour * 60 + minute;
  const anyOpenToday = DRAW_SLOTS.some(h => h * 60 > nowMin);
  if (anyOpenToday) {
    betDates.add(ymd);
  } else {
    const tmr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    betDates.add(tmr);
  }
  // Pre-select next open slot
  const slotEl = $('#bet-draw-slot');
  if (slotEl) {
    const nextH = DRAW_SLOTS.find(h => h * 60 > nowMin) || DRAW_SLOTS[0];
    slotEl.value = String(nextH);
    slotEl.onchange = () => { renderBetCalendar(); updatePayout(); };
  }
  renderBetCalendar();
}

function palauTodayYmd() { return palauNowParts().ymd; }
function ymdAddDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function ymdCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function renderBetCalendar() {
  const host = $('#bet-cal');
  if (!host) return;
  const today = palauTodayYmd();
  const maxYmd = ymdAddDays(today, BET_CAL_MAX_DAYS);
  const chosenSlot = parseInt($('#bet-draw-slot')?.value || '0', 10);
  const { hour, minute } = palauNowParts();
  const nowMin = hour * 60 + minute;
  const todayClosed = chosenSlot > 0 && chosenSlot * 60 <= nowMin;
  // Drop any now-invalid selections (past dates, or today when slot closed)
  betDates.forEach(ymd => {
    const past = ymdCompare(ymd, today) < 0;
    const tooFar = ymdCompare(ymd, maxYmd) > 0;
    const closedToday = ymd === today && todayClosed;
    if (past || tooFar || closedToday) betDates.delete(ymd);
  });

  const monthStart = new Date(Date.UTC(betCalY, betCalM - 1, 1));
  const daysInMonth = new Date(Date.UTC(betCalY, betCalM, 0)).getUTCDate();
  const firstDow = monthStart.getUTCDay(); // 0=Sun
  const monthLabel = monthStart.toLocaleString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });

  const [minY, minM] = today.split('-').map(Number).slice(0, 2);
  const [maxY, maxM] = maxYmd.split('-').map(Number).slice(0, 2);
  const canPrev = (betCalY > minY) || (betCalY === minY && betCalM > minM);
  const canNext = (betCalY < maxY) || (betCalY === maxY && betCalM < maxM);

  const dowRow = ['S','M','T','W','T','F','S']
    .map(l => `<div class="bet-cal-dow">${l}</div>`).join('');
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<div></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const ymd = `${betCalY}-${String(betCalM).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isPast = ymdCompare(ymd, today) < 0;
    const isTooFar = ymdCompare(ymd, maxYmd) > 0;
    const isToday = ymd === today;
    const selected = betDates.has(ymd);
    const disabled = isPast || isTooFar || (isToday && todayClosed);
    const cls = ['bet-cal-day'];
    if (isToday) cls.push('today');
    if (selected) cls.push('selected');
    cells.push(`<button type="button" class="${cls.join(' ')}" data-ymd="${ymd}"${disabled ? ' disabled' : ''}>${day}</button>`);
  }

  host.innerHTML = `
    <div class="bet-cal-head">
      <button type="button" class="bet-cal-nav" data-nav="-1"${canPrev ? '' : ' disabled'} aria-label="Previous month">‹</button>
      <div class="bet-cal-title">${monthLabel}</div>
      <button type="button" class="bet-cal-nav" data-nav="1"${canNext ? '' : ' disabled'} aria-label="Next month">›</button>
    </div>
    <div class="bet-cal-grid">${dowRow}${cells.join('')}</div>
  `;
  host.querySelectorAll('.bet-cal-day').forEach(b => {
    b.onclick = () => toggleBetDate(b.dataset.ymd);
  });
  host.querySelectorAll('.bet-cal-nav').forEach(b => {
    b.onclick = () => shiftBetCalMonth(parseInt(b.dataset.nav, 10));
  });
  updateCalSummary();
}

function shiftBetCalMonth(delta) {
  betCalM += delta;
  if (betCalM < 1) { betCalM = 12; betCalY--; }
  else if (betCalM > 12) { betCalM = 1; betCalY++; }
  renderBetCalendar();
}

function toggleBetDate(ymd) {
  if (!ymd) return;
  if (betDates.has(ymd)) betDates.delete(ymd);
  else betDates.add(ymd);
  renderBetCalendar();
  updatePayout();
}

function updateCalSummary() {
  const el = $('#bet-cal-summary');
  if (!el) return;
  const count = betDates.size;
  if (count === 0) { el.innerHTML = 'Tap one or more dates above.'; return; }
  const sorted = [...betDates].sort();
  const preview = sorted.slice(0, 4).map(fmtYmd).join(', ') + (sorted.length > 4 ? ` +${sorted.length - 4} more` : '');
  el.innerHTML = `<strong>${count}</strong> draw${count === 1 ? '' : 's'} selected · ${preview}`;
}

function fmtYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
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
  refreshBetSubmitState();
}

function clearPicks() { betPicks = []; renderPicks(); }

function updatePayout() {
  const stake = Number($('#bet-stake').value) || 0;
  const g = GAMES[betGame];
  const payout = Math.min(stake * g.mult, g.max);
  $('#bet-payout').textContent = fmtMoney(payout);
  const totalEl = $('#bet-total');
  if (totalEl) totalEl.textContent = fmtMoney(stake * betDates.size);
  refreshBetSubmitState();
}

function refreshBetSubmitState() {
  const g = GAMES[betGame];
  const btn = $('#bet-submit');
  if (!btn) return;
  const stake = Number($('#bet-stake').value) || 0;
  const ok = betPicks.length === g.digits && betDates.size > 0 && stake >= g.min;
  btn.disabled = !ok;
  btn.textContent = betDates.size > 1 ? `Place ${betDates.size} Bets` : 'Place Bet';
}

async function handleBetSubmit(e) {
  e.preventDefault();
  const g = GAMES[betGame];
  const stake = Number($('#bet-stake').value);
  const err = $('#bet-error');
  err.textContent = '';
  if (betPicks.length !== g.digits) { err.textContent = `Pick ${g.digits} numbers`; return; }
  if (stake < g.min) { err.textContent = `Minimum stake is ${fmtMoney(g.min)}`; return; }
  if (betDates.size === 0) { err.textContent = 'Tap at least one draw date'; return; }
  const drawSlot = parseInt($('#bet-draw-slot')?.value || '0', 10);
  if (!drawSlot) { err.textContent = 'Choose a draw slot'; return; }

  // Build + validate all draw times up front (drop any already-closed)
  const now = Date.now();
  const plan = [...betDates].sort().map(ymd => ({ ymd, iso: drawTimeFromParts(ymd, drawSlot) }));
  const valid = plan.filter(p => new Date(p.iso).getTime() > now);
  const skipped = plan.length - valid.length;
  if (valid.length === 0) {
    err.textContent = 'All chosen draws have already closed — pick a later slot or later date.';
    return;
  }
  const total = stake * valid.length;
  if (total > currentProfile.wallet_balance) {
    err.textContent = `Need ${fmtMoney(total)} for ${valid.length} draws — wallet has ${fmtMoney(currentProfile.wallet_balance)}.`;
    return;
  }

  const numbers = betPicks.map(n => g.digits === 2 && g.range[1] <= 9 ? n : String(n).padStart(2,'0')).join('-');
  $('#bet-submit').disabled = true;
  let placed = 0;
  let lastError = null;
  try {
    for (const p of valid) {
      try {
        await backend.placeBet(betGame, numbers, 'straight', stake, p.iso);
        currentProfile.wallet_balance = Number(currentProfile.wallet_balance) - stake;
        placed++;
      } catch (ex) {
        lastError = ex;
        break;
      }
    }
  } finally {
    renderAuthUI();
    if (placed > 0) {
      const parts = [
        `Placed ${placed} bet${placed === 1 ? '' : 's'}: ${numbers} @ ${SLOT_LABELS[drawSlot]}`,
      ];
      if (skipped) parts.push(`${skipped} skipped (closed)`);
      if (lastError) parts.push(`stopped: ${lastError.message}`);
      toast(parts.join(' · '), lastError ? 'error' : 'success');
      closeModal('bet-modal');
      renderHistory();
      renderRecentBets();
    } else {
      err.textContent = lastError ? (lastError.message || 'Could not place bet') : 'No bets placed';
    }
    refreshBetSubmitState();
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
      <td>${fmtDrawSlot(b.draw_time)}</td>
      <td><strong>${gameName}</strong></td>
      <td><span class="hist-num">${b.numbers}</span></td>
      <td>${fmtMoney(b.stake)}</td>
      <td>${result}</td>
      <td>${payout}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="hist-empty">No bets yet — play a game to get started.</td></tr>`;

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

  // Close only via the × button — backdrop clicks and Escape are intentionally ignored
  $$('[data-close]').forEach(b => b.onclick = () => closeModal(b.dataset.close));

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

function gameClick(gameId) {
  if (!currentProfile) { openAuth('login'); return; }
  window.location.href = 'play.html';
}

// Expose for inline handlers if needed
window.STL = { openAuth, openWallet, openBet, openHistory, gameClick };
