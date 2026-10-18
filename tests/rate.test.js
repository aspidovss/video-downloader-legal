// Speed and remaining time of a download job (lib/rate.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRate, etaText } from '../lib/rate.js';

const clock = () => { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; };

test('rate: nothing to show until the window spans enough time', () => {
  const c = clock();
  const r = makeRate({ now: c.now });
  c.tick(500); r.add(1_000_000, 1);
  assert.equal(r.speed(), 0);
  assert.equal(r.eta(100), 0);
});

test('rate: speed in bytes per second and time left from the pace of parts', () => {
  const c = clock();
  const r = makeRate({ now: c.now });
  for (let i = 1; i <= 4; i++) { c.tick(1000); r.add(i * 2_000_000, i * 2); }
  assert.equal(r.speed(), 2_000_000);
  assert.equal(r.eta(100), 46); // 92 parts left at 2 parts/s
});

test('rate: the window rolls, so the speed follows the current pace', () => {
  const c = clock();
  const r = makeRate({ now: c.now, windowMs: 5000 });
  let b = 0;
  for (let i = 1; i <= 10; i++) { c.tick(1000); b += 4_000_000; r.add(b, i); }
  for (let i = 11; i <= 20; i++) { c.tick(1000); b += 1_000_000; r.add(b, i); }
  assert.ok(Math.abs(r.speed() - 1_000_000) < 1e-6);
});

test('rate: a retry pass that counts from zero again starts a new measure', () => {
  const c = clock();
  const r = makeRate({ now: c.now });
  for (let i = 1; i <= 4; i++) { c.tick(1000); r.add(i * 1000, i); }
  c.tick(1000); r.add(500, 1);
  assert.equal(r.speed(), 0);
});

test('etaText: seconds, minutes, hours', () => {
  assert.equal(etaText(0), '');
  assert.equal(etaText(12), '~15 s');
  assert.equal(etaText(130), '~2 min');
  assert.equal(etaText(3600), '~1 h');
  assert.equal(etaText(4800, { s: 'с', min: 'мин', h: 'ч' }), '~1 ч 20 мин');
});
