import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffKind, mp4TopBoxes, isFragmented, convertTargets, parseTime, formatTime, trimRange, pcmSlice, outName, gifEstimateBytes } from '../lib/convert.js';

const box = (type, len) => { const b = new Uint8Array(len); new DataView(b.buffer).setUint32(0, len); for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i); return b; };
const join = (...p) => { const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of p) { out.set(x, o); o += x.length; } return out; };

test('sniffKind: by the first bytes, then by the name', () => {
  const ts = new Uint8Array(400); ts[0] = 0x47; ts[188] = 0x47;
  assert.equal(sniffKind(ts, 'x.bin'), 'ts');
  assert.equal(sniffKind(box('ftyp', 24), 'a.ts'), 'mp4');
  assert.equal(sniffKind(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]), 'a'), 'webm');
  assert.equal(sniffKind(Uint8Array.from([0x49, 0x44, 0x33, 3]), 'a'), 'audio');
  assert.equal(sniffKind(new TextEncoder().encode('OggS....'), 'a'), 'audio');
  assert.equal(sniffKind(new Uint8Array(8), 'clip.MKV'), 'webm');
  assert.equal(sniffKind(new Uint8Array(8), 'notes.txt'), 'other');
  assert.equal(sniffKind(new Uint8Array(8), 'song', 'audio/aac'), 'audio');
});

test('mp4TopBoxes + isFragmented', async () => {
  const plain = join(box('ftyp', 24), box('moov', 100), box('mdat', 300));
  const frag = join(box('ftyp', 24), box('moov', 100), box('moof', 40), box('mdat', 60), box('moof', 40), box('mdat', 60));
  const reader = (b) => async (a, e) => b.slice(a, e);
  const p = await mp4TopBoxes(plain.length, reader(plain));
  assert.deepEqual(p.map((x) => x.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(isFragmented(p), false);
  const f = await mp4TopBoxes(frag.length, reader(frag));
  assert.equal(isFragmented(f), true);
  assert.equal((await mp4TopBoxes(frag.length, reader(frag), 3)).length, 3);
  assert.deepEqual(await mp4TopBoxes(10, reader(new Uint8Array(10))), []); // a zero size is not a box
});

test('convertTargets', () => {
  assert.deepEqual(convertTargets('mp4'), ['gif', 'mp3', 'png']);
  assert.deepEqual(convertTargets('mp4', { fragmented: true }), ['gif', 'mp3', 'png', 'defrag']);
  assert.deepEqual(convertTargets('ts'), ['gif', 'mp3', 'png', 'mp4', 'mkv']);
  assert.deepEqual(convertTargets('ts', { video: false, audio: false }), ['mp4', 'mkv']);
  assert.deepEqual(convertTargets('audio'), ['mp3']);
  assert.deepEqual(convertTargets('webm', { video: false }), ['mp3']);
  assert.deepEqual(convertTargets('other'), []);
});

test('parseTime / formatTime', () => {
  assert.equal(parseTime(''), null);
  assert.equal(parseTime('75'), 75);
  assert.equal(parseTime('1:15'), 75);
  assert.equal(parseTime('1:01:15'), 3675);
  assert.equal(parseTime('12,5'), 12.5);
  assert.equal(parseTime('0:07.25'), 7.25);
  assert.ok(Number.isNaN(parseTime('abc')));
  assert.ok(Number.isNaN(parseTime('1:2:3:4')));
  assert.equal(formatTime(75), '1:15');
  assert.equal(formatTime(7.25), '0:07.3');
  assert.equal(formatTime(3675), '1:01:15');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(parseTime(formatTime(123.4)), 123.4);
});

test('trimRange', () => {
  assert.deepEqual(trimRange('', '', 30), { start: 0, end: 30, length: 30, whole: true });
  const r = trimRange('5', '0:12', 30);
  assert.equal(r.start, 5); assert.equal(r.end, 12); assert.equal(r.length, 7); assert.equal(r.whole, false);
  assert.equal(trimRange('5', '99', 30).end, 30);
  assert.equal(trimRange('x', '', 30).error, 'convBadTime');
  assert.equal(trimRange('20', '10', 30).error, 'convBadRange');
  assert.equal(trimRange('', '', 0).error, 'convBadRange');
});

test('pcmSlice', () => {
  const pcm = { sampleRate: 10, channels: [new Float32Array(100), new Float32Array(100)], seconds: 10 };
  assert.equal(pcmSlice(pcm, 0, 10), pcm);
  const s = pcmSlice(pcm, 2, 5);
  assert.equal(s.channels.length, 2);
  assert.equal(s.channels[0].length, 30);
  assert.equal(s.seconds, 3);
  assert.equal(pcmSlice(pcm, 9, 99).channels[1].length, 10);
});

test('outName', () => {
  assert.equal(outName('clip.mp4', 'gif', { start: 0, end: 30, whole: true }), 'clip.gif');
  assert.equal(outName('clip.mp4', 'gif', { start: 5, end: 12.5, whole: false }), 'clip 5s-12.5s.gif');
  assert.equal(outName('clip.mp4', 'mp3', { start: 60, end: 75, whole: false }), 'clip 1m00s-1m15s.mp3');
  assert.equal(outName('clip.webm', 'png', { at: 65 }), 'clip 1m05s.png');
  assert.equal(outName('stream.ts', 'mkv'), 'stream.mkv');
  assert.equal(outName('frag.mp4', 'defrag'), 'frag (fixed).mp4');
  assert.match(outName('a:b?.mp4', 'mp4'), /^[^:?]+\.mp4$/);
});

test('gifEstimateBytes', () => {
  assert.equal(gifEstimateBytes(480, 16 / 9, 10, 10), 480 * 270 * 10 * 10 * 0.25);
  assert.equal(gifEstimateBytes(480, 16 / 9, 0, 10), 0);
});
