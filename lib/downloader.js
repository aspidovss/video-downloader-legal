// Segment downloader for HLS / DASH. Pure fetch + Blob, no browser-extension APIs,
// so it can be tested in Node with a mocked fetch.

import { parsePlaylist, decryptSegment } from './hls.js';

export class StreamError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // 'drm' | 'live' | 'aborted' | 'toolarge' | 'http' | 'empty'
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new StreamError('aborted'));
    }, { once: true });
  });
}

async function fetchBuffer(url, { range, signal, fetchFn, retries = 3, credentials = 'include' }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new StreamError('aborted');
    try {
      const headers = {};
      if (range) headers.Range = `bytes=${range.start}-${range.end}`;
      const res = await fetchFn(url, { credentials, headers, signal });
      if (!res.ok) { const err = new StreamError('http', `HTTP ${res.status}`); err.status = res.status; throw err; }
      return await res.arrayBuffer();
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') throw new StreamError('aborted');
      lastErr = e;
      if (e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) break; // definitive: do not hammer the server
      if (attempt < retries) await sleep(500 * (attempt + 1), signal);
    }
  }
  throw lastErr;
}

// parts: [{ url, range?, key?, seq? }] -> Blob[] in the same order.
export async function downloadParts(parts, opts = {}) {
  const {
    concurrency = 4,
    signal,
    onProgress,
    fetchFn = globalThis.fetch.bind(globalThis),
    cryptoApi = globalThis.crypto,
    maxBytes = Infinity,
    credentials = 'include',
  } = opts;

  if (!parts.length) throw new StreamError('empty', 'No segments found');
  const results = new Array(parts.length);
  const keyCache = new Map();
  let next = 0;
  let done = 0;
  let bytes = 0;
  let failure = null;

  async function getKey(uri) {
    if (!keyCache.has(uri)) {
      keyCache.set(uri, fetchBuffer(uri, { signal, fetchFn, credentials }).then((b) => new Uint8Array(b)));
    }
    return keyCache.get(uri);
  }

  async function worker() {
    while (!failure) {
      const i = next++;
      if (i >= parts.length) return;
      const p = parts[i];
      try {
        let buf = await fetchBuffer(p.url, { range: p.range, signal, fetchFn, credentials });
        if (p.key) {
          buf = await decryptSegment(cryptoApi, await getKey(p.key.uri), p.key, p.seq ?? i, buf);
        }
        bytes += buf.byteLength;
        if (bytes > maxBytes) throw new StreamError('toolarge', 'Stream exceeds the configured size limit');
        results[i] = new Blob([buf]);
        done++;
        onProgress?.({ done, total: parts.length, bytes });
      } catch (e) {
        failure = failure || e;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, parts.length) }, worker));
  if (failure) throw failure;
  return results;
}

// ---- HLS -------------------------------------------------------------------

export async function fetchText(url, { fetchFn = globalThis.fetch.bind(globalThis), signal } = {}) {
  const res = await fetchFn(url, { credentials: 'include', signal });
  if (!res.ok) throw new StreamError('http', `HTTP ${res.status}`);
  return res.text();
}

export async function hlsParts(mediaPlaylistUrl, opts = {}) {
  const text = await fetchText(mediaPlaylistUrl, opts);
  const pl = parsePlaylist(text, mediaPlaylistUrl);
  if (pl.type === 'master') throw new StreamError('empty', 'Master playlist passed where a media playlist is required');
  if (pl.protected) throw new StreamError('drm', 'Stream is DRM-protected');
  if (pl.live) throw new StreamError('live', 'Live streams are not supported');

  const parts = [];
  let lastMap = null;
  for (const seg of pl.segments) {
    if (seg.map && (!lastMap || lastMap.url !== seg.map.url)) {
      parts.push({ url: seg.map.url, range: seg.map.range });
      lastMap = seg.map;
    }
    parts.push({ url: seg.url, range: seg.range, key: seg.key, seq: seg.seq });
  }
  return { parts, ext: pl.hasMap ? 'mp4' : 'ts', duration: pl.duration };
}

// ---- DASH ------------------------------------------------------------------

export function dashParts(rep) {
  const parts = [];
  if (rep.initUrl) parts.push({ url: rep.initUrl });
  for (const s of rep.segments) parts.push({ url: s.url, range: s.range });
  const isAudio = rep.mime.startsWith('audio/');
  const webm = rep.mime.includes('webm');
  const ext = isAudio ? (webm ? 'weba' : 'm4a') : webm ? 'webm' : 'mp4';
  return { parts, ext };
}

export function joinBlobs(blobs, type) {
  return new Blob(blobs, { type });
}
