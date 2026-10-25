// Video file -> animated GIF in the browser (1.6.4). Needs a document (Firefox background page): the video is
// decoded by a <video> element from a blob: address, frames are taken by seeking and drawn to a canvas, and
// lib/gif.js encodes them one by one (only the encoded bytes are kept). No sound in a GIF.
import { createGifEncoder, gifSize } from './gif.js';

export const GIF_MAX_SECONDS = 60;
export const GIF_FPS = 10;

export class GifError extends Error {
  constructor(code, message) { super(message || code); this.code = code; } // 'gifTooLong' | 'gifDecode' | 'aborted'
}

function once(el, ok, bad, signal, ms = 15000) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); el.removeEventListener(ok, onOk); el.removeEventListener(bad, onBad); signal?.removeEventListener('abort', onAbort); fn(v); };
    const onOk = () => done(resolve);
    const onBad = () => done(reject, new GifError('gifDecode', 'The video cannot be decoded here'));
    const onAbort = () => done(reject, new GifError('aborted'));
    const timer = setTimeout(() => done(reject, new GifError('gifDecode', `No "${ok}" in time`)), ms);
    el.addEventListener(ok, onOk);
    el.addEventListener(bad, onBad);
    signal?.addEventListener('abort', onAbort);
  });
}

// blob: the video file; maxWidth: 480 / 320; onProgress(0..1)
// start / end (seconds, 1.6.6 converter): only that part of the video; the length limit applies to the part
export async function videoToGif(blob, { maxWidth = 480, fps = GIF_FPS, maxSeconds = GIF_MAX_SECONDS, start = 0, end = Infinity, signal, onProgress, doc = globalThis.document } = {}) {
  if (!doc) throw new GifError('gifDecode', 'No document to decode the video in');
  const url = URL.createObjectURL(blob);
  const video = doc.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  try {
    if (video.readyState < 2) await once(video, 'loadeddata', 'error', signal);
    const duration = video.duration;
    if (!(duration > 0) || !isFinite(duration)) throw new GifError('gifDecode', 'Unknown video length');
    const from = Math.max(0, Math.min(Number(start) || 0, duration));
    const to = Math.min(duration, end > from ? end : duration);
    const span = to - from;
    if (!(span > 0)) throw new GifError('gifDecode', 'Nothing to take between start and end');
    if (span > maxSeconds + 0.5) throw new GifError('gifTooLong', `The video is ${Math.round(span)} s long`);
    const { width, height } = gifSize(video.videoWidth, video.videoHeight, maxWidth);
    const canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const enc = createGifEncoder(width, height);
    const step = 1 / fps;
    const count = Math.max(1, Math.floor(span * fps + 1e-6));
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) throw new GifError('aborted');
      const t = Math.min(to - 0.001, from + i * step + step / 2);
      video.currentTime = t;
      await once(video, 'seeked', 'error', signal);
      ctx.drawImage(video, 0, 0, width, height);
      enc.addFrame(ctx.getImageData(0, 0, width, height).data, Math.round(100 / fps));
      onProgress?.((i + 1) / count);
    }
    return new Blob(enc.finish(), { type: 'image/gif' });
  } finally {
    video.removeAttribute('src');
    try { video.load(); } catch { /* released */ }
    URL.revokeObjectURL(url);
  }
}
