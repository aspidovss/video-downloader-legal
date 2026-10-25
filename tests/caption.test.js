import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, fitText, captionLayout, captionPrefs, drawBackdrop, drawTexts } from '../lib/caption.js';

const m = (s, px) => s.length * px * 0.6; // a monospace-like measure
const mf = (s) => s.length * 10;

test('wrapText: words, new lines, long words', () => {
  assert.deepEqual(wrapText('aa bb cc', 50, mf), ['aa bb', 'cc']);
  assert.deepEqual(wrapText('one\ntwo', 1000, mf), ['one', 'two']);
  assert.deepEqual(wrapText('abcdefghij', 40, mf), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('   ', 100, mf), []);
});

test('fitText: shrinks the font until the lines fit', () => {
  const r = fitText('a long caption that does not fit in one line', 200, 2, 40, 10, m);
  assert.ok(r.lines.length <= 2);
  assert.ok(r.px < 40 && r.px >= 10);
  assert.equal(fitText('short', 200, 1, 40, 10, m).px, 40);
});

test('captionLayout: none = the plain GIF size', () => {
  const L = captionLayout(1280, 720, 480, { style: 'none' }, m);
  assert.deepEqual([L.width, L.height, L.video.y, L.texts.length], [480, 270, 0, 0]);
});

test('captionLayout: bars on top, bottom, both; empty text = no bar', () => {
  const top = captionLayout(1280, 720, 480, { style: 'bar', barPos: 'top', top: '67676767' }, m);
  assert.ok(top.video.y > 0);
  assert.equal(top.height, top.video.y + 270);
  assert.equal(top.blocks[0].h, top.video.y);
  const both = captionLayout(1280, 720, 480, { style: 'bar', barPos: 'both', top: 'A', bottom: 'B' }, m);
  assert.equal(both.blocks.length, 2);
  assert.equal(both.texts.length, 2);
  assert.ok(both.height > top.height);
  const bottomOnly = captionLayout(1280, 720, 480, { style: 'bar', barPos: 'bottom', top: 'ignored', bottom: 'B' }, m);
  assert.equal(bottomOnly.video.y, 0);
  assert.equal(bottomOnly.blocks[0].y, 270);
  const empty = captionLayout(1280, 720, 480, { style: 'bar', barPos: 'top', top: '  ' }, m);
  assert.equal(empty.height, 270);
  const long = captionLayout(1280, 720, 480, { style: 'bar', barPos: 'top', top: 'word '.repeat(60) }, m);
  assert.ok(long.texts[0].lines.length <= 3);
});

test('captionLayout: text on the video keeps the size; position and colours', () => {
  const c = (pos, color) => captionLayout(720, 404, 480, { style: 'overlay', text: 'хи-хи ха-ха', overlayPos: pos, overlayColor: color }, m);
  const top = c('top', 'white'), mid = c('center', 'white'), bot = c('bottom', 'black');
  assert.deepEqual([top.width, top.height], [480, 269]);
  assert.ok(top.texts[0].y < mid.texts[0].y && mid.texts[0].y < bot.texts[0].y);
  assert.equal(top.texts[0].fill, '#fff'); assert.equal(top.texts[0].stroke, '#000');
  assert.equal(bot.texts[0].fill, '#000'); assert.equal(bot.texts[0].stroke, '#fff');
});

test('captionLayout: demotivator frames the video and adds two lines', () => {
  const L = captionLayout(1280, 720, 480, { style: 'demotivator', title: 'Шаблон смс-ка для бывшей', sub: 'и вторая строка' }, m);
  assert.equal(L.width, 480);
  assert.equal(L.background, '#000');
  assert.ok(L.video.w < 480 && L.video.x > 0 && L.video.y > 0);
  assert.equal(L.texts.length, 2);
  assert.ok(L.texts[0].px > L.texts[1].px);
  assert.ok(L.texts[1].y > L.texts[0].y);
  assert.ok(L.height > L.texts[1].y);
  const f = L.blocks[0];
  assert.ok(f.x < L.video.x && f.x + f.w > L.video.x + L.video.w);
  const bare = captionLayout(1280, 720, 480, { style: 'demotivator' }, m);
  assert.equal(bare.texts.length, 0);
  assert.ok(bare.height < L.height);
});

test('captionPrefs: only style and positions, with defaults', () => {
  assert.deepEqual(captionPrefs(), { style: 'none', barPos: 'top', overlayPos: 'bottom', overlayColor: 'white' });
  assert.deepEqual(captionPrefs({ style: 'bar', barPos: 'both', overlayPos: 'x', overlayColor: 'black', top: 'secret' }), { style: 'bar', barPos: 'both', overlayPos: 'bottom', overlayColor: 'black' });
});

test('drawBackdrop / drawTexts paint through the context', () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])), set: (o, k, v) => { o[k] = v; return true; } });
  const L = captionLayout(1280, 720, 480, { style: 'overlay', text: 'hello', overlayColor: 'white' }, m);
  drawBackdrop(ctx, L);
  drawTexts(ctx, L);
  assert.deepEqual(calls.filter((c) => c[0] === 'strokeText' || c[0] === 'fillText').map((c) => c[0]), ['strokeText', 'fillText']);
  const D = captionLayout(1280, 720, 480, { style: 'demotivator', title: 'T' }, m);
  calls.length = 0;
  drawBackdrop(ctx, D);
  assert.deepEqual(calls.map((c) => c[0]), ['fillRect', 'strokeRect']);
});
