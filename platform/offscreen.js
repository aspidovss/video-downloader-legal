// Chrome only. Offscreen document: the service worker has no DOM, so blob: URLs for downloads and
// the "audio -> MP3" conversion (browser decoder + lamejs) live here. Blobs arrive through IndexedDB.
import { getBlob, putBlob, delBlob } from '../lib/blobstore.js';
import { encodeMp3, decodeToPcm, mp3Bitrate, MP3_MAX_SECONDS } from '../lib/mp3.js';
import { videoToGif } from '../lib/gifvideo.js';

const urls = new Map(); // blob: URL -> store key
const jobs = new Map(); // jobId -> AbortController

async function blobUrl({ key }) {
  const blob = await getBlob(key);
  if (!blob) throw new Error('blob_missing');
  const url = URL.createObjectURL(blob);
  urls.set(url, key);
  return { url };
}

async function revoke({ url }) {
  URL.revokeObjectURL(url);
  const key = urls.get(url);
  urls.delete(url);
  if (key) await delBlob(key).catch(() => {});
  return { ok: true };
}

async function mp3({ key, resultKey, kbps, title, jobId }) {
  const ctl = new AbortController();
  jobs.set(jobId, ctl);
  try {
    const src = await getBlob(key);
    if (!src) throw Object.assign(new Error('blob_missing'), { code: 'mp3Decode' });
    let pcm;
    try { pcm = await decodeToPcm(await src.arrayBuffer()); } catch { throw Object.assign(new Error('decode'), { code: 'mp3Decode' }); }
    if (pcm.seconds > MP3_MAX_SECONDS) throw Object.assign(new Error('too_long'), { code: 'mp3TooLong' });
    if (!globalThis.lamejs?.Mp3Encoder) throw Object.assign(new Error('encoder_missing'), { code: 'mp3Missing' });
    const parts = await encodeMp3(pcm, {
      kbps: mp3Bitrate(kbps), lame: globalThis.lamejs, title, signal: ctl.signal,
      onProgress: (p) => { chrome.runtime.sendMessage({ target: 'vdl-sw', type: 'mp3_progress', jobId, p }).catch(() => {}); },
    });
    await putBlob(resultKey, new Blob(parts, { type: 'audio/mpeg' }));
    return { ok: true };
  } finally {
    jobs.delete(jobId);
    await delBlob(key).catch(() => {});
  }
}

// video -> GIF (1.6.4): the <video> decoder and a canvas exist only in a document
async function gif({ key, resultKey, maxWidth, fps, maxSeconds, jobId }) {
  const ctl = new AbortController();
  jobs.set(jobId, ctl);
  try {
    const src = await getBlob(key);
    if (!src) throw Object.assign(new Error('blob_missing'), { code: 'gifDecode' });
    let last = 0;
    const out = await videoToGif(src, {
      maxWidth, ...(fps ? { fps } : {}), ...(maxSeconds ? { maxSeconds } : {}), signal: ctl.signal, doc: document,
      onProgress: (p) => { if (p - last >= 0.02 || p === 1) { last = p; chrome.runtime.sendMessage({ target: 'vdl-sw', type: 'gif_progress', jobId, p }).catch(() => {}); } },
    });
    await putBlob(resultKey, out);
    return { ok: true };
  } catch (e) {
    throw Object.assign(new Error(String(e?.message || e)), { code: e?.code || 'gifDecode' });
  } finally {
    jobs.delete(jobId);
    await delBlob(key).catch(() => {});
  }
}

const handlers = {
  gif,
  gif_abort: async ({ jobId }) => { jobs.get(jobId)?.abort(); return { ok: true }; },
  blobUrl,
  revoke,
  mp3,
  mp3_abort: async ({ jobId }) => { jobs.get(jobId)?.abort(); return { ok: true }; },
};

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'vdl-offscreen' || !handlers[msg.type]) return undefined;
  return handlers[msg.type](msg).catch((e) => ({ error: String(e?.message || e), code: e?.code || '' }));
});
