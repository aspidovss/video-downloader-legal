// YouTube support WITHOUT any decryption or third-party library.
//
// Two sources of downloadable streams:
//  1. Formats in the player response that already carry a plain `url`
//     (reported by injected/youtube_main.js).
//  2. Streams the page's own player requested from googlevideo.com. Those URLs are
//     already valid, so we only have to re-fetch them in ranged chunks.
//
// Formats that need `signatureCipher` decryption, SABR-only streams and DRM are
// reported as "unsupported" and never downloaded. Nothing here bypasses protection.

import { hashId } from './util.js';
import { validateTracks } from './subs.js';

export const CHUNK_BYTES = 5 * 1024 * 1024;

// ---- googlevideo request parsing -------------------------------------------

const DROP_PARAMS = ['range', 'rn', 'rbuf'];

export function parseGooglevideoUrl(rawUrl, method = 'GET') {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (!/(^|\.)googlevideo\.com$/.test(u.hostname) || u.pathname !== '/videoplayback') return null;
  const p = u.searchParams;
  const sabr = p.get('sabr') === '1' || String(method).toUpperCase() === 'POST';
  const mime = (p.get('mime') || '').toLowerCase();
  const kind = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : '';
  const clean = new URL(u.href);
  for (const k of DROP_PARAMS) clean.searchParams.delete(k);
  return {
    itag: p.get('itag') || '',
    mime, kind, sabr,
    len: Number(p.get('clen')) || 0,
    dur: parseFloat(p.get('dur')) || 0,
    expire: Number(p.get('expire')) || 0,
    url: clean.href,
  };
}

// ---- summary (from the page) -> variants ------------------------------------

export function validateSummary(s) {
  if (!s || typeof s !== 'object' || typeof s.videoId !== 'string' || !/^[\w-]{6,20}$/.test(s.videoId)) return null;
  return {
    videoId: s.videoId,
    title: String(s.title || '').slice(0, 300),
    author: String(s.author || '').slice(0, 120),
    lengthSeconds: Number(s.lengthSeconds) || 0,
    thumbnail: typeof s.thumbnail === 'string' ? s.thumbnail : '',
    isLive: !!s.isLive,
    status: String(s.status || ''),
    reason: String(s.reason || '').slice(0, 200),
    subreason: String(s.subreason || '').slice(0, 200),
    upcoming: !!s.upcoming,
    startAt: Number(s.startAt) > 0 ? Number(s.startAt) : 0,
    familySafe: s.familySafe !== false,
    paid: !!s.paid,
    captions: validateTracks(s.captions),
    sabr: !!s.sabr,
    hls: typeof s.hls === 'string' && /^https:\/\/[\w.-]+\.(?:googlevideo|youtube)\.com\//.test(s.hls) ? s.hls.slice(0, 4000) : '',
    license: s.license === 'cc' || s.license === 'standard' ? s.license : 'unknown',
    pageType: String(s.pageType || '').slice(0, 20),
    visitorData: typeof s.visitorData === 'string' && /^[\w%=.-]{0,300}$/.test(s.visitorData) ? s.visitorData : '',
    formats: (Array.isArray(s.formats) ? s.formats : []).slice(0, 120).map((f) => ({
      itag: Number(f.itag) || 0,
      mime: String(f.mime || ''),
      label: String(f.label || ''),
      w: Number(f.w) || 0,
      h: Number(f.h) || 0,
      fps: Number(f.fps) || 0,
      bitrate: Number(f.bitrate) || 0,
      clen: Number(f.clen) || 0,
      audio: !!f.audio,
      adaptive: !!f.adaptive,
      mode: f.mode === 'direct' || f.mode === 'cipher' ? f.mode : 'none',
      drm: !!f.drm,
      n: !!f.n,
      url: f.mode === 'direct' && typeof f.url === 'string' && /^https:\/\//.test(f.url) ? f.url : '',
    })),
  };
}

const mimeBase = (m) => (m || '').split(';')[0].trim().toLowerCase();

