import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { buildRules } from '../service/headers.js';
import { chromeManifest, build as buildChrome, packageName, packFolder } from '../scripts/build-chrome.mjs';
import { browserName, isAndroid } from '../utils/dom.js';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MiniDOMParser } from '../lib/xmlmini.js';
import { parseMPD } from '../lib/dash.js';

const hdrOf = (r, name) => r.action.requestHeaders.find((h) => h.header === name);

test('buildRules: only extension-made requests (initiator = the extension; no tab condition, Edge), Bilibili/TikTok/sw.js rules are always present', () => {
  const rules = buildRules({ ua: '', live: false, on: true }, 'abc');
  assert.ok(rules.every((r) => r.condition.initiatorDomains[0] === 'abc' && r.condition.tabIds === undefined));
  assert.ok(buildRules({ ua: '', live: false, on: true }).every((r) => r.condition.tabIds[0] === -1), 'without an initiator: tab -1');
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

const FF_DIRS = ['content', 'injected', 'lib', 'service', 'styles', 'utils', 'vendor'];
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

test('Firefox package has no chrome.offscreen code (AMO validator warning); the Chrome build gets the real client', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
  for (const d of FF_DIRS) for (const f of walk(`${root}/${d}`)) {
    if (!/\.(js|mjs|html)$/.test(f)) continue;
    assert.ok(!/offscreen\s*\.\s*createDocument/.test(fs.readFileSync(f, 'utf8')), `${f} must not call offscreen.createDocument`);
  }
  assert.ok(fs.existsSync(`${root}/platform/offscreen-client.js`));
  const { dir } = buildChrome();
  assert.ok(/offscreen\.createDocument/.test(fs.readFileSync(`${dir}/service/offscreen-client.js`, 'utf8')), 'the Chrome build has the real client in service/');
  assert.equal(fs.existsSync(`${dir}/platform/offscreen-client.js`), false, 'no duplicate left in platform/');
  assert.ok(fs.existsSync(`${dir}/vendor/lame.js`) && !fs.existsSync(`${dir}/vendor/lame.min.js`));
  assert.ok(fs.existsSync(`${dir}/LICENSES/LGPL-3.0.txt`) && fs.existsSync(`${dir}/LICENSES/lamejs-LICENSE.txt`), 'the Chrome package carries all licence texts');
  const stub = fs.readFileSync(`${root}/service/offscreen-client.js`, 'utf8');
  for (const name of ['chromeBlobUrl', 'chromeRevoke', 'chromeMp3']) assert.ok(stub.includes(`export const ${name}`), `stub exports ${name}`);
});

test('manifest: Firefox for Android minimum is declared (data_collection_permissions needs 142)', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.browser_specific_settings.gecko.strict_min_version, '140.0');
  assert.deepEqual(m.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
  assert.equal(m.browser_specific_settings.gecko_android.strict_min_version, '142.0');
  assert.equal(chromeManifest(m).browser_specific_settings, undefined);
});

test('Microsoft Edge: detected by its user agent; same package as Chrome with its own file name', () => {
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'), 'Edge');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'), 'Chrome');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0'), 'Firefox');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0.0.0'), 'Opera');
  assert.equal(packageName('1.2.3'), 'video-downloader-legal-chrome-1.2.3.zip');
  assert.equal(packageName('1.2.3', true), 'video-downloader-legal-edge-1.2.3.zip');
  const m = chromeManifest(JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')));
  assert.equal(m.minimum_chrome_version, '116', 'Edge 116 is Chromium 116: the Chrome minimum applies');
  assert.ok(m.permissions.includes('offscreen') && m.permissions.includes('declarativeNetRequest'), 'APIs that Edge implements since Edge 109');
});

