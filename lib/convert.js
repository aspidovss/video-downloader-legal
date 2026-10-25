// The converter page (1.6.6): pure helpers, no extension APIs (tested in Node).
// A file the user picks is looked at by its first bytes; the page then offers what can be made of it:
// GIF, MP3, a PNG frame, and for a TS stream MP4 / MKV, for a fragmented MP4 a plain MP4.
import { sanitizeFilename } from './util.js';

export const CONVERT_TARGETS = ['gif', 'mp3', 'png', 'mp4', 'mkv', 'defrag'];

const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const fourcc = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

// first bytes (a few KB) + file name -> 'ts' | 'mp4' | 'webm' | 'audio' | 'other'
export function sniffKind(head, name = '', mime = '') {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  if (b.length >= 189 && b[0] === 0x47 && b[188] === 0x47) return 'ts';
  if (b.length >= 12 && /^(ftyp|styp|moov|moof|free|mdat)$/.test(fourcc(b, 4))) return 'mp4';
  if (b.length >= 4 && u32(b, 0) === 0x1a45dfa3) return 'webm'; // Matroska / WebM
  if (b.length >= 3 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return 'audio'; // MP3
  if (b.length >= 4 && /^(OggS|fLaC|RIFF)$/.test(fourcc(b, 0))) return 'audio';
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(name) || [])[1]?.toLowerCase() || '';
  if (ext === 'ts') return 'ts';
  if (['mp4', 'm4v', 'mov', 'm4a'].includes(ext)) return 'mp4';
  if (['webm', 'mkv'].includes(ext)) return 'webm';
  if (/^audio\//.test(mime) || ['mp3', 'aac', 'ogg', 'opus', 'oga', 'wav', 'flac'].includes(ext)) return 'audio';
  return 'other';
}

// top-level MP4 boxes from a reader (start, end) -> Promise<Uint8Array>; stops after `limit` boxes
export async function mp4TopBoxes(size, read, limit = 4000) {
  const out = [];
  let pos = 0;
  while (pos + 8 <= size && out.length < limit) {
    const h = await read(pos, Math.min(size, pos + 16));
    if (h.length < 8) break;
    let len = u32(h, 0);
    const type = fourcc(h, 4);
    if (len === 1 && h.length >= 16) len = u32(h, 8) * 4294967296 + u32(h, 12);
    else if (len === 0) len = size - pos;
    if (len < 8 || !/^[\x20-\x7e]{4}$/.test(type)) break;
    out.push({ type, start: pos, size: len });
    pos += len;
  }
  return out;
}

export const isFragmented = (boxes) => boxes.some((x) => x.type === 'moof') && boxes.some((x) => x.type === 'moov');

// what the page offers for a file
export function convertTargets(kind, { video = true, audio = true, fragmented = false } = {}) {
  const out = [];
  if (kind === 'other') return out;
  if (video && kind !== 'audio') out.push('gif');
  if (audio) out.push('mp3');
  if (video && kind !== 'audio') out.push('png');
  if (kind === 'ts') out.push('mp4', 'mkv');
  if (kind === 'mp4' && fragmented) out.push('defrag');
  return out;
}

export const targetExt = (target) => ({ gif: 'gif', mp3: 'mp3', png: 'png', mp4: 'mp4', mkv: 'mkv', defrag: 'mp4' })[target] || 'bin';
export const targetTrims = (target) => target === 'gif' || target === 'mp3';

// "75", "1:15", "01:01:15", "1:15.5", "12,5" -> seconds; '' -> null; anything else -> NaN
export function parseTime(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (!s) return null;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(s)) return NaN;
  return s.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

// seconds -> "1:15.5" / "1:01:15"
export function formatTime(sec) {
  if (!(sec >= 0) || !isFinite(sec)) return '0:00';
  const tenths = Math.round(sec * 10);
  const whole = Math.floor(tenths / 10), frac = tenths % 10;
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  const ss = String(s).padStart(2, '0') + (frac ? `.${frac}` : '');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// start / end typed by the user -> { start, end, length } within the file, or { error: 'convBadTime' | 'convBadRange' }
export function trimRange(startText, endText, duration) {
  const a = parseTime(startText), b = parseTime(endText);
  if (Number.isNaN(a) || Number.isNaN(b)) return { error: 'convBadTime' };
  const d = duration > 0 && isFinite(duration) ? duration : 0;
  const start = Math.min(a ?? 0, d);
  const end = b == null ? d : Math.min(b, d);
  if (!(end - start >= 0.1)) return { error: 'convBadRange' };
  return { start, end, length: end - start, whole: start <= 0.05 && end >= d - 0.05 };
}

// the sample range of decoded PCM for start..end seconds
export function pcmSlice(pcm, start, end) {
  const rate = pcm.sampleRate;
  const total = pcm.channels[0]?.length || 0;
  const from = Math.max(0, Math.min(total, Math.floor(start * rate)));
  const to = Math.max(from, Math.min(total, Math.ceil(end * rate)));
  if (from === 0 && to === total) return pcm;
  return { sampleRate: rate, channels: pcm.channels.map((c) => c.subarray(from, to)), seconds: (to - from) / rate };
}

// "clip.mp4" + gif -> "clip.gif"; a trimmed GIF / MP3 gets " 0-12s"; a PNG gets " 1m05s"
export function outName(name, target, { start, end, whole, at } = {}) {
  const stem = String(name || 'video').replace(/\.[a-z0-9]{1,5}$/i, '') || 'video';
  const sec = (x) => { const r = Math.round(x * 10) / 10; return r >= 60 ? `${Math.floor(r / 60)}m${String(Math.round((r % 60) * 10) / 10).padStart(2, '0')}s` : `${r}s`; };
  let suffix = '';
  if (target === 'png' && at >= 0) suffix = ` ${sec(at)}`;
  else if (targetTrims(target) && whole === false && end > start) suffix = ` ${sec(start)}-${sec(end)}`;
  else if (target === 'defrag') suffix = ' (fixed)';
  return `${sanitizeFilename(stem + suffix, 180)}.${targetExt(target)}`;
}

// rough GIF size, the same rule as the popup's (0.25 byte per pixel and frame)
export function gifEstimateBytes(width, aspect, seconds, fps) {
  if (!(seconds > 0) || !(aspect > 0)) return 0;
  return Math.round(width * Math.round(width / aspect) * seconds * fps * 0.25);
}
