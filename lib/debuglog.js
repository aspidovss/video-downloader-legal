// Debug log (opt-in): pure helpers, no browser APIs (unit-tested in Node).
// Entries are { t: ms, g: tag, m: text }. Links are always shortened (host + path + parameter names)
// unless "Diagnostics: include full links" is on; titles, cookies and ids are never written by the callers.
import { maskUrl } from './sitediag.js';

export const LOG_KEY = 'debugLog';
export const LOG_MAX_ENTRIES = 1500;
export const LOG_MAX_CHARS = 250000;

export function scrub(text, full = false) {
  return String(text).replace(/https?:\/\/[^\s"'<>)\]\\]+/gi, (u) => maskUrl(u, full) || '(link)');
}

export function makeEntry(tag, msg, data, full = false, now = Date.now()) {
  let m = String(msg ?? '');
  if (data !== undefined) {
    let d;
    try { d = typeof data === 'string' ? data : JSON.stringify(data); } catch { d = String(data); }
    m = `${m} ${d}`;
  }
  return { t: now, g: String(tag).slice(0, 24), m: scrub(m, full).slice(0, 600) };
}

// Keeps the newest entries within the count and size limits.
export function trimLog(list, maxEntries = LOG_MAX_ENTRIES, maxChars = LOG_MAX_CHARS) {
  let out = list.length > maxEntries ? list.slice(-maxEntries) : list;
  let chars = 0;
  let from = out.length;
  while (from > 0 && chars + out[from - 1].m.length + 40 <= maxChars) { from--; chars += out[from].m.length + 40; }
  if (from > 0) out = out.slice(from);
  return out;
}

export function formatLine(e) {
  return `${new Date(e.t).toISOString().replace('T', ' ').replace('Z', '')} [${e.g}] ${e.m}`;
}

export function formatLog(list, header = []) {
  return [...header, ...(header.length ? [''] : []), ...list.map(formatLine)].join('\n');
}

// Auto-diagnostics report (the JSON text of the bug button) as log lines: one group per top-level key,
// the format list as one compact line per format, everything else as JSON, long groups cut into parts.
export function diagLines(text, chunk = 500) {
  let rep;
  try { rep = JSON.parse(text); } catch { return [['test', String(text).slice(0, chunk)]]; }
  const out = [];
  for (const [k, v] of Object.entries(rep)) {
    if (['extension', 'userAgent', 'time', 'summaryHash'].includes(k)) continue;
    let s;
    if (k === 'formatList' && Array.isArray(v)) s = v.map((f) => `${f.itag} ${f.label || '-'} ${f.mime} ${f.codecs || '-'} ${f.bitrate || 0}bps ${f.mode}${f.nParam ? ' n' : ''}${f.hasLength ? ' len' : ''}${f.drm ? ' DRM' : ''}`).join('; ');
    else s = JSON.stringify(v);
    if (s === undefined) continue;
    const n = Math.max(1, Math.ceil(s.length / chunk));
    for (let i = 0; i < n; i++) out.push(['test', `${k}${n > 1 ? ` (${i + 1}/${n})` : ''}: ${s.slice(i * chunk, (i + 1) * chunk)}`]);
  }
  return out;
}
