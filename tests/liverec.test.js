import test from 'node:test';
import assert from 'node:assert/strict';
import { recordLive } from '../lib/liverec.js';

// A live playlist whose window slides: each poll reveals more segments.
function liveServer({ windows, endAfter = Infinity, failSeg = new Set(), drm = false }) {
  let polls = 0;
  const fetched = [];
  const fetchFn = async (url) => {
    if (url.endsWith('live.m3u8')) {
      const w = windows[Math.min(polls, windows.length - 1)];
      polls++;
      const ended = polls > endAfter;
      const text = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${w[0]}\n${drm ? '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n' : ''}${w.map((n) => `#EXTINF:2,\nseg${n}.ts?tok=${polls}`).join('\n')}\n${ended ? '#EXT-X-ENDLIST\n' : ''}`;
      return { ok: true, status: 200, text: async () => text };
    }
    const n = Number(/seg(\d+)\.ts/.exec(url)[1]);
    fetched.push(n);
    if (failSeg.has(n)) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(`[${n}]`).buffer };
  };
  return { fetchFn, fetched, polls: () => polls };
}
const text = async (blobs) => (await new Blob(blobs).text());
const fast = { minPollMs: 5, maxPollMs: 5 };

test('live: every segment is taken once, in order, until the stream ends', async () => {
  const s = liveServer({ windows: [[0, 1, 2], [1, 2, 3], [3, 4, 5], [4, 5, 6]], endAfter: 4 });
  const r = await recordLive('https://x/live.m3u8', { fetchFn: s.fetchFn, ...fast });
  assert.equal(await text(r.blobs), '[0][1][2][3][4][5][6]');
  assert.equal(r.reason, 'ended'); assert.equal(r.segments, 7); assert.equal(r.seconds, 14); assert.equal(r.gaps, 0);
  assert.deepEqual(s.fetched.sort(), [0, 1, 2, 3, 4, 5, 6]); // no duplicates
});

test('live: Stop ends the recording and keeps what was captured', async () => {
  const s = liveServer({ windows: [[0, 1], [1, 2], [2, 3], [3, 4]] });
  const stop = new AbortController();
  let n = 0;
  const r = await recordLive('https://x/live.m3u8', { fetchFn: s.fetchFn, stopSignal: stop.signal, ...fast, onProgress: () => { if (++n === 3) stop.abort(); } });
  assert.equal(r.reason, 'stopped');
  assert.equal(await text(r.blobs), '[0][1][2][3]');
});

test('live: Cancel throws, nothing is returned', async () => {
  const s = liveServer({ windows: [[0, 1]] });
  const c = new AbortController();
  setTimeout(() => c.abort(), 30);
  await assert.rejects(recordLive('https://x/live.m3u8', { fetchFn: s.fetchFn, signal: c.signal, ...fast }), (e) => e.code === 'aborted');
});

test('live: a window that moved past segments counts as a gap; an expired segment is skipped', async () => {
  const s = liveServer({ windows: [[0, 1], [5, 6]], endAfter: 3, failSeg: new Set([6]) });
  const r = await recordLive('https://x/live.m3u8', { fetchFn: s.fetchFn, ...fast });
  assert.equal(r.gaps, 3); assert.equal(r.missed, 1);
  assert.equal(await text(r.blobs), '[0][1][5]');
});

test('live: size and time limits stop the recording', async () => {
  const w = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]];
  let r = await recordLive('https://x/live.m3u8', { fetchFn: liveServer({ windows: w }).fetchFn, maxBytes: 10, ...fast });
  assert.equal(r.reason, 'size');
  r = await recordLive('https://x/live.m3u8', { fetchFn: liveServer({ windows: w }).fetchFn, maxSeconds: 5, ...fast });
  assert.equal(r.reason, 'time');
});

test('live: DRM is refused; a dead playlist ends the recording with what was saved', async () => {
  await assert.rejects(recordLive('https://x/live.m3u8', { fetchFn: liveServer({ windows: [[0]], drm: true }).fetchFn, ...fast }), (e) => e.code === 'drm');
  let calls = 0;
  const fetchFn = async (url) => {
    if (url.endsWith('live.m3u8')) { if (calls++ > 0) return { ok: false, status: 500 }; return { ok: true, status: 200, text: async () => '#EXTM3U\n#EXTINF:2,\nseg0.ts\n' }; }
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('[0]').buffer };
  };
  const r = await recordLive('https://x/live.m3u8', { fetchFn, maxPlaylistFailures: 3, ...fast });
  assert.equal(r.reason, 'errors'); assert.equal(await text(r.blobs), '[0]');
});

test('live fMP4: the init segment is saved first and only once', async () => {
  const fetchFn = async (url) => {
    if (url.endsWith('live.m3u8')) return { ok: true, status: 200, text: async () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg0.m4s\n#EXTINF:2,\nseg1.m4s\n#EXT-X-ENDLIST\n' };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(`<${url.split('/').pop()}>`).buffer };
  };
  const r = await recordLive('https://x/live.m3u8', { fetchFn, ...fast });
  assert.equal(r.ext, 'mp4'); assert.equal(await text(r.blobs), '<init.mp4><seg0.m4s><seg1.m4s>');
});
