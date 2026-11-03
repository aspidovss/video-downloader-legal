// Recordings and long downloads in parts (1.6.8): lib/split.js, the parts of lib/liverec.js, the YouTube recorder's helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { splitPrefs, partDue, partStamp, withPartSuffix, planCuts, splitTrackParts } from '../lib/split.js';
import { recordLive } from '../lib/liverec.js';

test('splitPrefs: defaults (live on, videos off), limits clamped', () => {
  const d = splitPrefs({});
  assert.deepEqual(d.live, { bytes: 2000 * 1048576, seconds: 3600 });
  assert.equal(d.video, null);
  assert.equal(splitPrefs({ splitLive: false }).live, null);
  assert.deepEqual(splitPrefs({ splitVideo: true, partMB: 10, partMin: 9999 }).video, { bytes: 50 * 1048576, seconds: 720 * 60 });
  assert.ok(partDue({ bytes: 2000 * 1048576, seconds: 1 }, d.live));
  assert.ok(partDue({ bytes: 1, seconds: 3600 }, d.live));
  assert.ok(!partDue({ bytes: 1, seconds: 1 }, d.live));
  assert.ok(!partDue({ bytes: 9e12, seconds: 9e9 }, null));
});

test('part names: start time as HH-MM-SS before the extension', () => {
  assert.equal(partStamp(0), '00-00-00');
  assert.equal(partStamp(3725.9), '01-02-05');
  assert.equal(partStamp(360000), '100-00-00');
  assert.equal(withPartSuffix('Stream twitch.tv 1080p.mp4', 3600), 'Stream twitch.tv 1080p (01-00-00).mp4');
  assert.equal(withPartSuffix('Show 720p.audio.m4a', 7200), 'Show 720p (02-00-00).audio.m4a');
});

test('planCuts: by length, by size (bitrate), none when short or unknown', () => {
  const tenMin = { durations: Array(60).fill(10), bandwidth: 0 }; // 10 min of 10 s segments
  assert.deepEqual(planCuts([tenMin], { bytes: Infinity, seconds: 240 }), [240, 480]);
  assert.deepEqual(planCuts([{ durations: Array(60).fill(10), bandwidth: 8 * 1048576 }], { bytes: 100 * 1048576, seconds: 9999 }), [100, 200, 300, 400, 500]);
  assert.deepEqual(planCuts([tenMin], { bytes: Infinity, seconds: 3600 }), []);
  assert.deepEqual(planCuts([{ durations: [10, undefined, 10], bandwidth: 0 }], { bytes: 1, seconds: 1 }), []);
  assert.deepEqual(planCuts([tenMin], null), []);
});

test('splitTrackParts: every piece gets the init segment, cuts at segment starts', () => {
  const parts = [{ url: 'init', init: true }, ...Array.from({ length: 6 }, (_, i) => ({ url: `s${i}`, duration: 10 }))];
  const g = splitTrackParts(parts, [20, 40]);
  assert.deepEqual(g.map((x) => x.map((p) => p.url)), [['init', 's0', 's1'], ['init', 's2', 's3'], ['init', 's4', 's5']]);
  const ts = splitTrackParts(Array.from({ length: 4 }, (_, i) => ({ url: `t${i}`, duration: 6 })), [10]); // cut inside a segment: at the next start
  assert.deepEqual(ts.map((x) => x.map((p) => p.url)), [['t0', 't1'], ['t2', 't3']]);
});

