(() => {
  'use strict';

  // Direct Shoutcast stream found on https://montecarlo.cy/live/ (MP3 128 kbps).
  // It sends "Access-Control-Allow-Origin: *", so the page can fetch() and decode it itself.
  const STREAM = 'https://live.vblcast.com/proxy/montecarlo/stream';
  const STATION = 'Radio Monte Carlo';

  // Quiet mode: on a Bluetooth speaker with absolute volume (iPhone + JBL Flip 6) the phone's
  // lowest step can still be too loud. Quiet mode attenuates the audio itself, down to QUIET_MIN.
  // A MediaElementSource -> GainNode graph had no effect on this live stream on a real iPhone
  // (WebKit plays it past the graph), so quiet mode does not use <audio> at all: it fetches the
  // MP3 stream, decodes it in ~0.5 s pieces and plays them through a GainNode.
  const QUIET_MIN = 0.03;           // 3 % amplitude = -30 dB
  const QUIET_DEFAULT = 0.25;
  const QUIET_STEP = 5;             // +/- buttons, in slider units (0..100)
  const CHUNK_FRAMES = 19;          // MP3 frames per decoded piece (~0.5 s)
  const OVERLAP_FRAMES = 4;         // decoded again before each piece: bit reservoir + filterbank warm-up
                                    // (3 is already sample-exact against one-shot decoding in tests)
  const START_LEAD = 1.0;           // seconds scheduled ahead when (re)starting
  // The server sends ~12 s at once on connect (burst), so ~12 s ahead is normal.
  // Far more means the context is frozen while data keeps coming: drop, the watchdog reconnects.
  const MAX_LEAD = 30;

  const STALL_MS = 12000;           // no progress for this long => reconnect
  const KEY_QUIET = 'mc_quiet';
  const KEY_QUIET_GAIN = 'mc_quiet_gain';
  // Centova Cast "now playing" (JSON with Access-Control-Allow-Origin: *)
  const META_URL = 'https://live.vblcast.com/external/rpc.php?m=streaminfo.get&username=montecarlo&rid=montecarlo&charset=&mountpoint=';

  const $ = (id) => document.getElementById(id);
  const ui = {
    play: $('play'),
    status: $('status'),
    statusText: $('status-text'),
    vol: $('vol'),
    volValue: $('vol-value'),
    volBox: document.querySelector('.volume'),
    down: $('vol-down'),
    up: $('vol-up'),
    quiet: $('quiet'),
  };

  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = !!(tg && tg.initData);
  const tgAtLeast = (v) => !!(inTelegram && tg.isVersionAtLeast && tg.isVersionAtLeast(v));

  const AC = window.AudioContext || window.webkitAudioContext;
  const quietSupported = !!(AC && window.fetch && window.ReadableStream && window.OfflineAudioContext);

  // ---------- state ----------
  let quiet = false;
  let quietGain = QUIET_DEFAULT;
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

  let audio = null;            // plain mode: the <audio> element
  let ctx = null;              // quiet mode: AudioContext
  let gainNode = null;
  let q = null;                // quiet mode: the current stream connection
  let underruns = 0;           // quiet mode: times the buffer ran dry (debug)
  let dropped = 0;             // quiet mode: pieces thrown away as too far ahead (debug)

  // ---------- helpers ----------
  const LN_MIN = Math.log(QUIET_MIN);
  const posToGain = (p) => Math.exp(LN_MIN * (1 - p / 100));        // log scale: fine steps at the bottom
  const gainToPos = (g) => 100 * (1 - Math.log(g) / LN_MIN);
  const clampGain = (g) => Math.min(1, Math.max(QUIET_MIN, g));
  const fmtPct = (g) => (g >= 0.095 ? Math.round(g * 100) : (g * 100).toFixed(1)) + '%';

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

  function applyStored(gain, mode) {
    if (gain !== null && gain !== undefined && gain !== '' && !isNaN(parseFloat(gain))) {
      setQuietGain(parseFloat(gain), false);
    }
    if (mode !== null && mode !== undefined && mode !== '') {
      quiet = quietSupported && mode === '1';
      ui.quiet.checked = quiet;
      updateQuietUi();
    }
  }

  function loadSettings() {
    let gain = null, mode = null;
    try { gain = localStorage.getItem(KEY_QUIET_GAIN); mode = localStorage.getItem(KEY_QUIET); } catch (e) { /* ignore */ }
    applyStored(gain, mode);
    // CloudStorage follows the user across devices; it wins unless the user already moved something
    if (tgAtLeast('6.9') && tg.CloudStorage) {
      tg.CloudStorage.getItems([KEY_QUIET_GAIN, KEY_QUIET], (err, values) => {
        if (err || !values || userTouchedSettings || wantPlay) return;
        applyStored(values[KEY_QUIET_GAIN], values[KEY_QUIET]);
      });
    }
  }

  // ---------- quiet level ----------
  let saveTimer = null;
  function setQuietGain(g, persist) {
    quietGain = clampGain(g);
    const pos = gainToPos(quietGain);
    ui.vol.value = String(Math.round(pos));
    ui.vol.style.setProperty('--p', pos + '%');
    ui.volValue.textContent = fmtPct(quietGain);
    if (gainNode && ctx) {
      // short ramp so moving the slider never clicks
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      gainNode.gain.setTargetAtTime(quietGain, ctx.currentTime, 0.03);
    }
    if (persist) {
      userTouchedSettings = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(KEY_QUIET_GAIN, quietGain.toFixed(4)), 400);
    }
  }

  function updateQuietUi() {
    ui.volBox.hidden = !quiet;
  }

  // ---------- plain mode: <audio> element ----------
  function destroyAudio() {
    if (!audio) return;
    markSwitch();
    try { audio.pause(); } catch (e) { /* ignore */ }
    audio.removeAttribute('src');
    try { audio.load(); } catch (e) { /* ignore */ }
    audio = null;
  }

  function ensureAudio() {
    if (audio) return;
    const a = new Audio();
    a.preload = 'none';
    a.setAttribute('playsinline', '');
    a.setAttribute('webkit-playsinline', '');

    a.addEventListener('playing', () => {
      if (a !== audio) return;
      attempts = 0;
      pausedBySystem = false;
      lastProgressAt = Date.now();
      setStatus('playing', 'Live');
      pollMeta();
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
      systemPaused();
    });
    audio = a;
  }

  function plainConnect() {
    markSwitch();
    // fresh URL every time: always the live edge, never a stale buffer
    audio.src = STREAM + '?_=' + Date.now();
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

  // ---------- quiet mode: fetch + MP3 frames + decodeAudioData + GainNode ----------
  function ensureContext() {
    if (!ctx) {
      // 44.1 kHz like the stream: pieces then join sample-exactly, no resampling at the seams
      try { ctx = new AC({ latencyHint: 'playback', sampleRate: 44100 }); } catch (e) { ctx = new AC(); }
      gainNode = ctx.createGain();
      gainNode.gain.value = quietGain;
      gainNode.connect(ctx.destination);
      ctx.onstatechange = () => {
        // iOS suspends / interrupts the context on calls, Siri, other apps taking audio
        if (ctx.state !== 'running' && quiet && wantPlay && q && q.started) systemPaused();
      };
    }
    resumeContext();
  }

  function resumeContext() {
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && (wantPlay || pausedBySystem)) {
      ctx.resume().catch(() => {});
    }
  }

  const decoders = {};
  function decoderFor(sr) {
    if (!decoders[sr]) decoders[sr] = new OfflineAudioContext(2, 1, sr);
    return decoders[sr];
  }

  // MPEG audio Layer III frame header -> { len, sr, spf } or null
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const SR1 = [44100, 48000, 32000];
  function frameHeader(u8, i) {
    if (u8[i] !== 0xff || (u8[i + 1] & 0xe0) !== 0xe0) return null;
    const ver = (u8[i + 1] >> 3) & 3;              // 3 MPEG1, 2 MPEG2, 0 MPEG2.5
    if (ver === 1 || ((u8[i + 1] >> 1) & 3) !== 1) return null;   // Layer III only
    const bi = u8[i + 2] >> 4, si = (u8[i + 2] >> 2) & 3, pad = (u8[i + 2] >> 1) & 1;
    if (bi === 0 || bi === 15 || si === 3) return null;
    const mpeg1 = ver === 3;
    const sr = SR1[si] / (mpeg1 ? 1 : ver === 2 ? 2 : 4);
    const br = (mpeg1 ? BR1 : BR2)[bi] * 1000;
    const spf = mpeg1 ? 1152 : 576;
    return { len: Math.floor((spf / 8) * br / sr) + pad, sr, spf };
  }

  function concatBytes(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function quietStop() {
    const my = q;
    q = null;
    if (!my) return;
    try { my.ctrl.abort(); } catch (e) { /* ignore */ }
    my.sources.forEach((s) => { try { s.stop(); } catch (e) { /* ignore */ } });
  }

  async function quietConnect() {
    quietStop();
    const my = q = { ctrl: new AbortController(), sources: new Set(), nextTime: 0, started: false };
    let rest = new Uint8Array(0);   // bytes not yet split into frames
    let fmt = null;
    const history = [];             // frames decoded again in front of the next piece
    const pending = [];             // frames waiting to be played
    try {
      const resp = await fetch(STREAM + '?_=' + Date.now(), { signal: my.ctrl.signal, cache: 'no-store' });
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (my !== q) return;
        if (done) throw new Error('stream ended');
        const bytes = rest.length ? concatBytes([rest, value]) : value;
        let i = 0;
        while (i + 4 <= bytes.length) {
          const h = frameHeader(bytes, i);
          // a header counts only if the next frame starts right after it (no false syncs in audio data)
          if (!h || (i + h.len + 3 <= bytes.length && !frameHeader(bytes, i + h.len))) { i++; continue; }
          if (i + h.len + 3 > bytes.length) break;   // wait for the rest of the frame and the next header
          if (!fmt) fmt = h;
          if (h.sr === fmt.sr) {
            const f = bytes.slice(i, i + h.len);
            if (history.length < OVERLAP_FRAMES && !my.started && !pending.length) history.push(f);
            else pending.push(f);
          }
          i += h.len;
        }
        rest = bytes.slice(i);
        // one frame after the piece is decoded too, so the piece's own end is complete
        while (pending.length > CHUNK_FRAMES) {
          const piece = pending.splice(0, CHUNK_FRAMES);
          await playPiece(my, history, piece, pending[0], fmt);
          if (my !== q) return;
          history.push(...piece);
          history.splice(0, history.length - OVERLAP_FRAMES);
        }
      }
    } catch (e) {
      if (my !== q) return;          // aborted by us
      scheduleReconnect();
    }
  }

  async function playPiece(my, history, piece, ahead, fmt) {
    const bytes = concatBytes(history.concat(piece, [ahead]));
    const decoded = await decoderFor(fmt.sr).decodeAudioData(bytes.buffer);
    if (my !== q) return;
    // Decoders differ in how many samples they drop at the start (encoder delay), but the end
    // is the same distance from the last frame every time, so take the piece counted from the end.
    const end = Math.max(0, decoded.length - fmt.spf);
    const start = Math.max(0, end - piece.length * fmt.spf);
    if (end <= start) return;
    const buf = ctx.createBuffer(decoded.numberOfChannels, end - start, decoded.sampleRate);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      buf.getChannelData(c).set(decoded.getChannelData(c).subarray(start, end));
    }

    const now = ctx.currentTime;
    const dry = my.nextTime < now + 0.05;
    if (dry) {
      if (my.started) { underruns += 1; setStatus('loading', 'Buffering…'); }
      my.nextTime = now + START_LEAD;
    }
    if (my.nextTime - now > MAX_LEAD) { dropped += 1; return; }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gainNode);
    src.onended = () => my.sources.delete(src);
    src.start(my.nextTime);
    my.sources.add(src);
    const startsIn = (my.nextTime - now) * 1000;
    my.nextTime += buf.duration;
    lastProgressAt = Date.now();

    if (dry) {
      setTimeout(() => {
        if (my !== q || !wantPlay) return;
        const first = !my.started;
        my.started = true;
        attempts = 0;
        pausedBySystem = false;
        setStatus('playing', 'Live');
        if (first) pollMeta();
      }, startsIn);
    }
  }

  // ---------- playback ----------
  function connect() {
    clearReconnect();
    if (!wantPlay) return;
    lastProgressAt = Date.now();
    setStatus(attempts ? 'reconnecting' : 'loading', attempts ? 'Reconnecting…' : 'Connecting…');
    if (quiet) quietConnect();
    else if (audio) plainConnect();
  }

  function start() {
    // iOS 17+ WebKit: "playback" session ignores the silent switch and is meant for background audio
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
    wantPlay = true;
    pausedBySystem = false;
    attempts = 0;
    if (quiet) {
      destroyAudio();
      ensureContext();
    } else {
      quietStop();
      ensureAudio();
    }
    connect();
  }

  function stop(text) {
    wantPlay = false;
    pausedBySystem = false;
    clearReconnect();
    quietStop();
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});   // let the audio hardware sleep
    if (audio) {
      markSwitch();
      audio.pause();
      // drop the connection so we do not keep downloading while paused
      audio.removeAttribute('src');
      audio.load();
    }
    setStatus('idle', text || 'Paused');
  }

  // iOS interruption, another app took audio, headphones unplugged: resume when we come back
  function systemPaused() {
    stop();
    pausedBySystem = true;
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
    if (!wantPlay || switching() || reconnectTimer) return;
    const idle = Date.now() - lastProgressAt;
    if (quiet) {
      if (idle > STALL_MS) scheduleReconnect();
      return;
    }
    if (!audio) return;
    // the element silently stopped (src dropped, server closed without "ended") or is frozen
    if ((audio.paused && idle > 3000) || idle > STALL_MS) scheduleReconnect();
  }, 1000);

  window.addEventListener('online', () => { if (wantPlay) { attempts = Math.max(attempts, 1); connect(); } });

  // ---------- UI events ----------
  ui.play.addEventListener('click', () => {
    if (tgAtLeast('6.1') && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    if (wantPlay) stop(); else start();
  });

  ui.vol.addEventListener('input', () => setQuietGain(posToGain(parseFloat(ui.vol.value)), true));
  ui.down.addEventListener('click', () => setQuietGain(posToGain(gainToPos(quietGain) - QUIET_STEP), true));
  ui.up.addEventListener('click', () => setQuietGain(posToGain(gainToPos(quietGain) + QUIET_STEP), true));

  ui.quiet.addEventListener('change', () => {
    userTouchedSettings = true;
    quiet = quietSupported && ui.quiet.checked;
    ui.quiet.checked = quiet;
    save(KEY_QUIET, quiet ? '1' : '0');
    updateQuietUi();
    if (wantPlay || pausedBySystem) { stop(); start(); }   // a user gesture: play() / resume() allowed
  });

  // any touch is a user gesture: good moment to unlock a suspended AudioContext
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, resumeContext, { passive: true }));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    pollMeta();
    if (pausedBySystem) {
      start();
    } else if (wantPlay && quiet) {
      resumeContext();
      // stalled while we were away: start again at the live edge
      if (!q || Date.now() - lastProgressAt > STALL_MS) connect();
    } else if (wantPlay && audio && (audio.paused || Date.now() - lastProgressAt > STALL_MS)) {
      connect();
    }
  });

  // ---------- Media Session (lock screen / Control Center) ----------
  const ARTWORK = (() => {
    const base = new URL('.', location.href).href;
    return [
      // full-bleed squares: iOS fills transparent corners with white on the lock screen
      { src: base + 'apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { src: base + 'icon-maskable-512.png', sizes: '512x512', type: 'image/png' },
    ];
  })();

  function setLockScreen(title, artist) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || STATION,
      artist: artist || 'Limassol · 104.5 FM',
      album: STATION + ' · 104.5 FM',
      artwork: ARTWORK,
    });
  }

  if ('mediaSession' in navigator) {
    setLockScreen();
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* unsupported */ } };
    set('play', () => start());
    set('pause', () => stop());
    set('stop', () => stop());
    ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].forEach((a) => set(a, null));
  }

  // ---------- now playing ----------
  const nowUi = { box: $('now'), title: $('now-title'), artist: $('now-artist') };
  let lastSong = null;
  let metaTimer = null;

  // The server double-encodes: UTF-8 bytes shown as Windows-1252 ("BEYONCÃ‰" for "BEYONCÉ").
  // Turn the characters back into bytes and read them as UTF-8; leave clean strings alone.
  const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
    0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
  function fixMojibake(s) {
    if (!/[Â-ô][\u0080-¿Œ-™]/.test(s)) return s;
    const bytes = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 256) bytes.push(c);
      else if (CP1252[c] !== undefined) bytes.push(CP1252[c]);
      else return s;                                // a real non-Latin character: not mojibake
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch (e) { return s; }
  }

  // the station sends everything in capitals ("QUEEN - YOU DON'T FOOL ME"); make it readable
  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s(\-"/&])([a-zà-ɏͰ-ϿЀ-ӿ])/g,
      (m, sep, ch) => sep + ch.toUpperCase());
  }

  function parseTrack(info) {
    const t = info && info.track ? info.track : {};
    let artist = fixMojibake(String(t.artist || '')).replace(/^\s*now playing:\s*/i, '').trim();
    let title = fixMojibake(String(t.title || '')).trim();
    if (!title && info && info.song) {            // fall back to "ARTIST - TITLE"
      const raw = fixMojibake(String(info.song)).replace(/^\s*now playing:\s*/i, '');
      const i = raw.indexOf(' - ');
      if (i > 0) { artist = raw.slice(0, i).trim(); title = raw.slice(i + 3).trim(); } else { title = raw.trim(); }
    }
    // jingles / station ids: nothing worth showing
    if (!title || /^monte\s*carlo/i.test(title) || /^monte\s*carlo/i.test(artist + title)) return null;
    return { artist: titleCase(artist), title: titleCase(title), key: artist + '|' + title };
  }

  function showTrack(tr) {
    const key = tr ? tr.key : '';
    if (key === lastSong) return;
    lastSong = key;
    if (!tr) {
      nowUi.box.hidden = true;
      setLockScreen();
      return;
    }
    nowUi.title.textContent = tr.title;
    nowUi.artist.textContent = tr.artist;
    nowUi.box.hidden = false;
    nowUi.box.style.animation = 'none';
    void nowUi.box.offsetWidth;                   // restart the fade-in
    nowUi.box.style.animation = '';
    setLockScreen(tr.title, tr.artist);
  }

  async function pollMeta() {
    clearTimeout(metaTimer);
    try {
      const r = await fetch(META_URL, { cache: 'no-store' });
      const j = await r.json();
      showTrack(parseTrack(j && j.data && j.data[0]));
    } catch (e) { /* keep what we show; try again later */ }
    // often while listening (songs change every ~3-4 min), rarely otherwise
    const next = wantPlay ? 15000 : (document.visibilityState === 'visible' ? 60000 : 0);
    if (next) metaTimer = setTimeout(pollMeta, next);
  }

  // ---------- theme: fixed dark look; paint Telegram's own bars to match ----------
  function applyScheme() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (!/^#[0-9a-f]{6}$/i.test(bg)) return;
    if (tgAtLeast('6.1')) {
      try { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); } catch (e) { /* ignore */ }
    }
    if (tgAtLeast('7.10') && tg.setBottomBarColor) {
      try { tg.setBottomBarColor(bg); } catch (e) { /* ignore */ }
    }
  }

  // ---------- Telegram ----------
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (tgAtLeast('7.7') && tg.disableVerticalSwipes) tg.disableVerticalSwipes(); // slider drags must not close the app
      if (tgAtLeast('6.1')) tg.onEvent('themeChanged', applyScheme);
    } catch (e) { /* older client */ }
  }
  applyScheme();

  // ---------- init ----------
  if (!quietSupported) ui.quiet.closest('label').hidden = true;
  setQuietGain(QUIET_DEFAULT, false);
  loadSettings();
  updateQuietUi();
  setStatus('idle', 'Tap to play');
  pollMeta();

  // tiny debug hook for automated checks
  window.__radio = {
    get audio() { return audio; },
    get ctx() { return ctx; },
    get gainNode() { return gainNode; },
    get state() {
      return {
        wantPlay, quiet, attempts, underruns, dropped,
        gain: gainNode ? gainNode.gain.value : null,
        quietGain,
        ctx: ctx ? ctx.state : null,
        lead: q && ctx ? q.nextTime - ctx.currentTime : null,
        paused: audio ? audio.paused : null,
        mode: quiet ? 'quiet' : 'plain',
        status: ui.status.dataset.state,
      };
    },
  };
})();
