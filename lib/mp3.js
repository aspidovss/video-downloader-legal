// "Audio only -> MP3": decode the downloaded audio track (AAC/Opus) with the browser's own decoder,
// then encode it with an MP3 encoder (lamejs, shipped as vendor/lame.min.js, LGPL-3.0, unmodified).
// Pure functions, no browser-extension APIs, so they can be tested in Node with fakes.

export const MP3_MAX_SECONDS = 30 * 60; // decoded stereo float32 PCM is ~0.35 MB per second
export const MP3_BITRATES = [128, 192, 256, 320];

export function mp3Bitrate(v) {
  const n = Number(v);
  return MP3_BITRATES.includes(n) ? n : 192;
}

// Estimated size of the finished file, bytes.
export function mp3EstimateBytes(seconds, kbps) {
  return Math.round((Number(seconds) || 0) * mp3Bitrate(kbps) * 1000 / 8);
}

// ---- ID3v2.3 tag with the title (UTF-16), so players show a name -------------------
function syncsafe(n) { return [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]; }

export function id3Tag(title) {
  const text = String(title || '').slice(0, 200);
  if (!text) return new Uint8Array(0);
  const body = [1, 0xff, 0xfe];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const units = c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c];
    for (const u of units) body.push(u & 255, u >> 8);
  }
  body.push(0, 0);
  const frame = [0x54, 0x49, 0x54, 0x32, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, 0, 0, ...body];
  return Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(frame.length), ...frame]);
}

// ---- PCM helpers -------------------------------------------------------------------
export function floatToInt16(f32, from = 0, to = f32.length) {
  const out = new Int16Array(to - from);
  for (let i = from, j = 0; i < to; i++, j++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[j] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// pcm: { sampleRate, channels: [Float32Array, ...] } (1 or 2 channels)
// lame: the lamejs namespace ({ Mp3Encoder }). Returns an array of Uint8Array chunks.
export async function encodeMp3(pcm, { kbps = 192, lame, onProgress, signal, title = '' } = {}) {
  if (!lame || typeof lame.Mp3Encoder !== 'function') throw new Error('mp3_encoder_missing');
  const ch = pcm.channels.length > 1 ? 2 : 1;
  const enc = new lame.Mp3Encoder(ch, pcm.sampleRate, mp3Bitrate(kbps));
  const total = pcm.channels[0].length;
  const BLOCK = 1152 * 40;
  const out = [];
  const tag = id3Tag(title);
  if (tag.length) out.push(tag);
  const push = (buf) => { if (buf && buf.length) out.push(Uint8Array.from(buf)); };
  for (let i = 0; i < total; i += BLOCK) {
    if (signal?.aborted) throw new Error('aborted');
    const end = Math.min(i + BLOCK, total);
    const left = floatToInt16(pcm.channels[0], i, end);
    push(ch === 2 ? enc.encodeBuffer(left, floatToInt16(pcm.channels[1], i, end)) : enc.encodeBuffer(left));
    onProgress?.(end / total);
    await tick(); // keep the event page responsive
  }
  push(enc.flush());
  return out;
}

// Decode with the browser's decoder; resampled to 44.1 kHz so any source rate works.
export async function decodeToPcm(arrayBuffer, ctxFactory = () => new globalThis.OfflineAudioContext(2, 1, 44100)) {
  const ctx = ctxFactory();
  const buf = await ctx.decodeAudioData(arrayBuffer);
  const channels = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c));
  return { sampleRate: buf.sampleRate, channels, seconds: buf.duration };
}