export function trackExt(mime) {
  const m = mimeBase(mime);
  return { 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/webm': 'weba' }[m] || (m.startsWith('audio/') ? 'm4a' : 'mp4');
}

const containerOf = (mime) => (mimeBase(mime).endsWith('/webm') ? 'webm' : 'mp4');

const ITAG_HEIGHT = {
  18: 360, 22: 720, 133: 240, 134: 360, 135: 480, 136: 720, 137: 1080, 160: 144, 264: 1440, 266: 2160, 298: 720, 299: 1080,
  242: 240, 243: 360, 244: 480, 247: 720, 248: 1080, 271: 1440, 313: 2160, 302: 720, 303: 1080, 308: 1440, 315: 2160,
  394: 144, 395: 240, 396: 360, 397: 480, 398: 720, 399: 1080, 400: 1440, 401: 2160,
};

// "Type" of a video stream for the picker: container + codec family.
export function videoType(f) {
  const mime = String(f.mime || '').toLowerCase();
  const container = mime.startsWith('video/webm') ? 'webm' : 'mp4';
  if (/av01|av1/.test(mime)) return { key: 'mp4-av1', short: container === 'webm' ? 'WEBM AV1' : 'MP4 AV1', codec: 'AV1', container };
  if (/vp9|vp09|vp8/.test(mime) || container === 'webm') return { key: 'webm', short: 'WEBM', codec: 'VP9', container };
  return { key: 'mp4', short: 'MP4', codec: 'H.264', container };
}

function heightLabel(f) {
  if (f.label) return f.label;
  const h = f.h || ITAG_HEIGHT[f.itag] || 0;
  return h ? `${h}p` : '';
}

export function classifyFormats(summary) {
  const total = summary.formats.length;
  const direct = summary.formats.filter((f) => f.mode === 'direct' && f.url && !f.drm);
  return {
    total,
    direct: direct.length,
    cipher: summary.formats.filter((f) => f.mode === 'cipher').length,
    none: summary.formats.filter((f) => f.mode === 'none').length,
    drm: summary.formats.filter((f) => f.drm).length,
    unsupported: total - direct.length,
  };
}

function track(f, role) {
  return { itag: f.itag, url: f.url, len: f.clen || 0, mime: mimeBase(f.mime), role, verified: !!f.verified, client: f.client || '' };
}

function bestAudio(pool, container) {
  const same = pool.filter((a) => containerOf(a.mime) === container);
  const list = (same.length ? same : pool).slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return list[0] || null;
}

// A captured stream is one the page's own player fetched. `summary` may know its metadata.
function capturedToFormat(cap, summary) {
  const known = summary?.formats.find((f) => String(f.itag) === String(cap.itag));
  return {
    itag: Number(cap.itag) || 0,
    mime: cap.mime,
    label: known?.label || '',
    h: known?.h || ITAG_HEIGHT[cap.itag] || 0,
    fps: known?.fps || 0,
    bitrate: known?.bitrate || 0,
    clen: cap.len || known?.clen || 0,
    audio: cap.kind === 'audio',
    adaptive: true,
    url: cap.url,
    verified: true,
  };
}

export function capturedMatches(summary, cap) {
  // Guard against streams that belong to another video (prefetch, ads).
  if (!summary || !summary.lengthSeconds || !cap.dur) return true;
  return Math.abs(cap.dur - summary.lengthSeconds) <= 3;
}

export function buildVariants(summary, captured = [], apiFormats = []) {
  if (!summary) return [];
  const byItag = new Map();
  for (const f of summary.formats) {
    if (f.mode === 'direct' && f.url && !f.drm) byItag.set(f.itag, { ...f, verified: false });
  }
  for (const f of apiFormats) {
    if (f.mode === 'direct' && f.url && !f.drm) byItag.set(f.itag, { ...f, verified: true }); // mobile-client URLs replace the page's copies
  }
  for (const cap of captured) {
    if (!cap.kind || !capturedMatches(summary, cap)) continue;
    const f = capturedToFormat(cap, summary);
    if (f.itag) byItag.set(f.itag, f); // verified URL wins over the page's copy
  }

  const all = [...byItag.values()];
  const isVideo = (f) => mimeBase(f.mime).startsWith('video/');
  const audioPool = all.filter((f) => mimeBase(f.mime).startsWith('audio/'));

  const sizeOf = (tracks) => (tracks.every((x) => x.len > 0) ? tracks.reduce((n, x) => n + x.len, 0) : 0);
  const mk = (label, f, muxed, container, tracks) => {
    const vt = videoType(f);
    return { label, height: f.h || ITAG_HEIGHT[f.itag] || 0, muxed, container, tracks, size: sizeOf(tracks), type: vt.key, typeLabel: vt.short, codec: vt.codec };
  };
  const variants = [];
  for (const f of all.filter(isVideo)) {
    const q = heightLabel(f) || `itag ${f.itag}`;
    const container = containerOf(f.mime);
    const tag = videoType(f).short;
    if (!f.adaptive) {
      variants.push(mk(`${q} · ${tag}`, f, true, container, [track(f, 'muxed')]));
    } else {
      const a = bestAudio(audioPool, container);
      if (a) variants.push(mk(`${q} · ${tag}`, f, false, container, [track(f, 'video'), track(a, 'audio')]));
      else variants.push(mk(`${q} · ${tag} · no audio`, f, false, container, [track(f, 'video')]));
    }
  }

  // Highest quality first; one-file variants before multi-file at equal height.
  variants.sort((x, y) => (y.height - x.height) || (Number(y.muxed) - Number(x.muxed)));
  const seen = new Set();
  const video = variants.filter((v) => !seen.has(v.label) && seen.add(v.label)).slice(0, 40);

  // Audio-only variants (best track per container, no re-encoding), kept apart from the video list.
  // Every distinct track (container + bitrate) is offered, best first.
  const audio = [];
  for (const container of ['mp4', 'webm']) {
    const seenKbps = new Set();
    const pool = audioPool.filter((x) => containerOf(x.mime) === container).sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0));
    for (const a of pool) {
      const kbps = Math.round((a.bitrate || 0) / 1000);
      if (seenKbps.has(kbps)) continue;
      seenKbps.add(kbps);
      const tr = track(a, 'audio');
      const name = container === 'webm' ? 'WEBM' : 'M4A';
      audio.push({
        label: kbps ? `Audio · ${name} ${kbps} kbps` : `Audio · ${name}`, height: 0, muxed: false, container, audio: true,
        atype: container === 'webm' ? 'webm' : 'm4a', kbps, bitrate: a.bitrate || 0, tracks: [tr], size: tr.len || 0,
      });
    }
  }
  return [...video, ...audio];
}

