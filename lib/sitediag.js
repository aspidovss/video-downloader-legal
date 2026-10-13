// Helpers for the "bug" diagnostics on non-YouTube sites. Pure functions, no browser APIs.

// Host + path (long path parts shortened) + query PARAMETER NAMES only. Full URLs only when asked.
export function maskUrl(u, full = false) {
  if (String(u).startsWith('data:')) return `data:(inline, ${String(u).length} chars)`;
  try {
    const x = new URL(u);
    if (full) return x.href;
    const path = x.pathname.split('/').map((p) => (p.length > 24 ? `${p.slice(0, 8)}…${p.slice(-4)}` : p)).join('/');
    const keys = [...x.searchParams.keys()];
    return `${x.protocol}//${x.hostname}${path.slice(0, 140)}${keys.length ? ` ?${keys.slice(0, 12).join('&')}` : ''}`;
  } catch { return ''; }
}

// Codec family of a DASH/HLS representation, e.g. { key: 'mp4', short: 'MP4', codec: 'H.264' }.
export function repType(mime = '', codecs = '') {
  const m = `${mime} ${codecs}`.toLowerCase();
  const webm = /webm/.test(m);
  if (/av01|\bav1\b/.test(m)) return { key: 'mp4-av1', short: webm ? 'WEBM AV1' : 'MP4 AV1', codec: 'AV1' };
  if (/hvc1|hev1|hevc|h265/.test(m)) return { key: 'hevc', short: 'MP4 HEVC', codec: 'HEVC' };
  if (/vp9|vp09|vp8|vp08/.test(m) || webm) return { key: 'webm', short: 'WEBM', codec: 'VP9' };
  return { key: 'mp4', short: 'MP4', codec: 'H.264' };
}

// Estimated size of a stream: bandwidth (bits/s) x duration.
export function estimateSize(bandwidth, seconds) {
  const b = Number(bandwidth) || 0;
  const s = Number(seconds) || 0;
  return b > 0 && s > 0 ? Math.round(b * s / 8) : 0;
}

export function probeInfo(res) {
  const h = (n) => (res.headers && res.headers.get ? res.headers.get(n) || '' : '');
  return { status: res.status, ct: h('content-type').split(';')[0], len: h('content-length'), range: h('content-range'), acceptRanges: h('accept-ranges') };
}