test('packFolder: a real zip (also named .xpi) without any zip / tar tool; files at the root, "/" separators', () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/vdl-pack-`);
  const src = `${dir}/src`;
  try {
    fs.mkdirSync(`${src}/lib/sub`, { recursive: true });
    fs.writeFileSync(`${src}/manifest.json`, '{"a":1}');
    fs.writeFileSync(`${src}/lib/sub/x.js`, 'x'.repeat(5000));
    fs.writeFileSync(`${src}/icon.png`, Buffer.from([1, 2, 3]));
    const old = process.env.PATH;
    process.env.PATH = '';
    let ok;
    try { ok = packFolder(src, `${dir}/x.xpi`); } finally { process.env.PATH = old; }
    assert.equal(ok, true);
    const b = fs.readFileSync(`${dir}/x.xpi`);
    assert.equal(b.readUInt32LE(0), 0x04034b50, 'zip, not tar');
    const r = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("|".join(z.namelist()));print(z.read("lib/sub/x.js").decode()[:3])', `${dir}/x.xpi`], { encoding: 'utf8' });
    if (r.status === 0) assert.equal(r.stdout.trim(), 'icon.png|lib/sub/x.js|manifest.json\nxxx');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Firefox for Android: detection, guarded desktop-only APIs, touch layout, desktop-only settings', () => {
  const ua = 'Mozilla/5.0 (Android 14; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0';
  assert.equal(isAndroid(ua), true);
  assert.equal(isAndroid('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'), false);
  assert.equal(browserName(ua), 'Firefox Android');
  const main = fs.readFileSync(new URL('../service/main.js', import.meta.url), 'utf8');
  assert.ok(!/browser\.commands\.onCommand|browser\.notifications\.create/.test(main), 'unguarded call of an API Android does not have');
  const css = fs.readFileSync(new URL('../styles/ui.css', import.meta.url), 'utf8');
  assert.ok(css.includes('html.android body.popup') && css.includes('pointer: coarse'));
  const settings = fs.readFileSync(new URL('../content/settings.html', import.meta.url), 'utf8');
  for (const n of ['notifications', 'saveAs']) assert.match(settings, new RegExp(`data-desktop-only>\\s*<label class="check"><input type="checkbox" name="${n}"`));
});

test('settings page: the language change is compared with the language shown BEFORE load() overwrites it (page reloads after Save)', () => {
  const src = fs.readFileSync(new URL('../content/settings.js', import.meta.url), 'utf8');
  const submit = src.slice(src.indexOf("form.addEventListener('submit'"), src.indexOf('// "?" next to an option'));
  assert.ok(submit.indexOf('const langBefore = shownLang') >= 0 && submit.indexOf('const langBefore = shownLang') < submit.indexOf('await load()'));
  assert.ok(submit.includes('patch.uiLang !== langBefore') && !submit.includes('patch.uiLang !== shownLang'));
});

test('Firefox package name', async () => {
  const { ffName } = await import('../scripts/build-ff.mjs');
  assert.equal(ffName('1.2.3'), 'video-downloader-legal-ff-1.2.3.xpi');
});

test('VDL DEV manifest: own id, name and numeric version; source untouched', async () => {
  const { devManifest, DEV_ID, ffName } = await import('../scripts/build-ff.mjs');
  const m = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))));
  const d = devManifest(m, 7);
  assert.equal(d.browser_specific_settings.gecko.id, DEV_ID);
  assert.notEqual(DEV_ID, m.browser_specific_settings.gecko.id);
  assert.match(d.version, /^\d+\.\d+\.\d+\.7$/);
  assert.match(d.name, /DEV/);
  assert.equal(m.browser_specific_settings.gecko.id, 'video-downloader-legal@aspidovss');
  assert.equal(ffName('1.6.0dev3', true), 'video-downloader-legal-dev-1.6.0dev3.xpi');
});

test('VDL DEV for AMO: the build number only grows (AMO never takes a version twice)', async () => {
  const { nextDevNumber, PACKAGE_FILES } = await import('../scripts/build-amo-dev.mjs');
  assert.equal(nextDevNumber('1.6.0dev5', undefined), 5);
  assert.equal(nextDevNumber('1.6.0dev5', 5), 6); // rebuilt the same dev
  assert.equal(nextDevNumber('1.6.0dev5', 2), 5);
  assert.equal(nextDevNumber('1.6.0', 9), 10);
  assert.ok(PACKAGE_FILES.includes('manifest.json') && !PACKAGE_FILES.includes('tests'));
});