// ---- picker helpers (used by the popup) --------------------------------------

const TYPE_ORDER = ['mp4', 'mp4-av1', 'hevc', 'webm', 'mkv', 'ts'];

// -> [{ type, label, items: [variant...] }] in a stable order (H.264 first); items keep their `index`.
export function groupByType(variants) {
  const groups = new Map();
  for (const v of variants) {
    const k = v.type || 'mp4';
    if (!groups.has(k)) groups.set(k, { type: k, label: v.typeLabel || k.toUpperCase(), codec: v.codec || '', items: [] });
    groups.get(k).items.push(v);
  }
  const rank = (k) => (TYPE_ORDER.includes(k) ? TYPE_ORDER.indexOf(k) : 99);
  return [...groups.values()].sort((a, b) => rank(a.type) - rank(b.type)).map((g) => ({ ...g, items: g.items.slice().sort((x, y) => (y.height - x.height) || (Number(y.muxed) - Number(x.muxed))) }));
}

// target: 'best' | '1080' | '720' | '480'. Highest height not above the target; if everything is above, the lowest.
export function pickQuality(items, target = 'best') {
  if (!items.length) return null;
  const sorted = items.slice().sort((x, y) => y.height - x.height);
  if (target === 'best') return sorted[0];
  const limit = Number(target) || Infinity;
  return sorted.find((v) => v.height <= limit) || sorted[sorted.length - 1];
}

export const MP3_KBPS = [128, 192, 256, 320];
export const MP3_BEST_KBPS = 256; // "highest" for MP3: above ~256 kbps the source (<= ~250 kbps) gains nothing

