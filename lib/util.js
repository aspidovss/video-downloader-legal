// Small shared helpers (no browser APIs here, so it can be unit-tested in Node).

export const FILE_EXTS = ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'flv', 'ogv', 'mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac'];
export const SKIP_EXTS = ['ts', 'm4s', 'cmfv', 'cmfa', 'vtt', 'srt', 'key', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'js', 'css', 'json', 'html', 'woff', 'woff2'];

export function resolveUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// Extension of a media file named in the address: the path when it is a media type, else a query value
// ("remote_control.php?file=….mp4", "get.php?v=clip.webm"); '' when there is none.
export function mediaExt(url) {
  const p = urlExt(url);
  if (FILE_EXTS.includes(p)) return p;
  try {
    for (const v of new URL(url).searchParams.values()) {
      const m = /\.([a-z0-9]{2,4})$/i.exec(v);
      if (m && FILE_EXTS.includes(m[1].toLowerCase())) return m[1].toLowerCase();
    }
  } catch { /* not an address */ }
  return '';
}

export function urlExt(url) {
  try {
    const p = new URL(url).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(p);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

// Strips range-like query params so repeated partial requests of one file collapse into one entry.
// _HLS_*: Low-Latency HLS asks for the same playlist again and again with the next segment / part number
const NOISE_PARAMS = ['range', 'bytes', 'bytestart', 'byteend', 'rn', 'rbuf', 'start', 'end', 'cmsid_', '_hls_msn', '_hls_part', '_hls_skip', '_hls_push'];
const LLHLS_PARAMS = /^_hls_(msn|part|skip|push)$/i;
// The playlist address without the LL-HLS request parameters (a blocking request for an old part is of no use later)
export function stripLlHls(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) if (LLHLS_PARAMS.test(key)) { u.searchParams.delete(key); changed = true; }
    return changed ? u.href : url;
  } catch {
    return url;
  }
}
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (NOISE_PARAMS.includes(key.toLowerCase())) u.searchParams.delete(key);
    }
    return u.href;
  } catch {
    return url;
  }
}

export function hashId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
};

export function mimeToExt(mime) {
  return MIME_EXT[(mime || '').split(';')[0].trim().toLowerCase()] || '';
}

const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilename(name, max = 150) {
  let s = String(name ?? '').replace(BAD_CHARS, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (s.length > max) s = s.slice(0, max).trim();
  if (!s || RESERVED.test(s)) s = `video_${s || 'file'}`;
  return s;
}

// The site part of a host name for header rules: "hv-h.phncdn.com" -> "phncdn.com", "a.b.co.uk" -> "b.co.uk"
export function refDomain(url) {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase(); } catch { return ''; }
  if (!h || /^[\d.]+$/.test(h) || h.includes(':')) return h;
  const p = h.split('.');
  const n = p.length >= 3 && p[p.length - 2].length <= 3 && p[p.length - 1].length === 2 ? 3 : 2; // co.uk, com.br ...
  return p.slice(-n).join('.');
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Template tokens: {title} {site} {quality} {date} {time} {ext}
export function buildFilename(template, { title, site, quality, ext, date = new Date(), suffix = '' }) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const tpl = template && template.includes('{title}') ? template : '{title}';
  const map = {
    title: sanitizeFilename(title || 'video'),
    // a page without a title is named after its site: the site is not written twice
    site: site && sanitizeFilename(site) === sanitizeFilename(title || 'video') ? '' : sanitizeFilename(site || 'web'),
    quality: sanitizeFilename(quality || ''),
    date: d,
    time: t,
    ext: ext || 'mp4',
  };
  let base = tpl.replace(/\{(\w+)\}/g, (_, k) => (k in map ? map[k] : ''));
  base = base.replace(/\.\{?ext\}?$/, '');
  base = sanitizeFilename(base.replace(/\s{2,}/g, ' ').replace(/[ _-]+$/g, '').replace(/\(\s*\)/g, ''), 180);
  return `${base}${suffix}.${map.ext}`;
}

export function formatBytes(n) {
  if (!n || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function qualityLabel({ width, height, bandwidth }) {
  if (height) return `${height}p`;
  if (width) return `${width}w`;
  if (bandwidth) return `${Math.round(bandwidth / 1000)} kbps`;
  return '';
}
