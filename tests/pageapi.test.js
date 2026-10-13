// The in-page script (method 2) must build exactly the same request as the background version (lib/ytapi.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolveClients, parseSwData, buildSessionPlayerRequest } from '../lib/ytapi.js';

const ctx = { module: { exports: {} }, URL, JSON, Date, String, Object, Array };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../injected/youtube_api.js', import.meta.url), 'utf8'), ctx);
const page = ctx.module.exports;

const m = new Array(110).fill(null);
Object.assign(m, { 0: 'en', 1: 'US', 3: '1.2.3.4', 11: 'Apple', 12: 'Mac', 13: 'VISITOR', 17: 'Macintosh', 18: '10.15', 79: 'Europe/Moscow', 86: 'Firefox', 87: '157.0', 103: 'dev', 107: 'roll', 61: ['x', 'INSTALL'] });
const swText = ")]}'\n" + JSON.stringify([[null, null, [[m], 'APIKEY123']]]);

test('page script parses sw.js_data like the background', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(page.parseSwData(swText))), parseSwData(swText));
  assert.equal(page.parseSwData('nope'), null);
});

test('page script builds the same body and headers as the background for every client', () => {
  const session = parseSwData(swText);
  for (const c of resolveClients()) {
    const a = buildSessionPlayerRequest(c, 'vid12345678', session, 180);
    const b = page.buildRequest(c, 'vid12345678', session, 180);
    assert.equal(b.init.body, a.init.body, c.key);
    assert.deepEqual(JSON.parse(JSON.stringify(b.init.headers)), a.init.headers);
    assert.equal(new URL(b.url, 'https://www.youtube.com').href, a.url);
  }
});

test('page script run(): sw.js_data first, stops at the first non-IOS client with links, trims the answer', async () => {
  const calls = [];
  ctx.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('sw.js_data')) return { ok: true, status: 200, text: async () => swText };
    const name = JSON.parse(init.body).context.client.clientName;
    if (name === 'VISIONOS') return { ok: true, status: 200, json: async () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } }) };
    return { ok: true, status: 200, json: async () => ({ playabilityStatus: { status: 'OK' }, videoDetails: { title: 'T', lengthSeconds: '5', extra: 1 }, streamingData: { adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4', url: 'https://x.googlevideo.com/a' }] }, junk: 1 }) };
  };
  ctx.window = {};
  const res = await vm.runInContext('module.exports.run', ctx)({ id: 7, videoId: 'vid12345678', clients: resolveClients() });
  assert.equal(res.session, 'ok');
  assert.deepEqual([...res.results.map((r) => r.client)], ['VISIONOS', 'ANDROID_VR']);
  assert.equal(res.results[1].json.junk, undefined);
  assert.equal(res.results[1].json.streamingData.adaptiveFormats.length, 1);
  assert.ok(calls[0].includes('/sw.js_data'));
  assert.ok(calls[1].startsWith('/youtubei/v1/player?prettyPrint=false&key=APIKEY123'));
});
