import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { buildRules } from '../service/headers.js';
import { chromeManifest } from '../scripts/build-chrome.mjs';
import { MiniDOMParser } from '../lib/xmlmini.js';
import { parseMPD } from '../lib/dash.js';

const hdrOf = (r, name) => r.action.requestHeaders.find((h) => h.header === name);

test('buildRules: only extension-made requests (tabId -1), Bilibili/TikTok/sw.js rules are always present', () => {
  const rules = buildRules({ ua: '', live: false, on: true }, 'abc');
  assert.ok(rules.every((r) => r.condition.tabIds[0] === -1 && r.condition.initiatorDomains[0] === 'abc'));
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  const tt = rules.find((r) => r.condition.requestDomains?.includes('tiktok.com'));
  assert.equal(hdrOf(tt, 'referer').value, 'https://www.tiktok.com/');
  assert.equal(hdrOf(tt, 'origin').operation, 'remove');
  assert.ok(rules.some((r) => r.condition.urlFilter === '||www.youtube.com/sw.js_data'));
  assert.ok(!rules.some((r) => String(r.condition.urlFilter).includes('googlevideo')));
});

test('buildRules: YouTube client UA and live-HLS header modes', () => {
  const withUa = buildRules({ ua: 'UA/1', live: false, on: true });
  const gv = withUa.find((r) => r.condition.urlFilter === '||googlevideo.com^');
  assert.equal(hdrOf(gv, 'user-agent').value, 'UA/1');
  assert.equal(hdrOf(gv, 'dnt').value, '1');
  assert.equal(hdrOf(gv, 'origin').value, 'https://www.youtube.com');
  assert.equal(hdrOf(withUa.find((r) => r.condition.urlFilter === '||www.youtube.com/youtubei/'), 'referer').value, 'https://www.youtube.com/');
  const off = buildRules({ ua: 'UA/1', live: false, on: false }).find((r) => r.condition.urlFilter === '||googlevideo.com^');
  assert.equal(hdrOf(off, 'origin').operation, 'remove');
  assert.equal(hdrOf(off, 'dnt'), undefined);
  const live = buildRules({ ua: '', live: true, on: true }).find((r) => r.condition.urlFilter === '||googlevideo.com^');
  assert.equal(hdrOf(live, 'user-agent'), undefined);
  assert.equal(hdrOf(live, 'origin').value, 'https://www.youtube.com');
});

test('chromeManifest: service worker, no blocking webRequest, shim first for extension-world scripts only', () => {
  const src = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const m = chromeManifest(src);
  assert.equal(m.background.service_worker, 'platform/sw.js');
  assert.equal(m.background.scripts, undefined);
  assert.ok(!m.permissions.includes('webRequestBlocking'));
  assert.ok(m.permissions.includes('declarativeNetRequest') && m.permissions.includes('offscreen'));
  assert.equal(m.sidebar_action, undefined);
  assert.equal(m.browser_specific_settings, undefined);
  for (const cs of m.content_scripts) assert.equal(cs.js[0] === 'platform/shim.js', cs.world !== 'MAIN');
  assert.equal(src.background.scripts[0], 'service/main.js'); // the Firefox manifest is untouched
});

test('shim: gives Chrome a `browser` whose onMessage listeners can answer with a Promise', async () => {
  const added = [];
  const chrome = { runtime: { id: 'x', getURL: (p) => `chrome-extension://x/${p}`, onMessage: { addListener: (f) => added.push(f), removeListener() {}, hasListener: () => true } } };
  const ctx = { chrome, globalThis: null };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(new URL('../platform/shim.js', import.meta.url), 'utf8'), ctx);
  assert.ok(ctx.browser);
  assert.equal(ctx.browser.runtime.getURL('a'), 'chrome-extension://x/a');
  ctx.browser.runtime.onMessage.addListener(async (m) => ({ got: m.n }));
  const got = await new Promise((resolve) => { const keep = added[0]({ n: 7 }, {}, resolve); assert.equal(keep, true); });
  assert.deepEqual(got, { got: 7 });
  ctx.browser.runtime.onMessage.addListener(() => undefined);
  assert.equal(added[1]({}, {}, () => assert.fail('no answer expected')), false);
  // already a Firefox-style global: left alone
  const ff = { browser: { marker: 1 }, chrome };
  ff.globalThis = ff;
  vm.runInNewContext(fs.readFileSync(new URL('../platform/shim.js', import.meta.url), 'utf8'), ff);
  assert.equal(ff.browser.marker, 1);
});

test('MiniDOMParser (no DOMParser in the Chrome service worker): parseMPD works and reads references', () => {
  const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT10S" xmlns="urn:mpeg:dash:schema:mpd:2011">
    <BaseURL>https://cdn.example/a&amp;b/</BaseURL><Period><AdaptationSet mimeType="video/mp4" contentType="video">
    <Representation id="v&#49;" bandwidth="1000" codecs="avc1.4d401f" width="640" height="360"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;
  const direct = parseMPD(mpd, 'https://cdn.example/m.mpd', MiniDOMParser);
  const viaDefault = parseMPD(mpd, 'https://cdn.example/m.mpd'); // falls back to MiniDOMParser when DOMParser is missing
  assert.deepEqual(direct, viaDefault);
  assert.equal(direct.videos[0].id, 'v1');
  assert.equal(direct.videos[0].segments[0].url, 'https://cdn.example/a&b/v.mp4');
  const doc = new MiniDOMParser().parseFromString('<a x="1 &lt; 2"><![CDATA[<raw>]]><b/></a>');
  assert.equal(doc.documentElement.getAttribute('x'), '1 < 2');
  assert.equal(doc.documentElement.textContent, '<raw>');
});