// ---- live recording in parts -------------------------------------------------------------------
function liveServer(windows, { endAfter = Infinity, map = false } = {}) {
  let polls = 0;
  const fetchFn = async (url) => {
    if (url.endsWith('live.m3u8')) {
      const w = windows[Math.min(polls, windows.length - 1)];
      polls++;
      const text = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${w[0]}\n${map ? '#EXT-X-MAP:URI="init.mp4"\n' : ''}${w.map((n) => `#EXTINF:2,\nseg${n}.ts`).join('\n')}\n${polls > endAfter ? '#EXT-X-ENDLIST\n' : ''}`;
      return { ok: true, status: 200, text: async () => text };
    }
    if (url.endsWith('init.mp4')) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('[I]').buffer };
    const n = Number(/seg(\d+)\.ts/.exec(url)[1]);
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(`[${n}]`).buffer };
  };
  return { fetchFn };
}
const text = async (blobs) => (await new Blob(blobs).text());
const fast = { minPollMs: 5, maxPollMs: 5 };

test('live in parts: cut where the clock reaches each cut, nothing lost or doubled, init repeated (fMP4)', async () => {
  const s = liveServer([[0, 1, 2], [2, 3, 4], [4, 5, 6], [6, 7, 8]], { endAfter: 4, map: true });
  const cuts = [4, 10]; // segments are 2 s: part 0 = seg0..1, part 1 = seg2..4, the rest stays in the recording
  const parts = [];
  const r = await recordLive('https://x/live.m3u8', { fetchFn: s.fetchFn, ...fast, nextCut: (k) => cuts[k] ?? Infinity, onPart: (p) => parts.push(p) });
  assert.equal(parts.length, 2);
  assert.equal(await text(parts[0].blobs), '[I][0][1]');
  assert.equal(parts[0].start, 0);
  assert.equal(await text(parts[1].blobs), '[I][2][3][4]');
  assert.equal(parts[1].start, 4);
  assert.equal(await text(r.blobs), '[I][5][6][7][8]');
  assert.equal(r.parts, 2);
  assert.equal(r.partStart, 10);
  assert.equal(r.segments, 9);
});

test('live in parts: a cut decided from the progress (as the background does) takes effect at the next segment', async () => {
  const s = liveServer([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]], { endAfter: 5 });
  const cuts = [];
  const parts = [];
  const r = await recordLive('https://x/live.m3u8', {
    fetchFn: s.fetchFn, ...fast, nextCut: (k) => cuts[k] ?? Infinity, onPart: (p) => parts.push(p),
    onProgress: (p) => { const from = cuts.length ? cuts[cuts.length - 1] : 0; if (p.clock - from >= 4) cuts.push(p.clock); },
  });
  const all = [...await Promise.all(parts.map((p) => text(p.blobs))), await text(r.blobs)].join('|');
  assert.equal(all.replace(/\|/g, ''), '[0][1][2][3][4][5]');
  assert.ok(parts.length >= 1);
  parts.forEach((p, i) => assert.equal(p.start, i ? cuts[i - 1] : 0));
});

// ---- YouTube page recorder helpers -------------------------------------------------------------
const ctx = { module: { exports: {} }, Blob, Uint8Array, Map, Set, Math, String, Number, Array, Object, TextDecoder, DataView };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../lib/mux.js', import.meta.url), 'utf8'), ctx);
ctx.module = { exports: {} };
vm.runInContext(fs.readFileSync(new URL('../injected/youtube_rec.js', import.meta.url), 'utf8'), ctx);
const yr = ctx.module.exports;

test('YouTube recorder: part names, where to cut, fragments moved out of the capture', () => {
  assert.equal(yr.partName('youtube_x_2026 1080p.mp4', 3600), 'youtube_x_2026 1080p (01-00-00).mp4');
  assert.equal(yr.partName('a.audio.weba', 61), 'a (00-01-01).audio.weba');
  const lim = { ms: 60000, bytes: 1e9 };
  assert.equal(yr.cutPoint([0, 0], [50000, 59000], 10, lim, null), null);
  assert.equal(yr.cutPoint([0, 0], [70000, 61000], 10, lim, null), 61000); // the time both tracks reached
  assert.equal(yr.cutPoint([0], [5000], 2e9, lim, null), 5000); // by size
  assert.equal(yr.cutPoint([0], [65000], 10, lim, 30000), null); // the part began at 30 s
  const rep = { init: new Uint8Array([1]), frags: new Map([[0, new Blob(['a'])], [4000, new Blob(['bb'])], [8000, new Blob(['ccc'])]]), height: 720, bytes: 6 };
  const track = { kind: 'video', container: 'mp4', ext: 'mp4', mime: 'video/mp4', reps: new Map([['r', rep]]), best: () => rep };
  const taken = yr.takeBefore([track], 8000);
  assert.equal(taken.length, 1);
  assert.deepEqual([...taken[0].best().frags.keys()], [0, 4000]);
  assert.equal(taken[0].best().init, rep.init);
  assert.deepEqual([...rep.frags.keys()], [8000]);
  assert.equal(rep.bytes, 3);
});
