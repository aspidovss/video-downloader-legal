import test from 'node:test';
import assert from 'node:assert/strict';
import { scrub, makeEntry, trimLog, formatLine, formatLog, LOG_MAX_ENTRIES } from '../lib/debuglog.js';
import { DEFAULTS } from '../utils/settings.js';

test('debug log is off by default', () => { assert.equal(DEFAULTS.debugLog, false); });

test('scrub: links keep host, path and parameter names only; full links on request', () => {
  const u = 'https://a.example.com/v/clip.mp4?token=SECRET&x=1';
  assert.equal(scrub(`GET ${u} failed`), 'GET https://a.example.com/v/clip.mp4 ?token&x failed');
  assert.ok(scrub(u, true).includes('SECRET'));
});

test('makeEntry: data is serialised and scrubbed, long text is cut', () => {
  const e = makeEntry('detect', 'hls found', { url: 'https://h.io/m.m3u8?k=SECRET' }, false, 1000);
  assert.equal(e.t, 1000);
  assert.equal(e.g, 'detect');
  assert.ok(!e.m.includes('SECRET') && e.m.includes('h.io/m.m3u8'));
  assert.ok(makeEntry('x', 'a'.repeat(5000)).m.length <= 600);
});

test('trimLog keeps the newest entries within the count and size limits', () => {
  const list = Array.from({ length: LOG_MAX_ENTRIES + 50 }, (_, i) => ({ t: i, g: 'g', m: `m${i}` }));
  const out = trimLog(list);
  assert.equal(out.length, LOG_MAX_ENTRIES);
  assert.equal(out.at(-1).m, `m${LOG_MAX_ENTRIES + 49}`);
  const big = Array.from({ length: 10 }, (_, i) => ({ t: i, g: 'g', m: 'x'.repeat(500) + i }));
  const small = trimLog(big, 100, 2000);
  assert.ok(small.length < 10 && small.at(-1).m.endsWith('9'));
});

test('formatLog: header lines, then one line per entry with a time and the tag', () => {
  const text = formatLog([{ t: Date.UTC(2026, 9, 14, 1, 2, 3), g: 'job', m: '#1 done' }], ['VDL 1.5.5']);
  assert.equal(text.split('\n')[0], 'VDL 1.5.5');
  assert.equal(formatLine({ t: Date.UTC(2026, 9, 14, 1, 2, 3), g: 'job', m: 'x' }), '2026-10-14 01:02:03.000 [job] x');
  assert.ok(text.endsWith('[job] #1 done'));
});

import { diagLines } from '../lib/debuglog.js';
test('diagLines: report groups become log lines, formats are compact but complete, parameter lists kept, long groups cut', () => {
  const rep = { extension: '1', userAgent: 'x', time: 't', page: 'watch', playability: 'OK',
    formatList: [{ itag: 18, label: '360p', mime: 'video/mp4', codecs: 'avc1', bitrate: 321319, mode: 'direct', nParam: true, hasLength: false, drm: false }, { itag: 140, label: '', mime: 'audio/mp4', codecs: 'mp4a', bitrate: 130466, mode: 'none', nParam: false, hasLength: true, drm: false }],
    api: { client: 'VISIONOS', log: [{ status: 200, params: ['a', 'b'] }] }, test: { results: Array.from({ length: 80 }, (_, i) => ({ plan: `p${i}`, ms: i })) } };
  const lines = diagLines(JSON.stringify(rep));
  const text = lines.map((l) => l[1]).join('\n');
  assert.ok(lines.every(([g, m]) => g === 'test' && m.length < 600));
  assert.match(text, /^page: "watch"/m);
  assert.match(text, /formatList: 18 360p video\/mp4 avc1 321319bps direct n; 140 - audio\/mp4 mp4a 130466bps none len/);
  assert.match(text, /"params":\["a","b"\]/);
  assert.doesNotMatch(text, /userAgent/);
  assert.ok(lines.filter(([, m]) => m.startsWith('test (')).length > 1, 'long group is split');
  assert.equal(diagLines('not json').length, 1);
});
