/* ═══════════════════════════════════════════════════════════
   STL Palau — viewer.js
   Public homepage: listen for live_feed_state, swap photo
   slideshow for WebRTC camera stream when mode = 'live'.
   ─────────────────────────────────────────────────────────── */

(function () {
  const CHANNEL_NAME = 'stl-live-draw';
  const ICE = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]};

  const URL_ = window.STL_SUPABASE_URL;
  const KEY_ = window.STL_SUPABASE_ANON_KEY;
  if (!URL_ || !KEY_ || !window.supabase) return;
  const sb = window.supabase.createClient(URL_, KEY_);

  const feed = document.getElementById('live-feed');
  if (!feed) return;
  const slides = document.getElementById('feed-slides');
  const comingText = feed.querySelector('.feed-coming-text');
  const fsBtn = document.getElementById('feed-fullscreen');

  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      } else {
        (feed.requestFullscreen || feed.webkitRequestFullscreen)?.call(feed);
      }
    });
    const syncIcon = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      fsBtn.textContent = on ? '⛶' : '⛶';
      fsBtn.title = on ? 'Exit fullscreen' : 'Fullscreen';
      fsBtn.setAttribute('aria-label', fsBtn.title);
    };
    document.addEventListener('fullscreenchange', syncIcon);
    document.addEventListener('webkitfullscreenchange', syncIcon);
  }

  const viewer_id = 'v_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let channel = null;
  let pc = null;
  let videoEl = null;
  let photosHTML = null;   // saved photo-slide markup so we can restore
  let currentMode = null;
  let retryTimer = null;

  function setStatus(msg) {
    if (comingText) comingText.textContent = msg;
    try { console.log('[STL viewer]', msg); } catch (_) {}
  }

  function ensureVideoEl() {
    if (videoEl) return videoEl;
    if (slides && photosHTML === null) photosHTML = slides.innerHTML;
    if (slides) slides.innerHTML = '';
    feed.classList.add('is-live');
    videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;   // required for autoplay; unmutes on first user gesture
    videoEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;cursor:pointer;';
    slides.appendChild(videoEl);

    // Centered "Tap to unmute" overlay — covers the feed until first unmute
    const unmuteOverlay = document.createElement('div');
    unmuteOverlay.id = 'feed-unmute-overlay';
    unmuteOverlay.style.cssText = [
      'position:absolute', 'inset:0', 'z-index:6',
      'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
      'gap:12px', 'cursor:pointer',
      'background:rgba(6,18,32,0.35)',
      'backdrop-filter:blur(2px)', '-webkit-backdrop-filter:blur(2px)',
      'transition:opacity 0.3s',
    ].join(';');
    unmuteOverlay.innerHTML =
      '<div style="width:72px;height:72px;border-radius:50%;background:rgba(255,214,0,0.95);color:#061220;display:flex;align-items:center;justify-content:center;font-size:34px;box-shadow:0 6px 24px rgba(0,0,0,0.5);animation:stl-pulse 1.6s ease-in-out infinite;">🔇</div>' +
      '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:18px;letter-spacing:2px;color:#fff;text-transform:uppercase;text-shadow:0 2px 8px rgba(0,0,0,0.8);">Tap to hear live audio</div>';

    if (!document.getElementById('stl-pulse-style')) {
      const st = document.createElement('style');
      st.id = 'stl-pulse-style';
      st.textContent =
        '@keyframes stl-pulse{0%,100%{transform:scale(1);box-shadow:0 6px 24px rgba(0,0,0,0.5)}50%{transform:scale(1.08);box-shadow:0 8px 34px rgba(255,214,0,0.55)}}';
      document.head.appendChild(st);
    }

    // Persistent speaker toggle (bottom-right); stays after first unmute so
    // viewers can re-mute if needed.
    const btn = document.createElement('button');
    btn.id = 'feed-mute-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Unmute');
    btn.style.cssText = [
      'position:absolute', 'bottom:16px', 'right:16px',
      'width:48px', 'height:48px', 'border-radius:50%',
      'border:1px solid rgba(255,255,255,0.25)', 'cursor:pointer', 'z-index:5',
      'background:rgba(0,0,0,0.55)', 'color:#fff',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-size:22px', 'line-height:1', 'padding:0',
      'backdrop-filter:blur(4px)', '-webkit-backdrop-filter:blur(4px)',
      'transition:background 0.2s',
    ].join(';');
    btn.innerHTML = '🔇';
    btn.onmouseenter = () => { btn.style.background = 'rgba(255,214,0,0.85)'; btn.style.color = '#061220'; };
    btn.onmouseleave = () => { btn.style.background = 'rgba(0,0,0,0.55)'; btn.style.color = '#fff'; };

    const setMuted = (m) => {
      videoEl.muted = m;
      btn.innerHTML = m ? '🔇' : '🔊';
      btn.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
      videoEl.play().catch(() => {});
    };

    const dismissOverlay = () => {
      unmuteOverlay.style.opacity = '0';
      setTimeout(() => { try { unmuteOverlay.remove(); } catch (_) {} }, 320);
    };

    // Overlay click: unmute + dismiss
    unmuteOverlay.onclick = (ev) => {
      ev.stopPropagation();
      setMuted(false);
      dismissOverlay();
    };

    // Clicking the video itself also unmutes on first tap
    videoEl.onclick = () => {
      if (videoEl.muted) { setMuted(false); dismissOverlay(); }
    };

    btn.onclick = (ev) => {
      ev.stopPropagation();
      setMuted(!videoEl.muted);
      if (!videoEl.muted) dismissOverlay();
    };

    slides.appendChild(unmuteOverlay);
    slides.appendChild(btn);
    setStatus('Waiting for broadcaster…');
    return videoEl;
  }

  function restorePhotos() {
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    if (channel) { try { channel.unsubscribe(); } catch (_) {} channel = null; }
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.remove();
      videoEl = null;
    }
    feed.classList.remove('is-live');
    if (slides && photosHTML !== null) {
      slides.innerHTML = photosHTML;
      // first slide active
      const first = slides.querySelector('.feed-slide');
      if (first) first.classList.add('active');
    }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function joinAsViewer() {
    ensureVideoEl();
    channel = sb.channel(CHANNEL_NAME, { config: { broadcast: { self: false, ack: false } } });

    channel
      .on('broadcast', { event: 'offer' }, async ({ payload }) => {
        if (payload.to !== viewer_id) return;
        await handleOffer(payload.sdp);
      })
      .on('broadcast', { event: 'ice' }, async ({ payload }) => {
        if (payload.to !== viewer_id) return;
        if (!pc || !payload.candidate) return;
        try { await pc.addIceCandidate(payload.candidate); } catch (_) {}
      })
      .on('broadcast', { event: 'broadcaster-live' }, () => {
        // broadcaster (re)appeared — say hello
        sendHello();
      })
      .on('broadcast', { event: 'broadcaster-bye' }, () => {
        if (pc) { try { pc.close(); } catch (_) {} pc = null; }
        if (videoEl) videoEl.srcObject = null;
        if (comingText) comingText.textContent = 'Broadcaster offline — waiting…';
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          sendHello();
          // retry every 5s until we get an offer
          const retry = () => {
            if (!channel || (pc && pc.connectionState === 'connected')) return;
            sendHello();
            retryTimer = setTimeout(retry, 5000);
          };
          retryTimer = setTimeout(retry, 5000);
        }
      });
  }

  function sendHello() {
    if (!channel) return;
    try {
      channel.send({
        type: 'broadcast', event: 'viewer-hello',
        payload: { viewer_id }
      });
    } catch (_) {}
  }

  let remoteStream = null;
  let statsTimer = null;

  function startStatsPolling() {
    if (statsTimer) return;
    let lastBytes = 0;
    let ticks = 0;
    statsTimer = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected') return;
      ticks++;
      try {
        const stats = await pc.getStats();
        let vBytes = 0, vFrames = 0, aBytes = 0, vCodec = '', aCodec = '';
        const codecMap = {};
        stats.forEach(r => { if (r.type === 'codec') codecMap[r.id] = r.mimeType; });
        stats.forEach(r => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            vBytes = r.bytesReceived || 0;
            vFrames = r.framesDecoded || 0;
            vCodec = codecMap[r.codecId] || '';
          }
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            aBytes = r.bytesReceived || 0;
            aCodec = codecMap[r.codecId] || '';
          }
        });
        const dB = vBytes - lastBytes; lastBytes = vBytes;
        if (vBytes === 0 && aBytes === 0 && ticks > 3) {
          setStatus(`Connected ${ticks}s — no RTP received (firewall/NAT blocking media). TURN server likely needed.`);
        } else {
          setStatus(`Live · v:${Math.round(vBytes/1024)}KB (+${Math.round(dB/1024)}KB/s) f:${vFrames} · a:${Math.round(aBytes/1024)}KB`);
        }
      } catch (e) {
        setStatus('stats error: ' + e.message);
      }
    }, 1000);
  }

  async function handleOffer(sdp) {
    setStatus('Offer received — negotiating…');
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    remoteStream = new MediaStream();
    pc = new RTCPeerConnection(ICE);

    pc.ontrack = (e) => {
      try { remoteStream.addTrack(e.track); } catch (_) {}
      if (videoEl && videoEl.srcObject !== remoteStream) {
        videoEl.srcObject = remoteStream;
      }
      setStatus(`Got ${e.track.kind} track`);
      videoEl?.play()
        .then(() => setStatus('Live — streaming (' + e.track.kind + ' attached)'))
        .catch(err => setStatus('Play blocked: ' + err.message));
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && channel) {
        channel.send({
          type: 'broadcast', event: 'ice',
          payload: { to: 'admin', from: viewer_id, candidate: e.candidate }
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      setStatus('ICE: ' + pc.iceConnectionState);
    };
    pc.onconnectionstatechange = () => {
      setStatus('Connection: ' + pc.connectionState);
      if (pc.connectionState === 'connected') startStatsPolling();
    };

    try {
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      channel.send({
        type: 'broadcast', event: 'answer',
        payload: { to: 'admin', from: viewer_id, sdp: pc.localDescription }
      });
      setStatus('Answer sent — waiting for media…');
    } catch (e) {
      setStatus('Negotiation failed: ' + e.message);
    }
  }

  function applyMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;
    if (mode === 'live') {
      joinAsViewer();
    } else {
      restorePhotos();
    }
  }

  async function loadInitialMode() {
    try {
      const { data, error } = await sb
        .from('live_feed_state').select('mode').eq('id', 1).single();
      if (error) return;
      applyMode(data.mode || 'photos');
    } catch (_) {}
  }

  sb.channel('lfs-public')
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'live_feed_state' },
      (p) => { if (p.new?.mode) applyMode(p.new.mode); })
    .subscribe();

  loadInitialMode();

  // ── Draw results: fill the D2 / D3 / Pairs ball overlay ─────
  const BALL_EXPECT = { d2: 2, d3: 3, pairs: 2 };

  function renderResult(game, numbers) {
    const holder = document.querySelector(`.fr-balls[data-game="${game}"]`);
    if (!holder) return;
    const balls = holder.querySelectorAll('.fr-ball');
    const expected = BALL_EXPECT[game] || balls.length;
    const digits = (numbers || '').replace(/\D/g, '').slice(0, expected);
    balls.forEach((b, i) => {
      if (digits[i] != null) {
        b.textContent = digits[i];
        b.classList.remove('pending');
      } else {
        b.textContent = '?';
        b.classList.add('pending');
      }
    });
  }

  async function loadLatestResults() {
    try {
      // Latest 30 rows across all games; pick the newest per game
      const { data, error } = await sb
        .from('draw_results')
        .select('game, numbers, draw_time')
        .order('draw_time', { ascending: false })
        .limit(30);
      if (error || !data) return;
      const seen = {};
      for (const row of data) {
        if (!seen[row.game]) {
          seen[row.game] = true;
          renderResult(row.game, row.numbers);
        }
      }
    } catch (_) {}
  }

  sb.channel('dr-public')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'draw_results' },
      (p) => {
        const row = p.new || p.old;
        if (row?.game && row?.numbers) renderResult(row.game, row.numbers);
      })
    .subscribe();

  loadLatestResults();
})();
