/* ═══════════════════════════════════════════════════════════
   Lucky 21 — admin.js
   Admin dashboard: feed-mode toggle + WebRTC broadcaster
   Depends on app.js (defines SUPABASE creds, backend, ADMIN_EMAIL)
   ─────────────────────────────────────────────────────────── */

(function () {
  const ADMIN_EMAIL = 'hivelinkph@gmail.com';
  const CHANNEL_NAME = 'stl-live-draw';
  const ICE = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]};

  const $ = s => document.querySelector(s);
  let sb = null;           // supabase client (created lazily)
  let channel = null;      // realtime channel
  let localStream = null;
  const peers = {};        // viewer_id -> RTCPeerConnection
  let liveSince = null;
  let currentMode = 'photos';
  let cameras = [];        // enumerated videoinput devices
  let customSources = [];  // user-added URL-based sources
  let activeDeviceId = null; // 'device-id' or 'custom:<uuid>'
  let streamCleanup = null;  // hook to stop custom-source playback

  const CUSTOM_KEY = 'stl_admin_custom_cams';
  const MUSIC_KEY = 'stl_admin_music';
  const MUSIC_VOL_KEY = 'stl_admin_music_vol';
  const MIC_VOL_KEY = 'stl_admin_mic_vol';
  const MIX_KEY = 'stl_admin_mix_music';
  const MUS_MUTE_KEY = 'stl_admin_music_muted';

  // ── music mixer state ──
  const DEFAULT_TRACKS_VERSION = 2;
  const DEFAULT_TRACKS = [
    { id: 'p1', name: 'Casino Rush',      vibe: 'Energetic · Upbeat',  url: 'Assets/audio/casino-rush.mp3' },
    { id: 'p2', name: 'Jackpot Groove',   vibe: 'Funky · Rhythmic',    url: 'Assets/audio/jackpot-groove.mp3' },
    { id: 'p3', name: 'Nauru Lounge',     vibe: 'Tropical · Chill',    url: 'Assets/audio/palau-lounge.mp3' },
    { id: 'p4', name: 'Draw Night Beats', vibe: 'Hype · Drumline',     url: 'Assets/audio/draw-night-beats.mp3' },
    { id: 'p5', name: 'Island Fortune',   vibe: 'Latin · Carnival',    url: 'Assets/audio/island-fortune.mp3' },
    { id: 'p6', name: 'High Roller',      vibe: 'Glossy · Anthemic',   url: 'Assets/audio/high-roller.mp3' },
  ];
  let tracks = [];
  let audioCtx = null;
  let micSourceNode = null;   // MediaStreamAudioSourceNode for current mic
  let micGain = null;
  let musicGain = null;
  let destNode = null;        // MediaStreamAudioDestinationNode
  let musicAudioEl = null;    // <audio> playing the track
  let musicSourceNode = null; // MediaElementAudioSourceNode for the audio el
  let currentTrackId = null;
  let musicVolume = 0.6;
  let micVolume = 1.0;
  let mixMusicToBroadcast = false;
  let adminMusicMuted = false;
  let musicPlaybackMode = null;  // 'direct' | 'graph'
  let monitorGain = null;        // controls admin local hearing (not broadcast)

  // ── logging helpers ──
  function log(msg) {
    const t = new Date().toLocaleTimeString();
    const el = document.createElement('div');
    el.className = 'log-line';
    el.innerHTML = `<span class="t">${t}</span>${msg}`;
    const box = $('#log');
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 60) box.removeChild(box.firstChild);
  }

  // ── supabase client (shared with app.js when live) ──
  function getClient() {
    if (sb) return sb;
    if (!window.STL_SUPABASE_URL || !window.STL_SUPABASE_ANON_KEY) return null;
    sb = window.supabase.createClient(window.STL_SUPABASE_URL, window.STL_SUPABASE_ANON_KEY);
    return sb;
  }

  // ── auth guard ──
  async function guard() {
    const client = getClient();
    let user = null;
    try {
      if (client) {
        const { data } = await client.auth.getSession();
        user = data?.session?.user || null;
      }
    } catch (_) {}
    // Demo-mode fallback: app.js uses localStorage key 'stl_session'
    if (!user) {
      try { user = JSON.parse(localStorage.getItem('stl_session') || 'null'); } catch (_) {}
    }
    const email = (user?.email || '').toLowerCase();
    if (!user || email !== ADMIN_EMAIL) {
      window.location.replace('index.html');
      return false;
    }
    $('#nav-email').textContent = user.email;
    $('#nav-avatar').textContent = (user.email[0] || 'A').toUpperCase();
    $('#admin-guard').style.display = 'none';
    $('#admin-shell').style.display = 'block';
    return true;
  }

  // ── feed mode ──
  async function loadMode() {
    const client = getClient();
    if (!client) return;
    const { data, error } = await client
      .from('live_feed_state').select('mode').eq('id', 1).single();
    if (error) { log('load mode failed: ' + error.message); return; }
    renderMode(data.mode);
  }

  function renderMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const state = $('#mode-state');
    state.classList.toggle('is-live', mode === 'live');
    state.classList.toggle('is-photos', mode === 'photos');
    $('#mode-state-text').textContent =
      mode === 'live' ? 'Current mode: Live Draw (camera stream)'
                      : 'Current mode: Photo Gallery';
  }

  async function setMode(mode) {
    const client = getClient();
    if (!client) { log('Supabase not configured'); return false; }
    const { error } = await client
      .from('live_feed_state')
      .update({ mode, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) {
      const hint = /relation .* does not exist/i.test(error.message)
        ? ' — apply supabase/schema.sql first'
        : '';
      log('update mode failed: ' + error.message + hint);
      return false;
    }
    renderMode(mode);
    log(`Feed mode → ${mode.toUpperCase()}`);
    return true;
  }

  // ── custom URL-based sources ──
  function loadCustomSources() {
    try { customSources = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); }
    catch { customSources = []; }
  }
  function saveCustomSources() {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSources));
  }
  function addCustomSource(name, url, type) {
    const id = 'c_' + Math.random().toString(36).slice(2, 10);
    customSources.push({ id, name, url, type });
    saveCustomSources();
    renderCamList(cameras);
    return id;
  }
  function removeCustomSource(id) {
    customSources = customSources.filter(s => s.id !== id);
    saveCustomSources();
    if (activeDeviceId === 'custom:' + id) activeDeviceId = cameras[0]?.deviceId || null;
    renderCamList(cameras);
    renderActiveLabel();
  }

  // ── music mixer ──
  function loadMusicLib() {
    // Volume/mix prefs stay local (per-browser)
    const mv = parseFloat(localStorage.getItem(MUSIC_VOL_KEY));
    if (!isNaN(mv)) musicVolume = mv;
    const miv = parseFloat(localStorage.getItem(MIC_VOL_KEY));
    if (!isNaN(miv)) micVolume = miv;
    mixMusicToBroadcast = localStorage.getItem(MIX_KEY) === '1';
    adminMusicMuted = localStorage.getItem(MUS_MUTE_KEY) === '1';
    // Cached tracks for instant render before Supabase fetch completes
    try {
      const raw = localStorage.getItem(MUSIC_KEY);
      if (raw) {
        const prev = JSON.parse(raw);
        if (Array.isArray(prev) && prev.length) tracks = prev;
      }
    } catch (_) {}
    if (!tracks.length) tracks = DEFAULT_TRACKS.slice();
    // Async: pull authoritative list from Supabase, seed presets if empty
    fetchTracksFromSupabase().catch(e => log('Music sync failed: ' + e.message));
  }
  function saveMusicLib() {
    try { localStorage.setItem(MUSIC_KEY, JSON.stringify(tracks)); } catch (_) {}
  }

  async function fetchTracksFromSupabase() {
    const client = getClient();
    if (!client) return;
    const { data, error } = await client.from('music_tracks')
      .select('id,name,vibe,url,is_preset,sort_order')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!data || data.length === 0) {
      const toSeed = DEFAULT_TRACKS.map((t, i) => ({
        name: t.name, vibe: t.vibe, url: t.url, is_preset: true, sort_order: i,
      }));
      const { data: seeded, error: seedErr } = await client
        .from('music_tracks').insert(toSeed).select();
      if (seedErr) throw seedErr;
      tracks = (seeded || []).slice();
      log('Music presets seeded to Supabase');
    } else {
      tracks = data.slice();
    }
    saveMusicLib();
    renderMusicList();
  }

  function ensureAudioGraph() {
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
    micGain = audioCtx.createGain();
    micGain.gain.value = micVolume;
    musicGain = audioCtx.createGain();
    musicGain.gain.value = musicVolume;
    monitorGain = audioCtx.createGain();
    monitorGain.gain.value = adminMusicMuted ? 0 : 1;
    destNode = audioCtx.createMediaStreamDestination();
    // mic always feeds into the broadcast destination
    micGain.connect(destNode);
    // music joins the broadcast only when mix-to-broadcast is on
    if (mixMusicToBroadcast) musicGain.connect(destNode);
    // music is always audible locally for the admin (independent monitor gain)
    musicGain.connect(monitorGain);
    monitorGain.connect(audioCtx.destination);
    return audioCtx;
  }

  function wireMicIntoGraph(stream) {
    if (!stream) return;
    ensureAudioGraph();
    if (!audioCtx) return;
    const aTracks = stream.getAudioTracks();
    if (!aTracks.length) return;
    // tear down previous mic source
    if (micSourceNode) { try { micSourceNode.disconnect(); } catch (_) {} micSourceNode = null; }
    try {
      micSourceNode = audioCtx.createMediaStreamSource(new MediaStream([aTracks[0]]));
      micSourceNode.connect(micGain);
    } catch (e) { log('mic graph error: ' + e.message); }
  }

  function getMixedAudioTrack() {
    if (!destNode) return null;
    const t = destNode.stream.getAudioTracks();
    return t[0] || null;
  }

  function renderMusicList() {
    const host = $('#music-list');
    if (!tracks.length) {
      host.innerHTML = `<div class="cam-empty">No tracks. Restore presets or add one below.</div>`;
      return;
    }
    host.innerHTML = tracks.map(t => {
      const playing = t.id === currentTrackId;
      const cls = 'music-item' + (playing ? ' playing' : '');
      const btnCls = 'music-btn' + (playing ? ' playing' : '');
      const btnText = playing ? '■ Stop' : '▶ Play';
      const custom = t.is_preset === false || (t.is_preset == null && !DEFAULT_TRACKS.some(p => p.url === t.url));
      const remove = custom
        ? `<button class="cam-remove" data-music-remove="${t.id}" title="Remove track">✕</button>`
        : '';
      return `
        <div class="${cls}">
          <div class="music-icon">${playing ? '🎶' : '🎵'}</div>
          <div class="music-meta">
            <div class="music-name">${escapeHTML(t.name)}</div>
            <div class="music-vibe">${escapeHTML(t.vibe || 'Custom')}</div>
          </div>
          <button class="${btnCls}" data-music-play="${t.id}">${btnText}</button>
          ${remove}
        </div>`;
    }).join('');
    host.querySelectorAll('[data-music-play]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.musicPlay;
        if (id === currentTrackId) stopMusic();
        else playTrack(id);
      };
    });
    host.querySelectorAll('[data-music-remove]').forEach(b => {
      b.onclick = () => removeTrack(b.dataset.musicRemove);
    });
  }

  function renderMusicNow() {
    const el = $('#music-now');
    el.style.borderLeftColor = '';
    el.style.color = '';
    if (!currentTrackId) {
      el.classList.remove('playing');
      el.textContent = 'Nothing playing';
      return;
    }
    const t = tracks.find(x => x.id === currentTrackId);
    el.classList.add('playing');
    el.textContent = `Now playing: ${t ? t.name : 'Unknown'} — ${t?.vibe || ''}`;
  }

  function showMusicStatus(msg, isErr) {
    const el = $('#music-now');
    if (!el) return;
    el.classList.toggle('playing', !isErr && !!currentTrackId);
    el.textContent = msg;
    el.style.borderLeftColor = isErr ? 'var(--red)' : '';
    el.style.color = isErr ? 'var(--red)' : '';
  }

  function loadAudioElement(a, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const ok = () => { if (done) return; done = true; cleanup(); resolve(); };
      const err = () => {
        if (done) return; done = true; cleanup();
        const e = a.error;
        const codes = { 1:'ABORTED', 2:'NETWORK', 3:'DECODE', 4:'SRC_NOT_SUPPORTED (likely CORS)' };
        reject(new Error(e ? (codes[e.code] || 'error ' + e.code) : 'load error'));
      };
      const cleanup = () => {
        a.removeEventListener('canplay', ok);
        a.removeEventListener('loadeddata', ok);
        a.removeEventListener('error', err);
        clearTimeout(to);
      };
      const to = setTimeout(() => {
        if (done) return; done = true; cleanup();
        reject(new Error('load timeout'));
      }, timeoutMs);
      a.addEventListener('canplay', ok, { once: true });
      a.addEventListener('loadeddata', ok, { once: true });
      a.addEventListener('error', err, { once: true });
    });
  }

  async function playTrack(id) {
    const track = tracks.find(t => t.id === id);
    if (!track) return;

    stopMusicElement();
    showMusicStatus('Loading: ' + track.name, false);

    // Always try Web Audio graph mode so music flows through the same destNode
    // track that viewers are already subscribed to — no mid-broadcast swaps.
    let corsOK = false;
    ensureAudioGraph();
    if (audioCtx?.state === 'suspended') { try { await audioCtx.resume(); } catch (_) {} }

    if (audioCtx) {
      const a = document.createElement('audio');
      a.crossOrigin = 'anonymous';
      a.src = track.url;
      a.loop = true;
      a.preload = 'auto';
      a.style.display = 'none';
      document.body.appendChild(a);
      try {
        await loadAudioElement(a);
        musicSourceNode = audioCtx.createMediaElementSource(a);
        musicSourceNode.connect(musicGain);
        await a.play();
        musicAudioEl = a;
        musicPlaybackMode = 'graph';
        corsOK = true;
      } catch (e) {
        log('Graph mode failed (' + e.message + ') — falling back to local-only direct');
        try { musicSourceNode?.disconnect(); } catch (_) {}
        musicSourceNode = null;
        try { a.remove(); } catch (_) {}
      }
    }

    if (!corsOK) {
      // Direct playback (audio element plays through speakers; not in broadcast)
      const a = document.createElement('audio');
      a.src = track.url;
      a.loop = true;
      a.volume = musicVolume;
      a.muted = adminMusicMuted;
      a.preload = 'auto';
      a.style.display = 'none';
      document.body.appendChild(a);

      a.onerror = () => {
        const codes = { 1:'aborted', 2:'network', 3:'decode', 4:'src not supported / 404' };
        const msg = a.error ? (codes[a.error.code] || 'error ' + a.error.code) : 'load error';
        const resolved = a.currentSrc || a.src;
        showMusicStatus('Load failed: ' + msg + ' — ' + resolved, true);
        log('music load failed [' + msg + '] url=' + resolved);
        try { a.remove(); } catch (_) {}
        if (musicAudioEl === a) { musicAudioEl = null; currentTrackId = null; musicPlaybackMode = null; renderMusicList(); }
      };

      try {
        await a.play();
      } catch (e) {
        const resolved = a.currentSrc || a.src;
        showMusicStatus('Playback blocked: ' + e.message + ' — ' + resolved, true);
        log('music play blocked: ' + e.message + ' url=' + resolved);
        try { a.remove(); } catch (_) {}
        currentTrackId = null;
        renderMusicList();
        return;
      }

      musicAudioEl = a;
      musicPlaybackMode = 'direct';
    }

    currentTrackId = id;
    renderMusicList();
    renderMusicNow();
    if (!corsOK) {
      const el = $('#music-now');
      if (el) el.textContent += '  (local only — CORS blocked this track from broadcast)';
    }
    log('Music → ' + track.name + (musicPlaybackMode === 'graph' ? ' [mixed]' : ' [local]'));
  }

  function stopMusicElement() {
    if (musicAudioEl) {
      try { musicAudioEl.pause(); } catch (_) {}
      try { musicSourceNode?.disconnect(); } catch (_) {}
      try { musicAudioEl.remove(); } catch (_) {}
    }
    musicAudioEl = null;
    musicSourceNode = null;
    musicPlaybackMode = null;
  }

  function stopMusic() {
    const name = tracks.find(t => t.id === currentTrackId)?.name;
    stopMusicElement();
    currentTrackId = null;
    renderMusicList();
    renderMusicNow();
    if (name) log('Music stopped: ' + name);
  }

  async function removeTrack(id) {
    if (id === currentTrackId) stopMusic();
    const client = getClient();
    if (client) {
      const { error } = await client.from('music_tracks').delete().eq('id', id);
      if (error) { log('Remove track failed: ' + error.message); return; }
    }
    tracks = tracks.filter(t => t.id !== id);
    saveMusicLib();
    renderMusicList();
  }

  async function addTrack(name, url) {
    const client = getClient();
    if (!client) { log('Add track: Supabase not ready'); return null; }
    const { data, error } = await client.from('music_tracks')
      .insert({ name, vibe: 'Custom', url, is_preset: false, sort_order: tracks.length })
      .select().single();
    if (error) { log('Add track failed: ' + error.message); return null; }
    tracks.push(data);
    saveMusicLib();
    renderMusicList();
    return data.id;
  }

  async function restoreTrackPresets() {
    const client = getClient();
    if (!client) return;
    const existingUrls = new Set(tracks.map(t => t.url));
    const missing = DEFAULT_TRACKS.filter(t => !existingUrls.has(t.url));
    if (!missing.length) { log('All presets already present'); return; }
    const toInsert = missing.map((t, i) => ({
      name: t.name, vibe: t.vibe, url: t.url, is_preset: true, sort_order: tracks.length + i,
    }));
    const { data, error } = await client.from('music_tracks').insert(toInsert).select();
    if (error) { log('Restore presets failed: ' + error.message); return; }
    tracks = tracks.concat(data || []);
    saveMusicLib();
    renderMusicList();
  }

  function setMusicVolume(v) {
    musicVolume = Math.max(0, Math.min(1, v));
    if (musicGain) musicGain.gain.value = musicVolume;
    // If playing in direct mode (no Web Audio routing), drive the <audio> element
    if (musicAudioEl && musicPlaybackMode === 'direct') musicAudioEl.volume = musicVolume;
    localStorage.setItem(MUSIC_VOL_KEY, String(musicVolume));
    $('#mus-vol-val').textContent = Math.round(musicVolume * 100) + '%';
  }
  function setMicVolume(v) {
    micVolume = Math.max(0, Math.min(1, v));
    if (micGain) micGain.gain.value = micVolume;
    localStorage.setItem(MIC_VOL_KEY, String(micVolume));
    $('#mic-vol-val').textContent = Math.round(micVolume * 100) + '%';
  }
  function setAdminMusicMuted(muted) {
    adminMusicMuted = !!muted;
    localStorage.setItem(MUS_MUTE_KEY, adminMusicMuted ? '1' : '0');
    // Graph mode: mute local monitor only, broadcast unaffected
    if (monitorGain) monitorGain.gain.value = adminMusicMuted ? 0 : 1;
    // Direct mode: element is local-only anyway, so muting kills it everywhere
    // (in direct mode the track isn't in the broadcast, so this is fine)
    if (musicAudioEl && musicPlaybackMode === 'direct') musicAudioEl.muted = adminMusicMuted;
    const btn = $('#mus-mute');
    if (btn) {
      btn.classList.toggle('muted', adminMusicMuted);
      btn.textContent = adminMusicMuted ? '🔇' : '🔊';
      btn.setAttribute('aria-label', adminMusicMuted ? 'Unmute locally' : 'Mute locally');
    }
  }
  function setMixToBroadcast(on) {
    mixMusicToBroadcast = !!on;
    localStorage.setItem(MIX_KEY, mixMusicToBroadcast ? '1' : '0');
    log('Broadcast music mix: ' + (mixMusicToBroadcast ? 'ON' : 'OFF'));
    // Toggle the musicGain → destNode edge without swapping tracks on peers.
    // Local monitoring (musicGain → monitorGain → speakers) is untouched.
    if (musicGain && destNode) {
      try { musicGain.disconnect(destNode); } catch (_) {}
      if (mixMusicToBroadcast) {
        try { musicGain.connect(destNode); } catch (_) {}
      }
    }
  }

  // Build a MediaStream from an MJPEG URL by drawing frames to a canvas.
  function mjpegToStream(url, fps = 15) {
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.src = url;
    img.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;';
    document.body.appendChild(img);

    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d');
    // black frame until first paint
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);

    const tick = setInterval(() => {
      if (img.naturalWidth > 0) {
        if (canvas.width !== img.naturalWidth) {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
        }
        try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); } catch (_) {}
      }
    }, Math.round(1000 / fps));

    img.onerror = () => log('MJPEG load error — check URL/CORS: ' + url);

    const stream = canvas.captureStream(fps);
    stream.__stlCleanup = () => { clearInterval(tick); img.remove(); };
    return stream;
  }

  // Build a MediaStream from a direct video URL.
  async function videoUrlToStream(url) {
    const vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.src = url;
    vid.muted = false;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.loop = true;
    vid.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;';
    document.body.appendChild(vid);
    try { await vid.play(); } catch (e) { log('video play blocked: ' + e.message); }
    const stream = typeof vid.captureStream === 'function'
      ? vid.captureStream()
      : (vid.mozCaptureStream ? vid.mozCaptureStream() : null);
    if (!stream) { vid.remove(); throw new Error('captureStream unsupported in this browser'); }
    stream.__stlCleanup = () => { try { vid.pause(); } catch (_) {} vid.remove(); };
    return stream;
  }

  async function getStreamForSource(identifier) {
    if (identifier && identifier.startsWith('custom:')) {
      const src = customSources.find(s => 'custom:' + s.id === identifier);
      if (!src) throw new Error('custom source not found');
      if (src.type === 'mjpeg') return mjpegToStream(src.url);
      return await videoUrlToStream(src.url);
    }
    // device camera
    return await navigator.mediaDevices.getUserMedia({
      video: identifier ? { deviceId: { exact: identifier } } : { facingMode: { ideal: 'environment' } },
      audio: true,
    });
  }

  // ── broadcaster / WebRTC ──
  function cameraFacing(label) {
    if (/back|rear|environment/i.test(label)) return 'Rear';
    if (/front|face|user|selfie/i.test(label)) return 'Front';
    return 'Unknown';
  }

  function shortId(id) { return (id || '').slice(0, 8) + '…'; }

  async function enumerateCameras() {
    // Need permission for labels to appear
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tmp.getTracks().forEach(t => t.stop());
    } catch (e) {
      log('Camera permission needed: ' + e.message);
      renderCamList([]);
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras = devices.filter(d => d.kind === 'videoinput').map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Camera ${i + 1}`,
      facing: cameraFacing(d.label),
    }));
    if (!activeDeviceId && cameras.length) {
      // prefer rear camera on mobile; fallback to first
      const rear = cameras.find(c => c.facing === 'Rear');
      activeDeviceId = (rear || cameras[0]).deviceId;
    }
    renderCamList(cameras);
    renderActiveLabel();
  }

  function renderCamList(list) {
    const host = $('#cam-list');
    const devItems = list.map(c => ({
      id: c.deviceId, name: c.label, detail: `${c.facing} · ID ${shortId(c.deviceId)}`,
      icon: c.facing === 'Front' ? '🤳' : '📹', custom: false,
    }));
    const cusItems = customSources.map(s => ({
      id: 'custom:' + s.id, name: s.name,
      detail: `${s.type.toUpperCase()} · ${truncate(s.url, 38)}`,
      icon: '🌐', custom: true, customId: s.id,
    }));
    const all = devItems.concat(cusItems);
    if (!all.length) {
      host.innerHTML = `<div class="cam-empty">No cameras detected. Grant permission or add a source below.</div>`;
      return;
    }
    host.innerHTML = all.map(it => {
      const isActive = it.id === activeDeviceId;
      const isLive = isActive && !!localStream;
      const cls = 'cam-item' + (isActive ? ' active' : '') + (it.custom ? ' custom' : '');
      const btn = isLive
        ? `<button class="cam-btn live" disabled>● Live</button>`
        : `<button class="cam-btn" data-id="${it.id}">${localStream ? 'Switch to' : 'Use'}</button>`;
      const remove = it.custom
        ? `<button class="cam-remove" data-remove="${it.customId}" title="Remove source">✕</button>`
        : '';
      return `
        <div class="${cls}">
          <div class="cam-icon">${it.icon}</div>
          <div class="cam-meta">
            <div class="cam-name">${escapeHTML(it.name)}</div>
            <div class="cam-details">${escapeHTML(it.detail)}</div>
          </div>
          ${btn}${remove}
        </div>`;
    }).join('');
    host.querySelectorAll('.cam-btn[data-id]').forEach(b => {
      b.onclick = () => useCamera(b.dataset.id);
    });
    host.querySelectorAll('.cam-remove[data-remove]').forEach(b => {
      b.onclick = () => removeCustomSource(b.dataset.remove);
    });
  }

  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function renderActiveLabel() {
    let name = '—';
    if (activeDeviceId?.startsWith('custom:')) {
      const s = customSources.find(x => 'custom:' + x.id === activeDeviceId);
      if (s) name = `${s.name} (${s.type.toUpperCase()})`;
    } else {
      const cam = cameras.find(c => c.deviceId === activeDeviceId);
      if (cam) name = `${cam.label} (${cam.facing})`;
    }
    $('#active-cam-label').textContent = 'Active source: ' + name;
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, m => (
      { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[m]
    ));
  }

  async function useCamera(deviceId) {
    if (!deviceId) return;
    activeDeviceId = deviceId;
    renderActiveLabel();
    if (localStream) {
      // Hot-swap while broadcasting
      await switchCamera(deviceId);
    } else {
      renderCamList(cameras);
      log('Selected camera: ' + shortId(deviceId));
    }
  }

  async function switchCamera(identifier) {
    let newStream;
    try {
      newStream = await getStreamForSource(identifier);
    } catch (e) {
      log('switch failed: ' + e.message);
      return;
    }
    const newVideo = newStream.getVideoTracks()[0];

    // Replace only the video track on every live peer without renegotiating.
    // The audio sender already points at the persistent Web Audio destNode
    // track — we rewire the new mic into that graph below, so no audio
    // replaceTrack is needed (and avoiding it fixes iOS Safari audio drops).
    Object.entries(peers).forEach(([vid, pc]) => {
      pc.getSenders().forEach(sender => {
        if (sender.track?.kind === 'video' && newVideo) sender.replaceTrack(newVideo);
      });
    });

    // Stop old tracks + run any custom cleanup
    stopCurrentStream();
    localStream = newStream;
    streamCleanup = newStream.__stlCleanup || null;
    // Swap the mic source into the audio graph (destNode track persists)
    wireMicIntoGraph(newStream);

    const vid = $('#cam-preview');
    vid.srcObject = localStream;
    try { await vid.play(); } catch (_) {}
    renderCamList(cameras);
    renderActiveLabel();

    let label = shortId(identifier);
    if (identifier.startsWith('custom:')) {
      const s = customSources.find(x => 'custom:' + x.id === identifier);
      if (s) label = s.name;
    } else {
      const cam = cameras.find(c => c.deviceId === identifier);
      if (cam) label = cam.label;
    }
    log('Switched source → ' + label);
  }

  function stopCurrentStream() {
    if (localStream) {
      try { localStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      localStream = null;
    }
    if (streamCleanup) { try { streamCleanup(); } catch (_) {} streamCleanup = null; }
  }

  async function startBroadcast() {
    const client = getClient();
    if (!client) { log('Supabase not configured — cannot signal'); return; }
    if (!cameras.length && !(activeDeviceId && activeDeviceId.startsWith('custom:'))) {
      await enumerateCameras();
    }
    try {
      localStream = await getStreamForSource(activeDeviceId);
      streamCleanup = localStream.__stlCleanup || null;
      // If facingMode fallback was used for a device cam, lock in the actual deviceId
      if (!activeDeviceId) {
        const t = localStream.getVideoTracks()[0];
        activeDeviceId = t?.getSettings().deviceId || null;
      }
      const vTracks = localStream.getVideoTracks();
      const aTracks = localStream.getAudioTracks();
      log(`Stream ready — video:${vTracks.length} audio:${aTracks.length}`);
      if (!aTracks.length) {
        log('⚠ No mic audio in stream. If using a phone/IP-cam URL, audio is unsupported; switch to a device camera with mic permission granted.');
      }
    } catch (e) {
      log('source failed: ' + e.message);
      return;
    }
    const vid = $('#cam-preview');
    vid.srcObject = localStream;
    vid.muted = true;          // required for autoplay on most browsers
    vid.playsInline = true;
    try { await vid.play(); } catch (e) { log('autoplay blocked: ' + e.message); }
    $('#cam-placeholder').style.display = 'none';
    $('#live-tag').classList.add('on');
    $('#btn-start').disabled = true;
    $('#btn-stop').disabled = false;
    $('#stat-status').textContent = 'ON';
    liveSince = new Date();
    tickSince();
    renderCamList(cameras);

    // Always route audio through the Web Audio graph. This way the audio track
    // sent to viewers is the persistent destNode track — mic (+ optional music)
    // are mixed into it via gain nodes. No mid-broadcast replaceTrack() needed,
    // which is critical for iOS Safari where replaceTrack() on audio is flaky.
    ensureAudioGraph();
    if (audioCtx?.state === 'suspended') {
      try { await audioCtx.resume(); } catch (_) {}
    }
    wireMicIntoGraph(localStream);

    // Auto-switch homepage to Live Draw so viewers know to connect
    await setMode('live');

    // Join realtime channel as broadcaster
    channel = client.channel(CHANNEL_NAME, { config: { broadcast: { self: false, ack: false } } });

    channel
      .on('broadcast', { event: 'viewer-hello' }, ({ payload }) => {
        if (payload?.viewer_id) handleViewer(payload.viewer_id);
      })
      .on('broadcast', { event: 'answer' }, async ({ payload }) => {
        const pc = peers[payload.from];
        if (!pc) { log('answer for unknown peer ' + (payload.from || '?').slice(0,6)); return; }
        try {
          await pc.setRemoteDescription(payload.sdp);
          log(`[${payload.from.slice(0,6)}] answer applied`);
        } catch (e) { log('setRemoteDesc fail: ' + e.message); }
      })
      .on('broadcast', { event: 'ice' }, async ({ payload }) => {
        if (payload.to !== 'admin') return;
        const pc = peers[payload.from];
        if (!pc || !payload.candidate) return;
        try { await pc.addIceCandidate(payload.candidate); } catch (_) {}
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          log('Broadcaster online — waiting for viewers');
          channel.send({ type: 'broadcast', event: 'broadcaster-live', payload: { ts: Date.now() } });
        }
      });
  }

  async function handleViewer(viewer_id) {
    if (peers[viewer_id]) return; // already peered
    const short = viewer_id.slice(0, 6);
    log('Viewer connecting: ' + short);
    const pc = new RTCPeerConnection(ICE);
    peers[viewer_id] = pc;
    updateViewerCount();

    // Video: raw track from the current source. Audio: the persistent mixed
    // track from the Web Audio graph (mic + optional music). Falling back to
    // raw mic audio only if the graph isn't available (browser too old).
    const vTrack = localStream.getVideoTracks()[0];
    if (vTrack) pc.addTrack(vTrack, localStream);
    const mixedAudio = getMixedAudioTrack();
    if (mixedAudio) {
      pc.addTrack(mixedAudio);
    } else {
      const rawAudio = localStream.getAudioTracks()[0];
      if (rawAudio) pc.addTrack(rawAudio, localStream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate && channel) {
        channel.send({
          type: 'broadcast', event: 'ice',
          payload: { to: viewer_id, from: 'admin', candidate: e.candidate }
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      log(`[${short}] ice: ${pc.iceConnectionState}`);
    };
    pc.onconnectionstatechange = () => {
      log(`[${short}] conn: ${pc.connectionState}`);
      if (['failed','closed','disconnected'].includes(pc.connectionState)) {
        try { pc.close(); } catch (_) {}
        delete peers[viewer_id];
        updateViewerCount();
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      channel.send({
        type: 'broadcast', event: 'offer',
        payload: { to: viewer_id, sdp: pc.localDescription }
      });
      log(`[${short}] offer sent`);
    } catch (e) {
      log('offer fail: ' + e.message);
    }
  }

  async function stopBroadcast() {
    Object.values(peers).forEach(pc => { try { pc.close(); } catch (_) {} });
    Object.keys(peers).forEach(k => delete peers[k]);
    if (channel) {
      try { channel.send({ type: 'broadcast', event: 'broadcaster-bye', payload: {} }); } catch (_) {}
      try { channel.unsubscribe(); } catch (_) {}
      channel = null;
    }
    stopCurrentStream();
    $('#cam-preview').srcObject = null;
    $('#cam-placeholder').style.display = 'flex';
    $('#live-tag').classList.remove('on');
    $('#btn-start').disabled = false;
    $('#btn-stop').disabled = true;
    $('#stat-status').textContent = 'OFF';
    $('#stat-since').textContent = '—';
    liveSince = null;
    updateViewerCount();
    renderCamList(cameras);
    await setMode('photos');
    log('Broadcast stopped');
  }

  function updateViewerCount() {
    $('#stat-viewers').textContent = Object.keys(peers).length;
  }

  function tickSince() {
    const el = $('#stat-since');
    if (!liveSince) return;
    const diff = Math.floor((Date.now() - liveSince.getTime()) / 1000);
    const m = String(Math.floor(diff/60)).padStart(2,'0');
    const s = String(diff%60).padStart(2,'0');
    el.textContent = `${m}:${s}`;
    setTimeout(tickSince, 1000);
  }

  // ── wire up ──
  document.addEventListener('DOMContentLoaded', async () => {
    const ok = await guard();
    if (!ok) return;

    $('#btn-logout').onclick = async () => {
      try { await getClient()?.auth.signOut(); } catch (_) {}
      try { localStorage.removeItem('stl_session'); } catch (_) {}
      stopBroadcast();
      window.location.href = 'index.html';
    };

    $('#mode-photos').onclick = () => setMode('photos');
    $('#mode-live').onclick = () => setMode('live');

    $('#btn-start').onclick = startBroadcast;
    $('#btn-stop').onclick = stopBroadcast;

    // Tab switching
    document.querySelectorAll('.tab').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
        document.querySelectorAll('.tab-panel').forEach(p => {
          p.hidden = (p.id !== 'tab-' + t.dataset.tab);
        });
      };
    });
    $('#cam-refresh').onclick = () => enumerateCameras();

    // Add-source form
    const form = $('#cam-add-form');
    $('#cam-toggle-add').onclick = () => {
      form.hidden = !form.hidden;
      if (!form.hidden) $('#add-name').focus();
    };
    $('#add-cancel').onclick = () => {
      form.hidden = true;
      form.reset();
      $('#add-error').textContent = '';
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = $('#add-name').value.trim();
      const url = $('#add-url').value.trim();
      const type = $('#add-type').value;
      const err = $('#add-error');
      err.textContent = '';
      if (!name) { err.textContent = 'Name is required'; return; }
      try { new URL(url); } catch { err.textContent = 'Invalid URL'; return; }
      addCustomSource(name, url, type);
      form.reset();
      form.hidden = true;
      log('Added custom source: ' + name);
    };

    // Music controls
    loadMusicLib();
    renderMusicList();
    renderMusicNow();
    const musVol = $('#mus-vol');
    const micVol = $('#mic-vol');
    musVol.value = String(Math.round(musicVolume * 100));
    micVol.value = String(Math.round(micVolume * 100));
    $('#mus-vol-val').textContent = musVol.value + '%';
    $('#mic-vol-val').textContent = micVol.value + '%';
    musVol.oninput = () => setMusicVolume(parseInt(musVol.value, 10) / 100);
    micVol.oninput = () => setMicVolume(parseInt(micVol.value, 10) / 100);

    // Mix-to-broadcast checkbox
    const mixChk = $('#mix-to-broadcast');
    if (mixChk) {
      mixChk.checked = mixMusicToBroadcast;
      mixChk.onchange = () => setMixToBroadcast(mixChk.checked);
    }

    // Local mute toggle (admin only — broadcast unaffected in graph mode)
    const muteBtn = $('#mus-mute');
    if (muteBtn) {
      muteBtn.classList.toggle('muted', adminMusicMuted);
      muteBtn.textContent = adminMusicMuted ? '🔇' : '🔊';
      muteBtn.onclick = () => setAdminMusicMuted(!adminMusicMuted);
    }

    $('#music-reset').onclick = () => { restoreTrackPresets(); log('Music presets restored'); };

    const musicForm = $('#music-add-form');
    $('#music-toggle-add').onclick = () => {
      musicForm.hidden = !musicForm.hidden;
      if (!musicForm.hidden) $('#music-name').focus();
    };
    $('#music-cancel').onclick = () => {
      musicForm.hidden = true;
      musicForm.reset();
      $('#music-error').textContent = '';
    };
    musicForm.onsubmit = (e) => {
      e.preventDefault();
      const name = $('#music-name').value.trim();
      let url = $('#music-url').value.trim();
      const err = $('#music-error');
      err.textContent = '';
      if (!name) { err.textContent = 'Name is required'; return; }
      // Auto-prefix bare filenames: "DanceIndian.mp3" → "Assets/audio/DanceIndian.mp3"
      if (url && !/^(https?:|\/|\.\.?\/)/i.test(url) && !url.includes('/') &&
          /\.(mp3|ogg|wav|m4a|aac|flac)$/i.test(url)) {
        url = 'Assets/audio/' + url;
      }
      // Validate URL (allow relative paths by resolving against page origin)
      try { new URL(url, location.href); } catch { err.textContent = 'Invalid URL'; return; }
      addTrack(name, url);
      musicForm.reset();
      musicForm.hidden = true;
      log('Added track: ' + name + ' → ' + url);
    };

    // Re-enumerate if the OS exposes a new camera mid-session
    navigator.mediaDevices?.addEventListener?.('devicechange', enumerateCameras);

    loadCustomSources();
    await loadMode();
    await enumerateCameras().catch(() => {/* user can retry via Refresh */});

    // live-reflect mode changes if another admin device edits it
    const client = getClient();
    if (client) {
      client.channel('lfs-admin')
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'live_feed_state' },
          (p) => { if (p.new?.mode) renderMode(p.new.mode); })
        .subscribe();
    }

    initOCR();
    initGraphics();
  });

  // ═══════════════════════════════════════════════════════════
  // Gemini 3 Pro vision — scan live video for draw results
  // ═══════════════════════════════════════════════════════════
  const OCR_KEY = 'stl_admin_ocr_enabled';
  const GEMINI_KEY = 'stl_admin_gemini_key';
  const GEMINI_MODEL = 'gemini-2.5-flash';
  const DRAW_SLOTS = [10, 15, 19]; // 10 AM, 3 PM, 7 PM (Nauru local hours)
  const OCR_INTERVAL_MS = 10000;   // 10s — Gemini is paid, don't burn quota

  const GEMINI_PROMPT = `You are reading a live video frame from the Lucky 21 lottery draw broadcast. Extract visible labeled draw results.

Labels to look for (printed, handwritten, or rendered):
- "DIGIT 2" (or "DIGITS 2") followed by 2 numeric digits → D2 result
- "DIGIT 3" (or "DIGITS 3") followed by 3 numeric digits → D3 result
- "PAIRS" (or "PAIR") followed by 2 numeric digits → Pairs result

Return ONLY a raw JSON object with any subset of these keys:
{"d2":"74","d3":"375","pairs":"18"}

Rules:
- Only include a key when both the label AND its digits are clearly legible.
- Digits are 0-9 only. Strip spaces/dashes. No letters.
- If nothing matches, return {}.
- No markdown, no code fences, no prose. Output must start with { and end with }.`;

  let ocrEnabled = false;
  let ocrTimer = null;
  let ocrBusy = false;
  let ocrCanvas = null;
  let geminiApiKey = '';
  let lastPushed = {}; // `${slotISO}|${game}` -> numbers (skip dup upserts)

  function setOcrStatus(msg, active) {
    const el = $('#ocr-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('active', !!active);
  }

  function nearestDrawSlot(now = new Date()) {
    // Nauru has no DST; assume local time on this machine is Nauru time
    // (or at least close enough — user confirmed admin is in Nauru context).
    let best = null;
    let bestDiff = Infinity;
    for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
      for (const h of DRAW_SLOTS) {
        const d = new Date(now);
        d.setDate(d.getDate() + dayOffset);
        d.setHours(h, 0, 0, 0);
        const diff = Math.abs(d - now);
        if (diff < bestDiff) { bestDiff = diff; best = d; }
      }
    }
    return best;
  }

  function extractJson(raw) {
    if (!raw) return null;
    // Strip code fences if Gemini wraps JSON despite the prompt
    const cleaned = raw.replace(/```json|```/gi, '');
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return null;
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { return null; }
  }

  function normaliseParsed(obj) {
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    const clean = (v, n) => {
      if (typeof v !== 'string' && typeof v !== 'number') return null;
      const digits = String(v).replace(/\D/g, '');
      return digits.length === n ? digits : null;
    };
    const d2 = clean(obj.d2, 2);       if (d2) out.d2 = d2;
    const d3 = clean(obj.d3, 3);       if (d3) out.d3 = d3;
    const pr = clean(obj.pairs, 2);    if (pr) out.pairs = pr;
    return out;
  }

  function canvasToBase64Png(cnv) {
    const url = cnv.toDataURL('image/jpeg', 0.85);
    return url.slice(url.indexOf(',') + 1);
  }

  async function geminiScan(cnv) {
    if (!geminiApiKey) throw new Error('No Gemini API key set');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
    const body = {
      contents: [{
        parts: [
          { text: GEMINI_PROMPT },
          { inline_data: { mime_type: 'image/jpeg', data: canvasToBase64Png(cnv) } },
        ],
      }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text;
  }

  async function pushResult(game, numbers, rawText) {
    const client = getClient();
    if (!client) return false;
    const slot = nearestDrawSlot();
    const key = `${slot.toISOString()}|${game}`;
    if (lastPushed[key] === numbers) return false;
    try {
      const { error } = await client.from('draw_results').upsert({
        draw_time: slot.toISOString(),
        game,
        numbers,
        source: 'ocr',
        raw_text: rawText ? rawText.slice(0, 500) : null,
      }, { onConflict: 'draw_time,game' });
      if (error) {
        setOcrStatus('DB error: ' + error.message, false);
        return false;
      }
      lastPushed[key] = numbers;
      const last = $('#ocr-last');
      if (last) {
        last.innerHTML = `<span class="ocr-chip">${game.toUpperCase()}</span>` +
          `<strong>${numbers}</strong> → ${slot.toLocaleString()} draw`;
      }
      return true;
    } catch (e) {
      setOcrStatus('Push failed: ' + e.message, false);
      return false;
    }
  }

  async function ocrTick() {
    if (ocrBusy || !ocrEnabled) return;
    if (!geminiApiKey) { setOcrStatus('Set a Gemini API key above', false); return; }
    const vid = $('#cam-preview');
    if (!vid || !vid.srcObject || vid.readyState < 2 || vid.videoWidth === 0) return;
    ocrBusy = true;
    try {
      if (!ocrCanvas) ocrCanvas = document.createElement('canvas');
      const targetW = 1024;
      const scale = Math.min(1, targetW / vid.videoWidth);
      ocrCanvas.width = Math.round(vid.videoWidth * scale);
      ocrCanvas.height = Math.round(vid.videoHeight * scale);
      ocrCanvas.getContext('2d').drawImage(vid, 0, 0, ocrCanvas.width, ocrCanvas.height);

      setOcrStatus('Scanning with Gemini…', true);
      const rawText = await geminiScan(ocrCanvas);
      const parsed = normaliseParsed(extractJson(rawText));
      const keys = Object.keys(parsed);

      const last = $('#ocr-last');
      const preview = (rawText || '(empty)').replace(/\s+/g, ' ').slice(0, 160);
      if (keys.length === 0) {
        if (last) last.innerHTML = `<span class="ocr-chip">MODEL</span>${preview}`;
        setOcrStatus('No draw labels visible', true);
      } else {
        let pushed = 0;
        for (const g of keys) {
          if (await pushResult(g, parsed[g], rawText)) pushed++;
        }
        setOcrStatus(`Detected: ${keys.map(g => `${g}=${parsed[g]}`).join('  ')}${pushed ? '  ✓ saved' : ''}`, true);
      }
    } catch (e) {
      setOcrStatus('Vision error: ' + e.message, false);
    } finally {
      ocrBusy = false;
    }
  }

  function startOCR() {
    if (ocrTimer) return;
    if (!geminiApiKey) { setOcrStatus('Set a Gemini API key above', false); return; }
    setOcrStatus('Vision ready — first scan shortly', true);
    ocrTimer = setInterval(ocrTick, OCR_INTERVAL_MS);
    // Also run one immediately so the admin sees feedback
    setTimeout(ocrTick, 500);
  }

  function stopOCR() {
    if (ocrTimer) { clearInterval(ocrTimer); ocrTimer = null; }
    setOcrStatus('Vision idle', false);
  }

  function setOcrEnabled(v) {
    ocrEnabled = !!v;
    try { localStorage.setItem(OCR_KEY, ocrEnabled ? '1' : '0'); } catch (_) {}
    if (ocrEnabled) startOCR(); else stopOCR();
  }

  async function manualResolve() {
    const client = getClient();
    const msg = $('#ocr-m-msg');
    if (!msg) return;
    msg.classList.remove('ok', 'err');
    if (!client) { msg.textContent = 'Supabase not configured'; msg.classList.add('err'); return; }
    const game = $('#ocr-m-game').value;
    const hour = parseInt($('#ocr-m-slot').value, 10);
    const nums = ($('#ocr-m-numbers').value || '').replace(/\D/g, '');
    const expected = { d2: 2, d3: 3, pairs: 2 }[game];
    if (nums.length !== expected) {
      msg.textContent = `Need exactly ${expected} digits for ${game.toUpperCase()}`;
      msg.classList.add('err');
      return;
    }
    const slot = new Date();
    slot.setHours(hour, 0, 0, 0);
    msg.textContent = 'Resolving…';
    try {
      const { data, error } = await client.rpc('resolve_draw', {
        p_draw_time: slot.toISOString(),
        p_game: game,
        p_numbers: nums,
      });
      if (error) throw error;
      msg.textContent = `Saved. ${data} winner${data === 1 ? '' : 's'} paid.`;
      msg.classList.add('ok');
      $('#ocr-m-numbers').value = '';
    } catch (e) {
      msg.textContent = 'Failed: ' + e.message;
      msg.classList.add('err');
    }
  }

  async function scanNow() {
    if (!geminiApiKey) { setOcrStatus('Set a Gemini API key above', false); return; }
    const prev = ocrEnabled;
    ocrEnabled = true; // so ocrTick doesn't bail
    await ocrTick();
    ocrEnabled = prev;
  }

  function initOCR() {
    const cb = $('#ocr-enable');
    if (!cb) return;

    // API key: load from localStorage or window global, populate masked input
    const keyInput = $('#ocr-api-key');
    const saveKeyBtn = $('#ocr-save-key');
    geminiApiKey = localStorage.getItem(GEMINI_KEY) || window.STL_GEMINI_API_KEY || '';
    if (keyInput && geminiApiKey) keyInput.placeholder = '••••••••••••••••  (saved — paste to replace)';
    if (saveKeyBtn) saveKeyBtn.addEventListener('click', () => {
      const v = (keyInput?.value || '').trim();
      if (!v) { setOcrStatus('Paste a key first', false); return; }
      geminiApiKey = v;
      try { localStorage.setItem(GEMINI_KEY, v); } catch (_) {}
      keyInput.value = '';
      keyInput.placeholder = '••••••••••••••••  (saved — paste to replace)';
      setOcrStatus('API key saved', true);
      if (ocrEnabled) startOCR();
    });

    const saved = localStorage.getItem(OCR_KEY) === '1';
    cb.checked = saved;
    cb.addEventListener('change', () => setOcrEnabled(cb.checked));
    const saveBtn = $('#ocr-m-save');
    if (saveBtn) saveBtn.addEventListener('click', manualResolve);
    const scanBtn = $('#ocr-scan-now');
    if (scanBtn) scanBtn.addEventListener('click', scanNow);
    if (saved) setOcrEnabled(true);
  }

  // ═══════════════════════════════════════════════════════════
  // Graphics overlay — upload images to Supabase Storage, flash on live feed
  // ═══════════════════════════════════════════════════════════
  const GFX_CHANNEL = 'stl-graphics';
  const GFX_BUCKET = 'graphics';
  const GFX_MAX_DIM = 1024;
  const GFX_DURATION_MS = 3000;

  let graphics = [];
  let gfxChannel = null;

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));

  function resizeImageToBlob(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read failed'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('invalid image'));
        img.onload = () => {
          const scale = Math.min(1, GFX_MAX_DIM / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          c.toBlob(b => b ? resolve(b) : reject(new Error('blob failed')), mime, 0.9);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderGraphicsList() {
    const list = $('#gfx-list');
    if (!list) return;
    if (!graphics.length) {
      list.innerHTML = '<div class="cam-empty">No graphics yet. Upload one to get started.</div>';
      return;
    }
    list.innerHTML = graphics.map(g => `
      <div class="gfx-item" data-id="${g.id}">
        <div class="gfx-thumb" style="background-image:url('${g.url}')"></div>
        <div class="gfx-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>
        <div class="gfx-actions">
          <button type="button" class="gfx-run" data-id="${g.id}">RUN</button>
          <button type="button" class="gfx-del" data-id="${g.id}" aria-label="Delete">×</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.gfx-run').forEach(b => { b.onclick = () => runGraphic(b.dataset.id); });
    list.querySelectorAll('.gfx-del').forEach(b => { b.onclick = () => deleteGraphic(b.dataset.id); });
  }

  async function loadGraphicsFromSupabase() {
    const client = getClient();
    if (!client) return;
    const { data, error } = await client.from('graphics')
      .select('id,name,url,storage_path,sort_order')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) { log('Graphics load failed: ' + error.message); return; }
    graphics = data || [];
    renderGraphicsList();
  }

  async function deleteGraphic(id) {
    const g = graphics.find(x => x.id === id);
    if (!g) return;
    const client = getClient();
    if (!client) { log('Graphics: Supabase not ready'); return; }
    if (g.storage_path) {
      const { error: sErr } = await client.storage.from(GFX_BUCKET).remove([g.storage_path]);
      if (sErr) log('Storage delete warning: ' + sErr.message);
    }
    const { error } = await client.from('graphics').delete().eq('id', id);
    if (error) { log('Graphic delete failed: ' + error.message); return; }
    graphics = graphics.filter(x => x.id !== id);
    renderGraphicsList();
  }

  async function handleGraphicFiles(files) {
    const client = getClient();
    if (!client) { log('Graphics: Supabase not ready'); return; }
    for (const file of Array.from(files || [])) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const blob = await resizeImageToBlob(file);
        const ext = blob.type === 'image/jpeg' ? 'jpg' : 'png';
        const path = `g_${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
        const { error: upErr } = await client.storage.from(GFX_BUCKET).upload(path, blob, {
          contentType: blob.type, upsert: false,
        });
        if (upErr) throw upErr;
        const { data: pub } = client.storage.from(GFX_BUCKET).getPublicUrl(path);
        const publicUrl = pub.publicUrl;
        const name = file.name.replace(/\.[^.]+$/, '') || 'Graphic';
        const { data, error } = await client.from('graphics')
          .insert({ name, url: publicUrl, storage_path: path, sort_order: graphics.length })
          .select().single();
        if (error) throw error;
        graphics.push(data);
        renderGraphicsList();
        log('Graphic added: ' + name);
      } catch (e) {
        log('Graphic upload failed: ' + e.message);
      }
    }
  }

  function ensureGfxChannel() {
    if (gfxChannel) return gfxChannel;
    const client = getClient();
    if (!client) return null;
    gfxChannel = client.channel(GFX_CHANNEL, { config: { broadcast: { self: false, ack: false } } });
    gfxChannel.subscribe();
    return gfxChannel;
  }

  async function runGraphic(id) {
    const g = graphics.find(x => x.id === id);
    if (!g) return;
    const ch = ensureGfxChannel();
    if (!ch) { log('Graphics: Supabase not ready'); return; }
    const btn = document.querySelector(`.gfx-run[data-id="${id}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      await ch.send({
        type: 'broadcast', event: 'graphic-show',
        payload: { url: g.url, duration: GFX_DURATION_MS, id: g.id, name: g.name },
      });
      log('Graphic sent: ' + g.name);
    } catch (e) {
      log('Graphic send failed: ' + e.message);
    }
    setTimeout(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'RUN'; }
    }, GFX_DURATION_MS);
  }

  function initGraphics() {
    renderGraphicsList();
    const input = $('#gfx-file');
    if (input) {
      input.onchange = async () => {
        await handleGraphicFiles(input.files);
        input.value = '';
      };
    }
    ensureGfxChannel();
    loadGraphicsFromSupabase();
  }
})();
