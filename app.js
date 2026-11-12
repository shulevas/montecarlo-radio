(() => {
  'use strict';

  // Direct Shoutcast stream found on https://montecarlo.cy/live/ (MP3 128 kbps).
  // It sends "Access-Control-Allow-Origin: *", so Web Audio can process it.
  const STREAM = 'https://live.vblcast.com/proxy/montecarlo/stream';
  const STATION = 'Monte Carlo Cyprus';

  const DB_MIN = -60;
  const DB_MAX = 0;
  const DB_DEFAULT = -30;
  const DB_STEP_BUTTON = 1;
  const STALL_MS = 12000;      // no progress for this long => reconnect
  const KEY_VOL = 'mc_volume_db';
  const KEY_COMPAT = 'mc_compat';

  const $ = (id) => document.getElementById(id);
  const ui = {
    play: $('play'),
    status: $('status'),
    statusText: $('status-text'),
    vol: $('vol'),
    volValue: $('vol-value'),
    volBox: document.querySelector('.volume'),
    volNote: $('vol-note'),
    down: $('vol-down'),
    up: $('vol-up'),
    compat: $('compat'),
  };

  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);
  const tgAtLeast = (v) => !!(inTelegram && tg.isVersionAtLeast && tg.isVersionAtLeast(v));

  // ---------- state ----------
  let volDb = DB_DEFAULT;
  let compat = false;
  let userTouchedSettings = false;

  let wantPlay = false;        // user intends the radio to play
  let pausedBySystem = false;  // iOS / another app paused us; resume when we come back
  // We change src / pause ourselves; media events from that arrive asynchronously,
  // so ignore them for a short window instead of a synchronous flag.
  let switchUntil = 0;
  const markSwitch = () => { switchUntil = Date.now() + 1500; };
  const switching = () => Date.now() < switchUntil;
  let attempts = 0;
  let reconnectTimer = null;
  let lastProgressAt = 0;

  let ctx = null;              // AudioContext
  let gainNode = null;
  let audio = null;            // current <audio> element
  let audioMode = null;        // 'webaudio' | 'compat' for the current element
  let source = null;           // MediaElementSourceNode

  // audio.volume is read-only on iOS; detect it to know if compat mode can change volume
  const volumeSettable = (() => {
    const a = document.createElement('audio');
    a.volume = 0.5;
    return a.volume === 0.5;
  })();

  // ---------- helpers ----------
  const dbToGain = (db) => Math.pow(10, db / 20);
  const fmtDb = (db) => (db === 0 ? '0 dB' : '−' + Math.abs(db).toFixed(1).replace(/\.0$/, '') + ' dB');
  const clampDb = (db) => Math.min(DB_MAX, Math.max(DB_MIN, Math.round(db * 2) / 2));

  function setStatus(state, text) {
    ui.status.dataset.state = state;
    ui.statusText.textContent = text;
    ui.play.classList.toggle('on', wantPlay);
    ui.play.classList.toggle('live', state === 'playing');
    ui.play.setAttribute('aria-label', wantPlay ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = wantPlay ? 'playing' : 'paused';
    }
  }

  // ---------- storage (localStorage + Telegram CloudStorage) ----------
  function save(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) { /* private mode */ }
    if (tgAtLeast('6.9') && tg.CloudStorage) {
      try { tg.CloudStorage.setItem(key, String(value), () => {}); } catch (e) { /* ignore */ }
    }
  }

  function applyStored(vol, mode) {
    if (vol !== null && vol !== undefined && vol !== '' && !isNaN(parseFloat(vol))) {
      setVolume(parseFloat(vol), false);
    }
    if (mode !== null && mode !== undefined && mode !== '') {
      compat = mode === '1';
      ui.compat.checked = compat;
      updateVolumeUi();
    }
  }

  function loadSettings() {
    let vol = null, mode = null;
    try { vol = localStorage.getItem(KEY_VOL); mode = localStorage.getItem(KEY_COMPAT); } catch (e) { /* ignore */ }
    applyStored(vol, mode);
    // CloudStorage follows the user across devices; it wins unless the user already moved something
    if (tgAtLeast('6.9') && tg.CloudStorage) {
      tg.CloudStorage.getItems([KEY_VOL, KEY_COMPAT], (err, values) => {
        if (err || !values || userTouchedSettings) return;
        applyStored(values[KEY_VOL], values[KEY_COMPAT]);
      });
    }
  }

  // ---------- volume ----------
  let saveTimer = null;
  function setVolume(db, persist) {
    volDb = clampDb(db);
    ui.vol.value = String(volDb);
    ui.volValue.textContent = fmtDb(volDb);
    const pct = ((volDb - DB_MIN) / (DB_MAX - DB_MIN)) * 100;
    ui.vol.style.setProperty('--p', pct + '%');
    applyGain();
    if (persist) {
      userTouchedSettings = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(KEY_VOL, volDb), 400);
    }
  }

  function applyGain() {
    const g = dbToGain(volDb);
    if (gainNode && ctx) {
      // short ramp so moving the slider never clicks
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      gainNode.gain.setTargetAtTime(g, ctx.currentTime, 0.03);
    }
    if (audio && audioMode === 'compat' && volumeSettable) {
      audio.volume = g;
    }
  }

  function updateVolumeUi() {
    const locked = compat && !volumeSettable;   // iPhone in compat mode
    ui.volBox.classList.toggle('disabled', locked);
    ui.volNote.hidden = !locked;
  }

  // ---------- audio graph ----------
  function ensureContext() {
    if (compat) return;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { compat = true; ui.compat.checked = true; updateVolumeUi(); return; }
      ctx = new AC({ latencyHint: 'playback' });
      gainNode = ctx.createGain();
      gainNode.gain.value = dbToGain(volDb);
      gainNode.connect(ctx.destination);
      ctx.onstatechange = () => {
        if (ctx.state === 'running' && wantPlay && audio && audio.paused && !switching()) {
          audio.play().catch(() => {});
        }
      };
    }
    resumeContext();
  }

  function resumeContext() {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  function destroyAudio() {
    if (!audio) return;
    markSwitch();
    try { audio.pause(); } catch (e) { /* ignore */ }
    audio.removeAttribute('src');
    try { audio.load(); } catch (e) { /* ignore */ }
    if (source) { try { source.disconnect(); } catch (e) { /* ignore */ } }
    source = null;
    audio = null;
    audioMode = null;
  }

  function ensureAudio() {
    const mode = compat ? 'compat' : 'webaudio';
    if (audio && audioMode === mode) return;
    destroyAudio();

    const a = new Audio();
    a.preload = 'none';
    a.setAttribute('playsinline', '');
    a.setAttribute('webkit-playsinline', '');
    if (mode === 'webaudio') {
      a.crossOrigin = 'anonymous';           // required, or Web Audio outputs silence
      source = ctx.createMediaElementSource(a);
      source.connect(gainNode);
    }

    a.addEventListener('playing', () => {
      if (a !== audio) return;
      attempts = 0;
      pausedBySystem = false;
      lastProgressAt = Date.now();
      setStatus('playing', 'Live');
    });
    a.addEventListener('timeupdate', () => { if (a === audio) lastProgressAt = Date.now(); });
    a.addEventListener('waiting', () => {
      if (a === audio && wantPlay && !switching()) setStatus('loading', 'Buffering…');
    });
    a.addEventListener('error', () => { if (a === audio && wantPlay && !switching()) scheduleReconnect(); });
    a.addEventListener('ended', () => { if (a === audio && wantPlay && !switching()) scheduleReconnect(); });
    a.addEventListener('pause', () => {
      // A pause we did not ask for: iOS interruption, another app took audio, headphones unplugged.
      if (a !== audio || switching() || !wantPlay) return;
      // stream ended or broke: browsers fire "pause" right before "ended"/"error"; that is a reconnect case
      if (a.ended || a.error) return;
      wantPlay = false;
      pausedBySystem = true;
      clearReconnect();
      setStatus('idle', 'Paused');
    });

    audio = a;
    audioMode = mode;
    applyGain();
  }

  // ---------- playback ----------
  function connect() {
    clearReconnect();
    if (!wantPlay || !audio) return;
    markSwitch();
    // fresh URL every time: always the live edge, never a stale buffer
    audio.src = STREAM + '?_=' + Date.now();
    lastProgressAt = Date.now();
    setStatus(attempts ? 'reconnecting' : 'loading', attempts ? 'Reconnecting…' : 'Connecting…');
    const p = audio.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (!wantPlay) return;
        if (err && err.name === 'NotAllowedError') {
          wantPlay = false;
          setStatus('idle', 'Tap to play');
        } else if (!err || err.name !== 'AbortError') {
          scheduleReconnect();
        }
      });
    }
  }

  function start() {
    // iOS 17+ WebKit: "playback" session ignores the silent switch and is meant for background audio
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
    wantPlay = true;
    pausedBySystem = false;
    attempts = 0;
    ensureContext();
    ensureAudio();
    connect();
  }

  function stop(text) {
    wantPlay = false;
    pausedBySystem = false;
    clearReconnect();
    if (audio) {
      markSwitch();
      audio.pause();
      // drop the connection so we do not keep downloading while paused
      audio.removeAttribute('src');
      audio.load();
    }
    setStatus('idle', text || 'Paused');
  }

  function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function scheduleReconnect() {
    if (!wantPlay || reconnectTimer) return;
    attempts += 1;
    const delay = attempts === 1 ? 500 : Math.min(15000, 1000 * Math.pow(2, attempts - 2));
    setStatus('reconnecting', navigator.onLine === false ? 'Offline, waiting…' : 'Reconnecting…');
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  // watchdog: a live stream that stops advancing is a dead stream
  setInterval(() => {
    if (!wantPlay || !audio || switching() || reconnectTimer) return;
    if (!compat) resumeContext();
    const idle = Date.now() - lastProgressAt;
    // the element silently stopped (src dropped, server closed without "ended") or is frozen
    if ((audio.paused && idle > 3000) || idle > STALL_MS) scheduleReconnect();
  }, 1000);

  window.addEventListener('online', () => { if (wantPlay) { attempts = Math.max(attempts, 1); connect(); } });

  // ---------- UI events ----------
  ui.play.addEventListener('click', () => {
    if (tgAtLeast('6.1') && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    if (wantPlay) stop(); else start();
  });

  ui.vol.addEventListener('input', () => setVolume(parseFloat(ui.vol.value), true));
  ui.down.addEventListener('click', () => setVolume(volDb - DB_STEP_BUTTON, true));
  ui.up.addEventListener('click', () => setVolume(volDb + DB_STEP_BUTTON, true));

  ui.compat.addEventListener('change', () => {
    userTouchedSettings = true;
    compat = ui.compat.checked;
    save(KEY_COMPAT, compat ? '1' : '0');
    updateVolumeUi();
    const wasPlaying = wantPlay;
    if (wasPlaying) stop();
    destroyAudio();                 // the old element is wired for the other mode
    if (wasPlaying) start();        // this change event is a user gesture, play() is allowed
  });

  // any touch is a user gesture: good moment to unlock a suspended AudioContext
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, resumeContext, { passive: true }));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    resumeContext();
    if (pausedBySystem) {
      start();
    } else if (wantPlay && audio && (audio.paused || Date.now() - lastProgressAt > STALL_MS)) {
      connect();
    }
  });

  // ---------- Media Session (lock screen / Control Center) ----------
  if ('mediaSession' in navigator) {
    const base = new URL('.', location.href).href;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: STATION,
      artist: 'Live radio',
      album: 'montecarlo.cy',
      artwork: [
        { src: base + 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: base + 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* unsupported */ } };
    set('play', () => start());
    set('pause', () => stop());
    set('stop', () => stop());
    ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].forEach((a) => set(a, null));
  }

  // ---------- Telegram ----------
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (tgAtLeast('6.1')) {
        tg.setHeaderColor('bg_color');
        tg.setBackgroundColor('bg_color');
      }
      if (tgAtLeast('7.7') && tg.disableVerticalSwipes) tg.disableVerticalSwipes(); // slider drags must not close the app
      if (tgAtLeast('6.1')) {
        tg.onEvent('themeChanged', () => {
          tg.setHeaderColor('bg_color');
          tg.setBackgroundColor('bg_color');
        });
      }
    } catch (e) { /* older client */ }
  }

  // ---------- init ----------
  setVolume(DB_DEFAULT, false);
  loadSettings();
  updateVolumeUi();
  setStatus('idle', 'Tap to play');

  // tiny debug hook for automated checks
  window.__radio = {
    get audio() { return audio; },
    get state() {
      return {
        wantPlay, compat, volDb, attempts,
        gain: gainNode ? gainNode.gain.value : null,
        ctx: ctx ? ctx.state : null,
        paused: audio ? audio.paused : null,
        mode: audioMode,
        status: ui.status.dataset.state,
      };
    },
  };
})();
