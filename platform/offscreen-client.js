// Chrome only (service worker side): talks to the offscreen document (platform/offscreen.js).
// The Chrome build copies this file to service/offscreen-client.js (scripts/build-chrome.mjs); the Firefox package has a stub there.
import { putBlob, getBlob, delBlob } from '../lib/blobstore.js';

let creating = null;
async function ensure() {
  const have = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (have.length) return;
  creating ||= chrome.offscreen.createDocument({
    url: 'platform/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Create blob: URLs for saving downloaded media, convert audio to MP3 and short videos to GIF (need the DOM audio / video decoders and a canvas).',
  }).finally(() => { creating = null; });
  await creating;
}

async function call(msg) {
  await ensure();
  const r = await chrome.runtime.sendMessage({ target: 'vdl-offscreen', ...msg });
  if (!r || r.error) throw Object.assign(new Error(r?.error || 'offscreen_failed'), { code: r?.code || '' });
  return r;
}

const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export async function chromeBlobUrl(blob) {
  const key = `u-${uid()}`;
  await putBlob(key, blob);
  try { return (await call({ type: 'blobUrl', key })).url; } catch (e) { await delBlob(key).catch(() => {}); throw e; }
}

export function chromeRevoke(url) { return call({ type: 'revoke', url }).catch(() => {}); }

const listeners = new Map(); // jobId -> onProgress
globalThis.chrome?.runtime?.onMessage?.addListener((msg) => {
  if (msg && msg.target === 'vdl-sw' && (msg.type === 'mp3_progress' || msg.type === 'gif_progress')) listeners.get(msg.jobId)?.(msg.p);
  return false;
});

export async function chromeMp3(blob, { kbps, title, onProgress, signal }) {
  const jobId = `m-${uid()}`;
  const key = `s-${jobId}`;
  const resultKey = `r-${jobId}`;
  await putBlob(key, blob);
  listeners.set(jobId, onProgress);
  const abort = () => { call({ type: 'mp3_abort', jobId }).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await call({ type: 'mp3', key, resultKey, kbps, title, jobId });
    const out = await getBlob(resultKey);
    if (!out) throw new Error('mp3_result_missing');
    return out;
  } catch (e) {
    if (signal?.aborted) throw new Error('aborted');
    throw e;
  } finally {
    listeners.delete(jobId);
    signal?.removeEventListener('abort', abort);
    await delBlob(key).catch(() => {});
    await delBlob(resultKey).catch(() => {});
  }
}

// video -> GIF in the offscreen document (1.6.4); errors carry code 'gifTooLong' / 'gifDecode' / 'aborted'
export async function chromeGif(blob, { maxWidth, fps, maxSeconds, onProgress, signal }) {
  const jobId = `g-${uid()}`;
  const key = `s-${jobId}`;
  const resultKey = `r-${jobId}`;
  await putBlob(key, blob);
  listeners.set(jobId, onProgress);
  const abort = () => { call({ type: 'gif_abort', jobId }).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await call({ type: 'gif', key, resultKey, maxWidth, fps, maxSeconds, jobId });
    const out = await getBlob(resultKey);
    if (!out) throw Object.assign(new Error('gif_result_missing'), { code: 'gifDecode' });
    return out;
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
    throw e;
  } finally {
    listeners.delete(jobId);
    signal?.removeEventListener('abort', abort);
    await delBlob(key).catch(() => {});
    await delBlob(resultKey).catch(() => {});
  }
}