// Order of the audio formats in the picker.
export function groupAudio(variants) {
  const names = { mp3: 'MP3', m4a: 'M4A', webm: 'WEBM' };
  const groups = [];
  for (const k of ['mp3', 'm4a', 'webm']) {
    const items = variants.filter((v) => (v.mp3 ? 'mp3' : v.atype) === k).sort((x, y) => (y.kbps || 0) - (x.kbps || 0));
    if (items.length) groups.push({ type: k, label: names[k], items });
  }
  return groups;
}

// pref: 'best' | '192' | '128'. Highest bitrate not above the limit (MP3 "best" = 256); if all are above, the lowest.
export function pickAudioQuality(items, pref = 'best', mp3 = false) {
  if (!items.length) return null;
  const sorted = items.slice().sort((x, y) => (y.kbps || 0) - (x.kbps || 0));
  const limit = pref === 'best' ? (mp3 ? MP3_BEST_KBPS : Infinity) : Number(pref) || Infinity;
  return sorted.find((v) => (v.kbps || 0) <= limit) || sorted[sorted.length - 1];
}

// Video type: explicit preference when present, otherwise the type whose pick has the highest resolution (ties: H.264 first).
export function pickType(groups, pref = 'auto', quality = 'best') {
  if (!groups.length) return null;
  const exact = pref !== 'auto' ? groups.find((g) => g.type === pref) : null;
  if (exact) return exact;
  let best = groups[0];
  let bestH = -1;
  for (const g of groups) {
    const h = pickQuality(g.items, quality)?.height || 0;
    if (h > bestH) { best = g; bestH = h; }
  }
  return best;
}

// ---- download helpers --------------------------------------------------------

export function rangedParts(tr, chunk = CHUNK_BYTES) {
  if (!tr.len) return [{ url: tr.url }]; // size unknown: single plain GET
  const parts = [];
  for (let start = 0; start < tr.len; start += chunk) {
    const end = Math.min(start + chunk, tr.len) - 1;
    const u = new URL(tr.url);
    u.searchParams.set('range', `${start}-${end}`);
    parts.push({ url: u.href });
  }
  return parts;
}

// ---- state / diagnostics ------------------------------------------------------

export function newDiag() {
  return { get: 0, post: 0, sabr: 0, itags: [], rejected: 0 };
}

export function recordRequest(diag, parsed, method) {
  if (String(method).toUpperCase() === 'POST') diag.post++; else diag.get++;
  if (parsed.sabr) diag.sabr++;
  if (parsed.itag && !diag.itags.includes(parsed.itag)) diag.itags.push(parsed.itag);
}

// Report contains NO URLs, video ids, titles or account data.
export function buildDiagnostics(summary, diag, meta = {}, captured = []) {
  const base = { extension: meta.version || '', userAgent: meta.userAgent || '', time: new Date().toISOString() };
  if (!summary) return { ...base, summary: null, googlevideo: diag || null, note: 'No player response was received from the page.' };
  const c = classifyFormats(summary);
  return {
    ...base,
    page: summary.pageType,
    playability: summary.status,
    live: summary.isLive,
    hlsManifestPresent: !!summary.hls,
    subtitleTracks: (summary.captions?.tracks || []).length,
    ...(meta.liveItem ? { liveItem: meta.liveItem } : {}),
    ...(meta.rec ? { recorder: meta.rec } : {}),
    ...(meta.liveJobs && meta.liveJobs.length ? { liveJobs: meta.liveJobs } : {}),
    license: summary.license,
    sabrStreamingUrlPresent: summary.sabr,
    formats: c,
    formatList: summary.formats.map((f) => ({
      itag: f.itag, mime: f.mime.split(';')[0], codecs: (/codecs="([^"]+)"/.exec(f.mime) || [])[1] || '', label: f.label, bitrate: f.bitrate,
      mode: f.mode, nParam: f.n, hasLength: !!f.clen, drm: f.drm,
    })),
    googlevideo: diag || null,
    download: meta.download || null,
    test: meta.test || null,
    variantsBuilt: buildVariants(summary, captured, meta.apiFormats || []).length,
    api: meta.api || null,
    apiPage: meta.apiPage || null,
    summaryHash: hashId(JSON.stringify(summary.formats.map((f) => [f.itag, f.mode]))),
  };
}
