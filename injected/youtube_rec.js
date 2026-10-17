// "Record while playing" for YouTube (page world, document_start).
//
// YouTube now serves video through SABR, so there are no plain stream URLs to download.
// What always exists is the media the player hands to the browser decoder through
// MediaSource/SourceBuffer.appendBuffer. When the user ARMS recording, this script keeps a
// copy of those appended segments and lets the user save them as ordinary .mp4/.webm files.
//
//  * It does not decrypt anything. Encrypted (EME/DRM) media is detected and refused.
//  * It does nothing until armed (zero parsing, zero copies), and it never sends data
//    anywhere: files are built in the page and saved through a normal browser download.
//  * Armed state lives in sessionStorage ("vdlRec"); the page is reloaded once so that the
//    recording starts from the first segment.

(() => {
  'use strict';

  // Parsers and the muxer live in lib/mux.js (loaded just before this file).
  const { Mp4Parser, WebmParser, mp4InitHeight, webmPixelHeight, concat, mergeReps } = globalThis.__vdlMux;

  function hashBytes(b) {
    let h = 2166136261;
    const n = Math.min(b.length, 8192);
    for (let i = 0; i < n; i++) { h ^= b[i]; h = Math.imul(h, 16777619); }
    return `${(h >>> 0).toString(36)}-${b.length}`;
  }

  // -------------------------------------------------------------- recording ----
  class TrackCapture {
    constructor(mime, onBytes) {
      this.mime = mime;
      const base = mime.split(';')[0].trim().toLowerCase();
      this.kind = base.startsWith('audio/') ? 'audio' : 'video';
      this.container = base.endsWith('webm') ? 'webm' : 'mp4';
      this.ext = this.kind === 'audio' ? (this.container === 'webm' ? 'weba' : 'm4a') : this.container;
      this.reps = new Map();
      this.appends = 0;
      this.appendBytes = 0;
      this.cur = null;
      this.dropping = false;
      this.onBytes = onBytes;
      const onInit = (init, meta) => {
        const key = hashBytes(init);
        if (!this.reps.has(key)) this.reps.set(key, { init, height: meta.height || 0, frags: new Map(), bytes: 0 });
        this.cur = this.reps.get(key);
      };
      const onFragment = (time, bytes) => {
        if (this.dropping || !this.cur || this.cur.frags.has(time)) return;
        this.cur.frags.set(time, new Blob([bytes]));
        this.cur.bytes += bytes.length;
        this.onBytes(bytes.length);
      };
      this.parser = this.container === 'webm' ? new WebmParser(onInit, onFragment) : new Mp4Parser(onInit, onFragment);
    }
    best() {
      let best = null;
      for (const r of this.reps.values()) if (!best || r.frags.size > best.frags.size) best = r;
      return best;
    }
  }

  // When to stop recording. Pure function so it can be tested.
  // s: { current, duration, bufferedEnd, speed, ad, idChanged, durChanged, holdMs }
  // -> 'continue' | 'hold' (pause and wait for the last segments) | 'finish'
  // The check runs every 250 ms and on player events; the margin scales with the playback speed so a
  // fast-forwarded recording can never jump over the end into the next video or an ad.
  function decideEnd(s) {
    if (s.ad) return 'continue';
    if (s.idChanged || s.durChanged) return 'finish';
    if (!(s.duration > 0)) return 'continue';
    const margin = Math.max(0.6, (s.speed || 1) * 1.0);
    if (s.duration - s.current > margin) return 'continue';
    const covered = s.bufferedEnd >= s.duration - 0.6;
    return covered || s.holdMs > 8000 ? 'finish' : 'hold';
  }

  // Is this appended buffer an initialization segment (fMP4: ftyp/moov first; WebM: EBML header first)?
  function looksLikeInit(b) {
    if (!b || b.length < 12) return false;
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true;
    const t = String.fromCharCode(b[4], b[5], b[6], b[7]);
    return t === 'ftyp' || t === 'moov';
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ...globalThis.__vdlMux, TrackCapture, decideEnd, looksLikeInit };
    return;
  }

  // ------------------------------------------------------------ page logic ----
  if (window.__vdlRec) return;
  window.__vdlRec = true;

  const rec = {
    state: 'idle', // idle | recording | done | saved | error
    error: '',
    tracks: new Map(), // SourceBuffer -> TrackCapture
    bytes: 0,
    maxBytes: 4096 * 1024 * 1024,
    speed: 2,
    video: null,
    prev: null,
    timer: null,
    id: '',
    dur0: 0,
    holdAt: 0,
    interrupted: false,
    tick: 0,
    live: false,
    draining: false,
    t0: 0,
    maxMs: 0,
    ms: null, // MediaSource of the main player (live recording without a reload)
  };
  const sbMime = new WeakMap();
  const sbInit = new WeakMap(); // last init segment per SourceBuffer, kept while idle so a LIVE recording can start without a reload
  const sbList = [];
  const sbMs = new WeakMap(); // SourceBuffer -> its MediaSource (a page can run several players: the main one, previews, ads)
  const sbBytes = new WeakMap(); // bytes appended per SourceBuffer
  const urlToMs = new Map(); // blob: URL -> WeakRef(MediaSource)

  const videoIdNow = () => { try { return new URL(location.href).searchParams.get('v') || ''; } catch { return ''; } };
  const isAd = () => !!document.querySelector('#movie_player.ad-showing, .html5-video-player.ad-showing');
  const post = (payload) => { try { window.postMessage({ __vdl: 'rec-status', payload: JSON.stringify(payload) }, window.location.origin); } catch { /* ignore */ } };

  // One capture per kind (video / audio): the one with the most fragments. A player can replace its
  // SourceBuffers (new MediaSource after a quality or live-edge jump); only the fullest copy is kept.
  function usedTracks() {
    // per MediaSource: the fullest capture of each kind; the MediaSource that has both kinds (then the most fragments) wins,
    // so audio of one player is never joined with the video of another one
    const groups = new Map();
    for (const [sb, t] of rec.tracks) {
      const r = t.best();
      const n = r ? r.frags.size : 0;
      if (!n) continue;
      const key = sbMs.get(sb) || 'none';
      if (!groups.has(key)) groups.set(key, new Map());
      const g = groups.get(key);
      const cur = g.get(t.kind);
      if (!cur || n > cur.n) g.set(t.kind, { t, n });
    }
    let pick = null;
    let score = -1;
    for (const g of groups.values()) {
      const sc = (g.size === 2 ? 1e9 : 0) + [...g.values()].reduce((x, y) => x + y.n, 0);
      if (sc > score) { score = sc; pick = g; }
    }
    return pick ? [...pick.values()].map((x) => x.t) : [];
  }

  function summary() {
    const tracks = usedTracks().map((t) => {
      const r = t.best();
      return { kind: t.kind, container: t.container, ext: t.ext, height: r ? r.height : 0, fragments: r ? r.frags.size : 0, bytes: r ? r.bytes : 0 };
    }).filter((t) => t.fragments > 0).sort((a, b) => (a.kind === 'video' ? -1 : 1) - (b.kind === 'video' ? -1 : 1));
    const v = rec.video;
    return {
      state: rec.state, error: rec.error, bytes: rec.bytes, merged: !!rec.merged, tracks,
      dbg: [...rec.tracks.values()].map((t) => ({ kind: t.kind, mime: t.mime.slice(0, 70), appends: t.appends, appendBytes: t.appendBytes, reps: t.reps.size, frags: [...t.reps.values()].map((r) => r.frags.size).slice(0, 6), dropping: t.dropping, first: t.first || '', pend: t.parser && t.parser.pending ? t.parser.pending.length : 0 })).slice(0, 4),
      draining: !!rec.draining, live: !!rec.live, seconds: rec.live && rec.t0 ? Math.round((Date.now() - rec.t0) / 1000) : 0,
      interrupted: !!rec.interrupted, current: v ? v.currentTime : 0, duration: v && isFinite(v.duration) ? v.duration : 0,
      progress: v && isFinite(v.duration) && v.duration > 0 ? Math.min(1, v.currentTime / v.duration) : 0,
    };
  }
  const report = () => post(summary());

  function fail(code) {
    rec.state = 'error';
    rec.error = code;
    stopPlayback();
    report();
  }

  function stopPlayback() {
    clearInterval(rec.timer);
    rec.timer = null;
    const v = rec.video;
    if (v && rec.prev) {
      try { v.muted = rec.prev.muted; v.playbackRate = 1; v.pause(); } catch { /* ignore */ }
    }
    try { sessionStorage.removeItem('vdlRec'); } catch { /* ignore */ }
  }

  function onAppend(sb, data) {
    try { // keep the newest init segment of every buffer (idle or recording), so a LIVE recording can start without a reload
      const v0 = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 16)) : new Uint8Array(data, 0, Math.min(data.byteLength, 16));
      if (looksLikeInit(v0)) {
        const full = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        if (full.length < 2000000) sbInit.set(sb, full.slice());
      }
    } catch { /* ignore */ }
    try { sbBytes.set(sb, (sbBytes.get(sb) || 0) + (data.byteLength || 0)); } catch { /* ignore */ }
    if (rec.state !== 'recording') return;
    if (rec.ms && sbMs.get(sb) !== rec.ms) return; // another player on the page
    let t = rec.tracks.get(sb);
    if (!t) {
      const mime = sbMime.get(sb);
      if (!mime) return;
      t = new TrackCapture(mime, (n) => { rec.bytes += n; });
      rec.tracks.set(sb, t);
    }
    t.dropping = isAd();
    const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (!t.first) t.first = Array.from(view.subarray(0, 20), (x) => x.toString(16).padStart(2, '0')).join('');
    t.appends++;
    t.appendBytes += view.byteLength;
    t.parser.push(view.slice());
    if (rec.bytes > rec.maxBytes) fail('toolarge');
  }

  // Hooks are installed always (cheap pass-through) so nothing is missed after a reload.
  try {
    const origAdd = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function addSourceBuffer(mime) {
      const sb = origAdd.apply(this, arguments);
      try { sbMs.set(sb, this); sbMime.set(sb, String(mime)); sbList.push(new WeakRef(sb)); if (sbList.length > 40) sbList.shift(); } catch { /* ignore */ }
      return sb;
    };
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = function createObjectURL(obj) {
      const url = origCreate.apply(this, arguments);
      try { if (obj instanceof MediaSource) { urlToMs.set(url, new WeakRef(obj)); if (urlToMs.size > 60) urlToMs.delete(urlToMs.keys().next().value); } } catch { /* ignore */ }
      return url;
    };
    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function appendBuffer(data) {
      try { onAppend(this, data); } catch { /* never break playback */ }
      return origAppend.apply(this, arguments);
    };
  } catch { /* MediaSource unavailable */ }

  // In-page navigation to another video ends the recording with what has been captured.
  document.addEventListener('yt-navigate-start', () => { if (rec.state === 'recording') finish('changed'); }, true);
  document.addEventListener('encrypted', () => { if (rec.state === 'recording') fail('drm'); }, true);

  function attachVideo(v) {
    rec.video = v;
    rec.prev = { muted: v.muted };
    const apply = () => {
      if (rec.state !== 'recording') return;
      if (!rec.live) v.muted = true;
      if (v.playbackRate !== rec.speed) v.playbackRate = rec.speed;
    };
    v.addEventListener('ratechange', apply);
    v.addEventListener('loadedmetadata', apply);
    v.addEventListener('ended', () => finish('end'));
    if (rec.live) { try { v.play(); } catch { /* ignore */ } }
    for (const ev of ['durationchange', 'emptied', 'loadstart', 'seeking']) v.addEventListener(ev, check);
    apply();
    const p = v.play();
    if (p && p.catch) p.catch(() => {}); // autoplay blocked: the user can press play
  }

  function finish(why) {
    if (rec.state !== 'recording') return;
    if (why === 'changed') rec.interrupted = true;
    rec.state = 'done';
    stopPlayback();
    report();
  }

  // Runs on a 250 ms timer and on player events.
  function check() {
    if (rec.state !== 'recording') return;
    const v = rec.video;
    if (!v) return;
    const ad = isAd();
    const dur = isFinite(v.duration) ? v.duration : 0;
    if (!ad && dur > 0 && !rec.dur0) rec.dur0 = dur;
    let bufferedEnd = 0;
    try { if (v.buffered && v.buffered.length) bufferedEnd = v.buffered.end(v.buffered.length - 1); } catch { /* ignore */ }
    const idChanged = !!rec.id && videoIdNow() !== rec.id;
    if (rec.live) {
      // live: no end by duration; stop on navigation, the time limit, or the user
      if (idChanged) finish('changed');
      else if (rec.maxMs && rec.t0 && Date.now() - rec.t0 > rec.maxMs) finish('end');
      return;
    }
    const durChanged = !ad && rec.dur0 > 0 && dur > 0 && Math.abs(dur - rec.dur0) > 1.5;
    const verdict = decideEnd({
      current: v.currentTime, duration: dur, bufferedEnd, speed: rec.speed, ad, idChanged, durChanged,
      holdMs: rec.holdAt ? Date.now() - rec.holdAt : 0,
    });
    if (verdict === 'hold') {
      if (!rec.holdAt) { rec.holdAt = Date.now(); try { v.pause(); } catch { /* ignore */ } }
    } else if (verdict === 'finish') {
      finish(idChanged || durChanged ? 'changed' : 'end');
    }
  }

  // A regular video must be recorded from 0:00. YouTube may resume a watched video in the middle: the first captured
  // fragment then starts far from zero. Once: drop what was captured and seek to the start; if it still does not
  // begin at 0 the recording stops with an error instead of saving a cut file.
  function earliestMs() {
    let min = null;
    for (const t of rec.tracks.values()) {
      for (const r of t.reps.values()) for (const k of r.frags.keys()) if (min === null || k < min) min = k;
    }
    return min;
  }
  function verifyStart() {
    if (rec.live || rec.startOk || rec.state !== 'recording') return;
    const e = earliestMs();
    if (e === null) return;
    if (e <= 2000) { rec.startOk = true; return; }
    if (rec.restarts >= 1) { fail('start'); return; }
    rec.restarts++;
    for (const t of rec.tracks.values()) for (const r of t.reps.values()) { r.frags.clear(); r.bytes = 0; }
    rec.bytes = 0;
    rec.holdAt = 0;
    try { if (rec.video) { rec.video.currentTime = 0; rec.video.play().catch(() => {}); } } catch { /* ignore */ }
  }

  // LIVE without a reload: continue from the init segments the player already appended.
  const mainVideo = () => document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video') || document.querySelector('video');

  function primeLive() {
    // newest still-attached SourceBuffer per kind, grouped by MediaSource (a removed buffer throws on .buffered)
    const groups = new Map();
    for (const ref of sbList) {
      const sb = ref.deref && ref.deref();
      const init = sb && sbInit.get(sb);
      const mime = sb && sbMime.get(sb);
      const ms = sb && sbMs.get(sb);
      if (!init || !mime || !ms) continue;
      try { void sb.buffered; } catch { continue; }
      if (!groups.has(ms)) groups.set(ms, new Map());
      groups.get(ms).set(mime.toLowerCase().startsWith('audio/') ? 'audio' : 'video', { sb, init, mime });
    }
    // the MediaSource feeding the main player's <video>; otherwise the one that received the most data
    let ms = null;
    try {
      const v = mainVideo();
      const ref = v && urlToMs.get(v.currentSrc || v.src);
      ms = ref && ref.deref ? ref.deref() : null;
    } catch { /* ignore */ }
    let chosen = ms && groups.get(ms) && groups.get(ms).size === 2 ? groups.get(ms) : null;
    if (!chosen) {
      ms = null;
      let best = -1;
      for (const [m, g] of groups) {
        if (g.size !== 2) continue;
        const bytes = [...g.values()].reduce((n, x) => n + (sbBytes.get(x.sb) || 0), 0);
        if (bytes > best) { best = bytes; chosen = g; ms = m; }
      }
    }
    if (!chosen) return 0;
    rec.ms = ms;
    for (const { sb, init, mime } of chosen.values()) {
      const t = new TrackCapture(mime, (k) => { rec.bytes += k; });
      rec.tracks.set(sb, t);
      t.parser.push(init.slice());
      if (t.container === 'webm') t.parser.seekCluster = true; // joined mid-stream: skip to the next cluster / moof
      else t.parser.seekMoof = true;
    }
    return chosen.size;
  }

  function start(opts) {
    rec.ms = null;
    rec.tracks.clear();
    rec.bytes = 0;
    rec.merged = false;
    rec.draining = false;
    rec.state = 'recording';
    rec.error = '';
    rec.interrupted = false;
    rec.startOk = false;
    rec.restarts = 0;
    rec.dur0 = 0;
    rec.holdAt = 0;
    rec.id = videoIdNow();
    rec.live = !!opts.live;
    rec.t0 = Date.now();
    rec.maxMs = rec.live ? Math.max(1, Number(opts.maxMin) || 180) * 60000 : 0;
    rec.speed = rec.live ? 1 : Math.min(4, Math.max(1, Number(opts.speed) || 2));
    rec.maxBytes = (Number(opts.maxMB) || 4096) * 1024 * 1024;
    if (opts.live && opts.noReload && primeLive() < 2) {
      // no init segments for both tracks: fall back to the reload-and-arm path
      rec.tracks.clear();
      rec.ms = null;
      rec.bytes = 0;
      rec.state = 'idle';
      window.postMessage({ __vdl: 'rec-reload', payload: '{}' }, window.location.origin);
      return;
    }
    rec.timer = setInterval(() => {
      if (rec.state !== 'recording') return;
      if (!rec.video) {
        const v = mainVideo();
        if (v) attachVideo(v);
      }
      check();
      verifyStart();
      if (rec.state === 'recording' && ++rec.tick % 4 === 0) report();
    }, 250);
    report();
  }

  function cancel() {
    rec.state = 'idle';
    stopPlayback();
    rec.tracks.clear();
    rec.bytes = 0;
    report();
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  }

  function saveAudioOnly(name) {
    const t = usedTracks().find((x) => x.kind === 'audio');
    if (!t) return;
    const r = t.best();
    const times = [...r.frags.keys()].sort((a, b) => a - b);
    download(new Blob([r.init, ...times.map((k) => r.frags.get(k))], { type: t.mime.split(';')[0] }), name || `youtube-audio.${t.ext}`);
  }

  async function save(names) {
    const list = usedTracks()
      .sort((a, b) => (a.kind === 'video' ? -1 : 1) - (b.kind === 'video' ? -1 : 1));
    rec.merged = false;
    if (list.length === 2 && list[0].kind === 'video' && list[1].kind === 'audio') {
      // VP9 + AAC / AV1 + Opus: MP4 unless the name the background chose ends in .mkv (setting "joinFormat")
      const blob = await mergeReps(list[0], list[1], { trimSilent: !!rec.live, mkv: /\.mkv$/i.test((names && names[0]) || '') });
      if (blob) {
        download(blob, (names && names[0]) || `youtube.${list[0].container}`);
        rec.merged = true;
      }
    }
    if (!rec.merged) {
      list.forEach((t, i) => {
        setTimeout(() => {
          const r = t.best();
          const times = [...r.frags.keys()].sort((a, b) => a - b);
          const blob = new Blob([r.init, ...times.map((k) => r.frags.get(k))], { type: t.mime.split(';')[0] });
          download(blob, ((names && names[i]) || `youtube-${i + 1}.${t.ext}`).replace(/\.(?:mkv|mp4)$/, `.${t.ext}`));
        }, i * 900);
      });
    }
    rec.state = 'saved';
    report();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__vdl !== 'rec-cmd') return;
    if (e.data.cmd === 'start') start({ speed: 1, maxMB: e.data.maxMB, live: !!e.data.live, maxMin: e.data.maxMin, noReload: true });
    else if (e.data.cmd === 'save' && e.data.only === 'audio') saveAudioOnly(e.data.names && e.data.names[0]);
    else if (e.data.cmd === 'save') save(e.data.names).catch(() => fail('save'));
    else if (e.data.cmd === 'stopsave') {
      (async () => {
        if (rec.state === 'recording') {
          // audio and video are buffered different distances ahead: keep recording (at most 25 s) until both have caught up
          rec.draining = true;
          report();
          const t0 = Date.now();
          const ends = () => [...rec.tracks.keys()].map((sb) => { try { return sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0; } catch { return 0; } });
          while (rec.state === 'recording' && Date.now() - t0 < 25000) {
            const en = ends();
            if (en.length < 2 || Math.max(...en) - Math.min(...en) < 0.8) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          rec.draining = false;
        }
        if (rec.state === 'recording') finish('end');
        await save(e.data.names);
      })().catch(() => fail('save'));
    }
    else if (e.data.cmd === 'cancel') cancel();
  });

  // Armed before the reload? Start from the very first segment.
  try {
    const armed = JSON.parse(sessionStorage.getItem('vdlRec') || 'null');
    if (armed && Date.now() - armed.at < 120000) start(armed);
  } catch { /* ignore */ }
})();
