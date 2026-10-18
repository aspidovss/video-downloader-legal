// Drives service/main.js with a fake `browser` object: detection -> manifest parsing -> download.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const listeners = {};
const mk = (name) => ({ addListener: (fn, ...rest) => { (listeners[name] ||= []).push({ fn, rest }); } });
const store = { local: { settings: { template: '{title}', ytCcOnly: false }, ccDefaultMigrated: true, consent: { version: 1, acceptedAt: 1760000000000 } }, session: {} }; // terms accepted unless a test says otherwise
const downloadsStarted = [];
const notifications = [];
const tabMessages = [];
const badges = [];

globalThis.browser = {
  storage: {
    local: { get: async (k) => (typeof k === 'string' ? { [k]: store.local[k] } : { ...store.local }), set: async (o) => Object.assign(store.local, o), remove: async (k) => { delete store.local[k]; } },
    session: { get: async (k) => ({ [k]: store.session[k] }), set: async (o) => Object.assign(store.session, o) },
    onChanged: mk('storage.onChanged'),
  },
  webRequest: { onHeadersReceived: mk('onHeadersReceived'), onBeforeRequest: mk('onBeforeRequest'), onBeforeSendHeaders: mk('onBeforeSendHeaders') },
  webNavigation: { onCommitted: mk('onCommitted') },
  tabs: { onRemoved: mk('tabs.onRemoved'), query: async () => [{ id: 1 }], sendMessage: async (id, msg, opts) => { tabMessages.push({ id, msg, opts }); return { ok: true }; } },
  runtime: {
    onMessage: mk('onMessage'), onInstalled: mk('onInstalled'), getManifest: () => ({ version: '1.4.2' }),
    sendMessage: async () => {}, getURL: (p) => `moz-extension://x/${p}`, getPlatformInfo: async () => ({}),
  },
  action: { setBadgeText: async (o) => badges.push(o), setBadgeBackgroundColor: async () => {} },
  commands: { onCommand: mk('command') },
  i18n: { getMessage: (k) => k, getUILanguage: () => 'en-US' },
  notifications: { create: async (o) => notifications.push(o) },
  downloads: {
    onChanged: mk('downloads.onChanged'),
    download: async (opts) => {
      const id = downloadsStarted.length + 1;
      downloadsStarted.push({ id, ...opts, blob: opts.url.startsWith('blob:') });
      // Complete shortly after start, like a real local download.
      setTimeout(() => listeners['downloads.onChanged'].forEach((l) => l.fn({ id, state: { current: 'complete' } })), 5);
      return id;
    },
    search: async ({ id }) => [{ id, state: 'in_progress' }],
  },
};

// Route fetch to fixtures.
const fixtures = {};
globalThis.fetch = async (url) => {
  if (!(url in fixtures)) return { ok: false, status: 404 };
  const body = fixtures[url];
  return {
    ok: true, status: 200,
    text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
  };
};
globalThis.crypto ??= webcrypto;

await import('../service/main.js');

const send = (msg, sender = { tab: { id: 1 } }) => listeners.onMessage[0].fn(msg, sender);
const headers = (o) => Object.entries(o).map(([name, value]) => ({ name, value: String(value) }));
const hit = (url, h, extra = {}) => listeners.onHeadersReceived[0].fn({ tabId: 1, statusCode: 200, url, responseHeaders: headers(h), ...extra });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('registers the webRequest listener with responseHeaders', () => {
  assert.deepEqual(listeners.onHeadersReceived[0].rest[1], ['responseHeaders']);
});

test('detects a direct mp4, ignores tiny files, segments, googlevideo', async () => {
  hit('https://cdn.example.com/video.mp4', { 'content-type': 'video/mp4', 'content-length': 5_000_000 });
  hit('https://cdn.example.com/tiny.mp4', { 'content-type': 'video/mp4', 'content-length': 2000 });
  hit('https://cdn.example.com/seg1.ts', { 'content-type': 'video/mp2t', 'content-length': 900000 });
  hit('https://rr1.googlevideo.com/videoplayback?x=1', { 'content-type': 'video/mp4', 'content-length': 9000000 });
  hit('https://cdn.example.com/page.html', { 'content-type': 'text/html' });
  hit('https://cdn.example.com/neg.mp4', { 'content-type': 'video/mp4' }, { tabId: -1 });
  await tick();
  const st = await send({ type: 'get_state', tabId: 1 });
  assert.deepEqual(st.items.map((i) => i.url), ['https://cdn.example.com/video.mp4']);
  assert.equal(st.items[0].size, 5_000_000);
  assert.equal(badges.at(-1).text, '1');
});

test('page_info supplies title and thumbnail used for naming', async () => {
  await send({ type: 'page_info', top: true, url: 'https://example.com/watch', title: 'My: Great Clip', thumbnail: 'https://example.com/t.jpg', videos: [] });
  const st = await send({ type: 'get_state', tabId: 1 });
  assert.equal(st.items[0].title, 'My: Great Clip');
  assert.equal(st.items[0].thumbnail, 'https://example.com/t.jpg');
});

test('direct file download uses downloads API with sanitized name, writes history', async () => {
  const st = await send({ type: 'get_state', tabId: 1 });
  const res = await send({ type: 'download', tabId: 1, itemId: st.items[0].id });
  assert.equal(res.ok, true);
  await tick(60);
  const d = downloadsStarted.at(-1);
  assert.equal(d.url, 'https://cdn.example.com/video.mp4');
  assert.equal(d.filename, 'My_ Great Clip.mp4');
  assert.equal(store.local.history.length, 1);
});

test('terms of use: without the consent downloads, the hotkey and the menu are refused with a notice; accepting (storage change) enables them', async () => {
  const st = await send({ type: 'get_state', tabId: 1 });
  const itemId = st.items[0].id;
  const before = downloadsStarted.length;
  const notes = notifications.length;
  const setConsent = async (v) => { if (v) store.local.consent = v; else delete store.local.consent; listeners['storage.onChanged'][0].fn({ consent: { newValue: v } }, 'local'); await tick(); };

  await setConsent(null); // never accepted / withdrawn in the options page
  const refused = await send({ type: 'download', tabId: 1, itemId });
  assert.deepEqual(refused, { ok: false, error: 'consent' });
  assert.equal(downloadsStarted.length, before);
  assert.equal(notifications.length, notes + 1);

  await listeners.command[0].fn('default-action');
  await tick(60);
  assert.equal(downloadsStarted.length, before, 'hotkey must not download without the consent');

  await setConsent({ version: 0, acceptedAt: 1 }); // an older wording is not enough
  assert.equal((await send({ type: 'download', tabId: 1, itemId })).error, 'consent');

  await setConsent({ version: 1, acceptedAt: Date.now() });
  assert.equal((await send({ type: 'download', tabId: 1, itemId })).ok, true);
  await tick(60);
  assert.equal(downloadsStarted.length, before + 1);
});

test('HLS master is parsed, children hidden, variant download joins decrypted segments', async () => {
  const keyBytes = webcrypto.getRandomValues(new Uint8Array(16));
  const ck = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  const { ivBytes } = await import('../lib/hls.js');
  const segs = ['one-', 'two-', 'three'];
  fixtures['https://h.io/master.m3u8'] = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\n360.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000,RESOLUTION=1280x720\n720.m3u8\n';
  fixtures['https://h.io/720.m3u8'] = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n' + segs.map((_, i) => `#EXTINF:4,\ns${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST';
  fixtures['https://h.io/k.bin'] = keyBytes.buffer.slice(0);
  for (let i = 0; i < segs.length; i++) fixtures[`https://h.io/s${i}.ts`] = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: ivBytes({ iv: null }, i) }, ck, new TextEncoder().encode(segs[i]));

  // The player requests the media playlist first; master arrives after and must absorb it.
  hit('https://h.io/720.m3u8', { 'content-type': 'application/vnd.apple.mpegurl' });
  hit('https://h.io/master.m3u8', { 'content-type': 'application/x-mpegURL' });
  await tick(80);
  let st = await send({ type: 'get_state', tabId: 1 });
  const master = st.items.find((i) => i.kind === 'hls');
  assert.ok(master?.master, 'master detected');
  assert.equal(st.items.filter((i) => i.kind === 'hls').length, 1, 'child playlist hidden');
  assert.deepEqual(master.variants.map((v) => v.label), ['720p', '360p', '720p', '360p']);
  assert.deepEqual(master.variants.map((v) => v.typeLabel), ['MP4', 'MP4', 'TS', 'TS'], 'TS stream: MP4 (default) and TS');

  // Captured blob contents.
  let captured;
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { captured = b; return origCreate(b); };
  const res = await send({ type: 'download', tabId: 1, itemId: master.id, variant: 0 });
  assert.equal(res.ok, true);
  await tick(200);
  URL.createObjectURL = origCreate;
  assert.equal(await captured.text(), 'one-two-three');
  const d = downloadsStarted.at(-1);
  assert.equal(d.blob, true);
  assert.match(d.filename, /\.ts$/);
  st = await send({ type: 'get_state', tabId: 1 });
  assert.equal(st.jobs.at(-1).state, 'done');
});

test('HLS with real TS segments is saved as .mp4 (own converter); the setting turns it off', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-bg-'));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'q%d.ts'), path.join(dir, 'p.m3u8')]);
  assert.equal(r.status, 0);
  const files = fs.readdirSync(dir).filter((x) => /^q\d+\.ts$/.test(x)).sort();
  fixtures['https://ts.example.com/p.m3u8'] = '#EXTM3U\n' + files.map((f) => `#EXTINF:2,\n${f}`).join('\n') + '\n#EXT-X-ENDLIST';
  for (const f of files) { const b = fs.readFileSync(path.join(dir, f)); fixtures[`https://ts.example.com/${f}`] = b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }
  hit('https://ts.example.com/p.m3u8', { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId: 13 });
  await tick(80);
  const st = await send({ type: 'get_state', tabId: 13 });
  const item = st.items.find((i) => i.kind === 'hls');
  assert.ok(item);
  let captured;
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { captured = b; return origCreate(b); };
  assert.equal((await send({ type: 'download', tabId: 13, itemId: item.id, variant: 0 })).ok, true);
  await tick(400);
  URL.createObjectURL = origCreate;
  assert.match(downloadsStarted.at(-1).filename, /\.mp4$/);
  assert.equal(captured.type, 'video/mp4');
  const head = new Uint8Array(await captured.slice(0, 12).arrayBuffer());
  assert.equal(String.fromCharCode(...head.slice(4, 8)), 'ftyp');
  // the second offered variant keeps the TS file
  const again = await send({ type: 'get_state', tabId: 13 });
  const sv = again.items.find((i) => i.kind === 'hls').variants;
  assert.deepEqual(sv.map((v) => v.typeLabel), ['MP4', 'TS']);
  assert.equal((await send({ type: 'download', tabId: 13, itemId: item.id, variant: 1 })).ok, true);
  await tick(400);
  assert.match(downloadsStarted.at(-1).filename, /\.ts$/);
});

test('TikTok: only the video on screen is offered, named after author and id; the promo clip is ignored; download saves an mp4', async () => {
  const hdr = { 'content-type': 'video/mp4', 'content-length': 3_000_000 };
  const A = 'https://v16-webapp-prime.tiktok.com/video/tos/alisg/tos-a/AAA/?sig=1';
  const B = 'https://v19-webapp-prime.tiktok.com/video/tos/alisg/tos-a/BBB/?sig=2';
  fixtures[B] = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]).buffer;
  const sender = { tab: { id: 21 } };
  hit('https://sf16-website-login.neutral.ttwstatic.com/obj/x/playback1.mp4', { 'content-type': 'video/mp4', 'content-length': 900000 }, { tabId: 21 });
  hit(A, hdr, { tabId: 21 });
  hit(B, hdr, { tabId: 21 });
  await tick(60);
  let st = await send({ type: 'get_state', tabId: 21 }, sender);
  assert.equal(st.items.some((i) => /ttwstatic/.test(i.url)), false, 'promo clip hidden');
  await send({ type: 'tiktok_media', url: 'https://www.tiktok.com/foryou', list: [{ key: '/video/tos/alisg/tos-a/AAA', id: '111', author: 'first', visible: false }, { key: '/video/tos/alisg/tos-a/BBB', id: '222', author: 'sec.ond', desc: 'Second caption', poster: 'https://p16.tiktokcdn.com/cover/b.jpg', visible: true }] }, sender);
  st = await send({ type: 'get_state', tabId: 21 }, sender);
  assert.equal(st.items.length, 2, 'the video on screen and the other one');
  assert.equal(st.items[0].url, B, 'the video on screen is first');
  assert.equal(st.items[0].secondary, false);
  assert.equal(st.items[1].secondary, true, 'other videos go under "More"');
  assert.match(st.items[0].title, /^tiktok_sec\.ond_222_\d{4}-\d\d-\d\d_/);
  assert.equal(st.items[0].caption, 'Second caption');
  assert.equal(st.items[0].thumbnail, 'https://p16.tiktokcdn.com/cover/b.jpg');
  // many preloaded videos: at most 5 others are kept
  for (let i = 0; i < 8; i++) hit(`https://v16-webapp-prime.tiktok.com/video/tos/alisg/tos-a/X${i}/?sig=${i}`, hdr, { tabId: 21 });
  await tick(60);
  st = await send({ type: 'get_state', tabId: 21 }, sender);
  assert.equal(st.items.length, 6, '1 on screen + 5 others');
  assert.equal(st.items[0].url, B);
  const res = await send({ type: 'download', tabId: 21, itemId: st.items[0].id }, sender);
  assert.equal(res.ok, true);
  await tick(300);
  const d = downloadsStarted.at(-1);
  assert.match(d.filename, /^tiktok_sec\.ond_222_.*\.mp4$/);
  assert.equal(d.blob, true);
});

test('TikTok: a video known only by its byte size (blob player) is matched by size; keys list works too', async () => {
  const hdr = (n) => ({ 'content-type': 'video/mp4', 'content-length': n });
  const sender = { tab: { id: 22 } };
  hit('https://v16-webapp-prime.tiktok.com/video/tos/x/one/?s=1', hdr(2_300_001), { tabId: 22 });
  hit('https://v16-webapp-prime.tiktok.com/video/tos/x/two/?s=2', hdr(1_100_002), { tabId: 22 });
  await tick(60);
  await send({ type: 'tiktok_media', url: 'https://www.tiktok.com/foryou', dbg: { videos: 2, blob: 2, fiber: 2 }, list: [
    { keys: [], sizes: [1_100_002], id: '555', author: 'neo', desc: 'Caption two', poster: 'https://p.tiktokcdn.com/c.jpg', visible: true },
    { keys: ['/video/tos/x/one'], sizes: [], id: '444', author: 'trin', desc: 'Caption one', poster: '', visible: false },
  ] }, sender);
  const st = await send({ type: 'get_state', tabId: 22 }, sender);
  assert.equal(st.items.length, 2);
  assert.equal(st.items[0].caption, 'Caption two');
  assert.equal(st.items[0].secondary, false);
  assert.equal(st.items[1].caption, 'Caption one');
  assert.equal(st.items[1].secondary, true);
});

test('DRM-protected HLS is flagged and download is refused', async () => {
  fixtures['https://h.io/drm.m3u8'] = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST';
  hit('https://h.io/drm.m3u8', { 'content-type': 'application/vnd.apple.mpegurl' });
  await tick(60);
  const st = await send({ type: 'get_state', tabId: 1 });
  const item = st.items.find((i) => i.url.endsWith('drm.m3u8'));
  assert.equal(item.protected, true);
  assert.deepEqual(await send({ type: 'download', tabId: 1, itemId: item.id }), { ok: false, error: 'drm' });
});

test('navigation clears detections for the tab', async () => {
  listeners.onCommitted[0].fn({ tabId: 1, frameId: 0, url: 'https://elsewhere.com/' });
  await tick();
  const st = await send({ type: 'get_state', tabId: 1 });
  assert.equal(st.items.length, 0);
});


// ------------------------------------------------------------- YouTube ----
const GV = 'https://rr1---sn-x.googlevideo.com/videoplayback';
const ytSender = { tab: { id: 2 } };
const ytSummary = (over = {}) => ({
  videoId: 'abcDEF12345', title: 'Clip: Test', author: 'A', lengthSeconds: 100, isLive: false, status: 'OK', sabr: false, license: 'standard', pageType: 'watch',
  thumbnail: 'https://i.ytimg.com/vi/abcDEF12345/hq.jpg',
  formats: [
    { itag: 18, mode: 'direct', url: `${GV}?itag=18&mime=video%2Fmp4&clen=11`, mime: 'video/mp4; codecs="avc1, mp4a"', label: '360p', h: 360, audio: true, adaptive: false, clen: 11 },
    { itag: 313, mode: 'cipher', mime: 'video/webm', label: '2160p', h: 2160, adaptive: true },
  ],
  ...over,
});
const gvHit = (query, method = 'GET') => listeners.onBeforeRequest[0].fn({ tabId: 2, method, url: `${GV}?${query}` });

test('YouTube: page summary becomes one item with downloadable variants; unsupported ones are excluded', async () => {
  await send({ type: 'yt_player', data: ytSummary() }, ytSender);
  const st = await send({ type: 'get_state', tabId: 2 }, ytSender);
  const it = st.items.find((i) => i.kind === 'yt');
  assert.ok(it);
  assert.equal(it.title, 'Clip: Test');
  assert.deepEqual(it.variants.map((v) => v.label), ['360p · MP4']);
  assert.equal(it.noteKey, '');
  assert.equal(JSON.stringify(st).includes('googlevideo'), false, 'no stream URLs leak to the popup');
  assert.equal(st.yt.videoKnown, true);
});

test('YouTube: captured player streams add variants; SABR POST is only counted', async () => {
  gvHit('itag=137&mime=video%2Fmp4&clen=24&dur=100.2&range=0-23&sig=A');
  gvHit('itag=140&mime=audio%2Fmp4&clen=12&dur=100.2&range=0-11&sig=B');
  gvHit('itag=251&mime=audio%2Fwebm&sabr=1', 'POST');
  await tick();
  const st = await send({ type: 'get_state', tabId: 2 }, ytSender);
  const it = st.items.find((i) => i.kind === 'yt');
  assert.deepEqual(it.variants.map((v) => v.label), ['1080p · MP4', '360p · MP4', 'Audio · M4A', 'Audio · MP3 128 kbps', 'Audio · MP3 192 kbps', 'Audio · MP3 256 kbps', 'Audio · MP3 320 kbps']);
  const { text } = await send({ type: 'yt_diagnostics', tabId: 2 }, ytSender);
  const rep = JSON.parse(text);
  assert.equal(rep.googlevideo.sabr, 1);
  assert.equal(rep.googlevideo.post, 1);
  assert.equal(text.includes('abcDEF12345'), false);
});

test('YouTube: downloading a video+audio variant fetches ranged chunks and saves two files', async () => {
  const bytes = { 137: Buffer.alloc(24, 'V'), 140: Buffer.alloc(12, 'A') };
  const seenRanges = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('googlevideo.com')) return prevFetch(url, opts);
    const u = new URL(url);
    assert.equal(opts.credentials, 'omit');
    const [a, b] = u.searchParams.get('range').split('-').map(Number);
    seenRanges.push(`${u.searchParams.get('itag')}:${a}-${b}`);
    const chunk = bytes[u.searchParams.get('itag')].subarray(a, b + 1);
    return { ok: true, status: 206, arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) };
  };
  const blobs = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return origCreate(b); };
  const before = downloadsStarted.length;
  const st = await send({ type: 'get_state', tabId: 2 }, ytSender);
  const it = st.items.find((i) => i.kind === 'yt');
  const res = await send({ type: 'download', tabId: 2, itemId: it.id, variant: 0, variantLabel: it.variants[0].label }, ytSender);
  assert.equal(res.ok, true);
  await tick(250);
  globalThis.fetch = prevFetch;
  URL.createObjectURL = origCreate;
  const started = downloadsStarted.slice(before);
  assert.deepEqual(started.map((d) => d.filename), ['Clip_ Test.mp4', 'Clip_ Test.audio.m4a']);
  assert.equal(await blobs[0].text(), 'V'.repeat(24));
  assert.equal(await blobs[1].text(), 'A'.repeat(12));
  assert.ok(seenRanges.includes('137:0-23') && seenRanges.includes('140:0-11'));
});

test('YouTube debug: falls back to a Range header when the query range is refused; reports statuses when everything fails', async () => {
  const prevFetch = globalThis.fetch;
  const calls = [];
  let mode = 'header-ok';
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('googlevideo.com')) return prevFetch(url, opts);
    const u = new URL(url);
    const viaQuery = u.searchParams.has('range');
    calls.push(viaQuery ? 'query' : `header:${opts.headers.Range}:${opts.credentials}`);
    if (mode === 'header-ok' && !viaQuery) {
      const buf = Buffer.alloc(12, 'x');
      return { ok: true, status: 206, headers: { get: () => '' }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    return { ok: false, status: 403, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const st = await send({ type: 'get_state', tabId: 2 }, ytSender);
  const it = st.items.find((i) => i.kind === 'yt');
  const before = downloadsStarted.length;
  await send({ type: 'download', tabId: 2, itemId: it.id, variant: 0, variantLabel: it.variants[0].label }, ytSender);
  await tick(300);
  assert.ok(calls.some((c) => c.startsWith('header:bytes=0-')), 'header strategy used');
  assert.ok(downloadsStarted.length > before, 'download completed through the fallback');

  mode = 'all-403';
  calls.length = 0;
  await send({ type: 'download', tabId: 2, itemId: it.id, variant: 0, variantLabel: it.variants[0].label }, ytSender);
  await tick(300);
  globalThis.fetch = prevFetch;
  const jobs = (await send({ type: 'get_state', tabId: 2 }, ytSender)).jobs;
  const failed = jobs.find((j) => j.state === 'error');
  assert.ok(failed, 'job failed');
  assert.match(failed.error, /HTTP 403/);
  assert.match(failed.error, /query-range:403/);
  assert.equal(failed.error.includes('googlevideo'), false, 'no URL in the message');

  const { text } = await send({ type: 'yt_diagnostics', tabId: 2 }, ytSender);
  const rep = JSON.parse(text);
  assert.equal(failed.errorKey, 'ytDirectBlocked');
  assert.ok(rep.download.attempts.length >= 3);
  assert.ok(Array.isArray(rep.download.urlShape[0].params) && rep.download.urlShape[0].params.includes('itag'));
  assert.equal(text.includes('abcDEF12345'), false);
});

test('YouTube: Creative-Commons-only setting blocks other licences, allows cc', async () => {
  store.local.settings = { ytCcOnly: true, template: '{title}' };
  listeners['storage.onChanged'][0].fn({ settings: { newValue: { ytCcOnly: true, template: '{title}' } } }, 'local');
  await tick();
  let st = await send({ type: 'get_state', tabId: 2 }, ytSender);
  let it = st.items.find((i) => i.kind === 'yt');
  assert.equal(it.noteKey, 'ytCcBlocked');
  assert.deepEqual(await send({ type: 'download', tabId: 2, itemId: it.id, variant: 0 }, ytSender), { ok: false, error: 'ytCcBlocked' });
  await send({ type: 'yt_player', data: ytSummary({ license: 'cc' }) }, ytSender);
  st = await send({ type: 'get_state', tabId: 2 }, ytSender);
  assert.equal(st.items.find((i) => i.kind === 'yt').noteKey, '');
  assert.equal(store.local.ccOffAt, undefined, 'still on: no date');
  listeners['storage.onChanged'][0].fn({ settings: { oldValue: { ytCcOnly: true }, newValue: { ytCcOnly: false, template: '{title}' } } }, 'local');
  await tick();
  assert.ok(store.local.ccOffAt > 0, 'switching it off records the date');
  listeners['storage.onChanged'][0].fn({ settings: { oldValue: { ytCcOnly: false }, newValue: { ytCcOnly: false, template: '{title}' } } }, 'local');
  const keep = store.local.ccOffAt;
  await tick();
  assert.equal(store.local.ccOffAt, keep, 'unrelated changes keep the first date');
});

test('YouTube: SABR-only video shows the explanatory note; a new video replaces the old item', async () => {
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'zzzNEW12345', sabr: true, formats: [{ itag: 18, mode: 'none', mime: 'video/mp4', adaptive: false }] }) }, ytSender);
  await tick(60);
  const st = await send({ type: 'get_state', tabId: 2 }, ytSender);
  const yts = st.items.filter((i) => i.kind === 'yt');
  assert.equal(yts.length, 1);
  assert.equal(yts[0].noteKey, 'ytNone');
});


test('YouTube recording: start arms the tab; status updates show on the item; save sends file names; history written once', async () => {
  store.local.settings = { ytRecordSpeed: 3, template: '{title}', ytCcOnly: false }; // ytRecordUi is off by default
  listeners['storage.onChanged'][0].fn({ settings: { newValue: store.local.settings } }, 'local');
  await send({ type: 'yt_player', data: ytSummary({ sabr: true, formats: [] }) }, ytSender);
  await tick(60);
  let st = await send({ type: 'get_state', tabId: 2 }, ytSender);
  let it = st.items.find((i) => i.kind === 'yt');
  assert.equal(it.noteKey, 'ytNone');
  assert.equal(it.rec, null);
  assert.equal(st.prefs.ytRecordUi, false);

  // option off: recording a regular video is refused in the background too (live streams are not affected)
  const sent = tabMessages.length;
  assert.deepEqual(await send({ type: 'yt_rec', tabId: 2, cmd: 'start' }, ytSender), { ok: false, error: 'rec_disabled' });
  assert.equal(tabMessages.length, sent);
  store.local.settings = { ytRecordSpeed: 3, template: '{title}', ytCcOnly: false, ytRecordUi: true };
  listeners['storage.onChanged'][0].fn({ settings: { newValue: store.local.settings } }, 'local');
  assert.equal((await send({ type: 'get_state', tabId: 2 }, ytSender)).prefs.ytRecordUi, true);

  assert.deepEqual(await send({ type: 'yt_rec', tabId: 2, cmd: 'start' }, ytSender), { ok: true });
  const startMsg = tabMessages.at(-1);
  assert.equal(startMsg.id, 2);
  assert.deepEqual(startMsg.opts, { frameId: 0 });
  assert.equal(startMsg.msg.cmd, 'start');
  assert.equal(startMsg.msg.speed, 3);

  const tracks = [
    { kind: 'video', ext: 'webm', height: 720, fragments: 10, bytes: 5_000_000 },
    { kind: 'audio', ext: 'weba', height: 0, fragments: 10, bytes: 400_000 },
    { kind: 'video', ext: '<script>', height: 0, fragments: 1, bytes: 1 },
  ];
  await send({ type: 'yt_rec_status', state: { state: 'recording', progress: 0.5, bytes: 5_400_000, tracks: tracks.slice(0, 2) } }, ytSender);
  st = await send({ type: 'get_state', tabId: 2 }, ytSender);
  it = st.items.find((i) => i.kind === 'yt');
  assert.equal(it.rec.state, 'recording');
  assert.equal(it.rec.progress, 0.5);

  await send({ type: 'yt_rec_status', state: { state: 'done', progress: 1, bytes: 5_400_000, tracks } }, ytSender);
  assert.equal((await send({ type: 'get_state', tabId: 2 }, ytSender)).items.find((i) => i.kind === 'yt').rec.tracks[2].ext, 'mp4', 'unknown extension sanitized');
  await tick();
  assert.equal(tabMessages.filter((m) => m.msg.cmd === 'save').length, 1, 'a recording that ended by itself is saved automatically (once)');

  await send({ type: 'yt_rec_status', state: { state: 'done', progress: 1, tracks: tracks.slice(0, 2) } }, ytSender);
  assert.equal(tabMessages.filter((m) => m.msg.cmd === 'save').length, 1, 'no second automatic save');
  await send({ type: 'yt_rec', tabId: 2, cmd: 'save' }, ytSender);
  const saveMsg = tabMessages.at(-1).msg;
  assert.equal(saveMsg.cmd, 'save');
  assert.deepEqual(saveMsg.names, ['Clip_ Test.webm', 'Clip_ Test.audio.weba']);

  const before = store.local.history.length;
  const saved = { state: 'saved', tracks: tracks.slice(0, 2) };
  await send({ type: 'yt_rec_status', state: saved }, ytSender);
  await send({ type: 'yt_rec_status', state: saved }, ytSender);
  assert.equal(store.local.history.length, before + 1, 'history entry added exactly once');
  assert.equal(store.local.history[0].kind, 'yt');
});

test('YouTube recording: status from a page whose summary has not arrived yet is kept', async () => {
  await send({ type: 'yt_rec_status', state: { state: 'recording', progress: 0.1, tracks: [] } }, { tab: { id: 9 } });
  const st = await send({ type: 'get_state', tabId: 9 }, { tab: { id: 9 } });
  assert.equal(st.yt.videoKnown, false);
  await send({ type: 'yt_player', data: ytSummary() }, { tab: { id: 9 } });
  const it = (await send({ type: 'get_state', tabId: 9 }, { tab: { id: 9 } })).items.find((i) => i.kind === 'yt');
  assert.equal(it.rec.state, 'recording');
});

test('YouTube recording: audio-only save sends a single audio file name', async () => {
  const sender = { tab: { id: 12 } };
  await send({ type: 'yt_player', data: ytSummary() }, sender);
  await send({ type: 'yt_rec_status', state: { state: 'done', tracks: [{ kind: 'video', ext: 'webm', height: 720, fragments: 3, bytes: 9 }, { kind: 'audio', ext: 'weba', height: 0, fragments: 3, bytes: 4 }] } }, sender);
  assert.deepEqual(await send({ type: 'yt_rec', tabId: 12, cmd: 'save_audio' }, sender), { ok: true });
  const m = tabMessages.at(-1).msg;
  assert.equal(m.only, 'audio');
  assert.deepEqual(m.names, ['Clip_ Test.weba']);
  await send({ type: 'yt_rec_status', state: { state: 'done', tracks: [{ kind: 'video', ext: 'webm', height: 720, fragments: 3, bytes: 9 }] } }, sender);
  assert.equal((await send({ type: 'yt_rec', tabId: 12, cmd: 'save_audio' }, sender)).ok, false);
});


test('YouTube recording: AV1 + Opus is saved as .mp4 by default (Telegram: video), .mkv by the setting', async () => {
  const sender = { tab: { id: 13 } };
  await send({ type: 'yt_player', data: ytSummary() }, sender);
  const tr = [{ kind: 'video', ext: 'mp4', height: 720, fragments: 3, bytes: 9 }, { kind: 'audio', ext: 'weba', height: 0, fragments: 3, bytes: 4 }];
  await send({ type: 'yt_rec_status', state: { state: 'recording', tracks: tr } }, sender);
  await send({ type: 'yt_rec', tabId: 13, cmd: 'save' }, sender);
  assert.deepEqual(tabMessages.at(-1).msg.names, ['Clip_ Test.mp4', 'Clip_ Test.audio.weba']); // the recorder joins into the first name
  const prev = store.local.settings;
  store.local.settings = { ...prev, joinFormat: 'mkv' };
  listeners['storage.onChanged'][0].fn({ settings: { newValue: store.local.settings } }, 'local');
  await send({ type: 'yt_rec', tabId: 13, cmd: 'save' }, sender);
  assert.deepEqual(tabMessages.at(-1).msg.names, ['Clip_ Test.mkv', 'Clip_ Test.audio.weba']);
  store.local.settings = prev;
  listeners['storage.onChanged'][0].fn({ settings: { newValue: prev } }, 'local');
});

// ---- mobile-client API (main way) ----
const apiJson = (extra = {}) => ({
  playabilityStatus: { status: 'OK' },
  videoDetails: { title: 'API Clip', lengthSeconds: '60' },
  streamingData: {
    adaptiveFormats: [
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', qualityLabel: '1080p', height: 1080, width: 1920, fps: 30, bitrate: 4e6, contentLength: '100', url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&c=ANDROID_VR&expire=9999999999&sig=SECRET' },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: '50', url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=140&c=ANDROID_VR&expire=9999999999&sig=SECRET' },
      { itag: 22, mimeType: 'video/mp4', url: 'https://evil.example.com/steal?x=1' },
    ],
    ...extra,
  },
});

test('YouTube API: mobile-client formats become variants, replace page links, spoof UA only for our own requests', async () => {
  const prevFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/youtubei/v1/player')) {
      const body = JSON.parse(opts.body);
      seen.push({ client: body.context.client.clientName, hdr: opts.headers['X-YouTube-Client-Name'], credentials: opts.credentials });
      return { ok: true, status: 200, json: async () => apiJson() };
    }
    if (String(url).includes('googlevideo.com') && String(url).includes('range=')) return { ok: true, status: 206 };
    return prevFetch(url, opts);
  };
  const sender = { tab: { id: 31 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'apiVid12345', sabr: true, formats: [] }) }, sender);
  await tick(80);
  globalThis.fetch = prevFetch;
  assert.equal(seen[0].client, 'VISIONOS', 'client order');
  assert.equal(seen[0].hdr, '101');
  assert.equal(seen[0].credentials, 'omit');
  assert.equal(seen.length, 1, 'stops after the first client that works');
  const it = (await send({ type: 'get_state', tabId: 31 }, sender)).items.find((i) => i.kind === 'yt');
  assert.equal(it.noteKey, '');
  assert.deepEqual(it.variants.map((v) => v.label), ['1080p · MP4', 'Audio · M4A 130 kbps', 'Audio · MP3 128 kbps', 'Audio · MP3 192 kbps', 'Audio · MP3 256 kbps', 'Audio · MP3 320 kbps'], 'foreign host dropped');

  // header hook: only requests made by the extension itself (tabId -1) get the UA
  const hook = listeners.onBeforeSendHeaders[0].fn;
  const own = hook({ tabId: -1, originUrl: 'moz-extension://x/service/main.js', url: 'https://rr1---sn-abc.googlevideo.com/videoplayback', requestHeaders: [{ name: 'User-Agent', value: 'Firefox' }, { name: 'Origin', value: 'moz-extension://x' }] });
  assert.match(own.requestHeaders.find((h) => h.name === 'User-Agent').value, /Safari/, 'VISIONOS UA');
  assert.equal(own.requestHeaders.find((h) => h.name === 'Origin').value, 'https://www.youtube.com', 'Origin on googlevideo');
  assert.equal(own.requestHeaders.find((h) => h.name === 'Referer').value, 'https://www.youtube.com/');
  assert.equal(own.requestHeaders.find((h) => h.name === 'DNT').value, '1');
  assert.deepEqual(hook({ tabId: 5, url: 'https://rr1---sn-abc.googlevideo.com/videoplayback', requestHeaders: [] }), {}, 'page requests untouched');

  const { text } = await send({ type: 'yt_diagnostics', tabId: 31 }, sender);
  const rep = JSON.parse(text);
  assert.equal(rep.api.client, 'VISIONOS');
  assert.equal(rep.api.mode, 'none', 'no cookies, no visitorData');
  assert.equal(rep.api.log[0].status, 200);
  assert.equal('auth' in rep.api, false);
  assert.ok(rep.api.log[0].params.includes('sig'));
  assert.equal(text.includes('SECRET'), false, 'no URL values in diagnostics');
});

test('YouTube API: falls through to the next client, uses its HLS when there are no https formats, reports failures', async () => {
  const prevFetch = globalThis.fetch;
  const order = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/youtubei/v1/player')) {
      const name = JSON.parse(opts.body).context.client.clientName;
      order.push(name);
      if (name !== 'IOS') return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ playabilityStatus: { status: 'OK' }, videoDetails: { title: 'T' }, streamingData: { hlsManifestUrl: 'https://manifest.googlevideo.com/api/manifest/hls_variant/x/index.m3u8' } }) };
    }
    return prevFetch(url, opts);
  };
  const sender = { tab: { id: 32 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'hlsVid12345', sabr: true, formats: [] }) }, sender);
  await tick(80);
  globalThis.fetch = prevFetch;
  assert.deepEqual(order, ['VISIONOS', 'ANDROID_VR', 'IOS', 'IOS'], 'no session data available: plain pass only; IOS and IOS_VDL both send clientName IOS');
  const st = await send({ type: 'get_state', tabId: 32 }, sender);
  assert.ok(st.items.some((i) => i.kind === 'hls' && i.source === 'youtube-api'), 'HLS item added');
  const rep = JSON.parse((await send({ type: 'yt_diagnostics', tabId: 32 }, sender)).text);
  assert.equal(rep.api.log[2].hls, true);
  assert.equal(rep.api.log[0].status, 403);
});

test('YouTube API: the setting can switch it off', async () => {
  store.local.settings = { ytApi: false, template: '{title}', ytCcOnly: false };
  listeners['storage.onChanged'][0].fn({ settings: { newValue: { ytApi: false, template: '{title}', ytCcOnly: false } } }, 'local');
  await tick();
  let called = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { if (String(url).includes('/youtubei/')) called++; return prevFetch(url, o); };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'offVid123456', sabr: true, formats: [] }) }, { tab: { id: 33 } });
  await tick(50);
  globalThis.fetch = prevFetch;
  store.local.settings = { template: '{title}', ytCcOnly: false };
  listeners['storage.onChanged'][0].fn({ settings: { newValue: { template: '{title}', ytCcOnly: false } } }, 'local');
  assert.equal(called, 0);
});

test('YouTube API: downloaded video + audio are joined into ONE playable mp4', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-bg-'));
  const run = (...a) => assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]).status, 0);
  const frag = 'frag_keyframe+empty_moov+default_base_moof';
  run('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-movflags', frag, path.join(dir, 'v.mp4'));
  run('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:a', 'aac', '-movflags', frag, path.join(dir, 'a.m4a'));
  const files = { 137: fs.readFileSync(path.join(dir, 'v.mp4')), 140: fs.readFileSync(path.join(dir, 'a.m4a')) };

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.includes('/youtubei/v1/player')) {
      return { ok: true, status: 200, json: async () => apiJson({ adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', qualityLabel: '1080p', height: 1080, bitrate: 4e6, contentLength: String(files[137].length), url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&c=ANDROID_VR' },
        { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: String(files[140].length), url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=140&c=ANDROID_VR' },
      ] }) };
    }
    if (u.hostname.endsWith('googlevideo.com')) {
      const [a, b] = u.searchParams.get('range').split('-').map(Number);
      const chunk = files[u.searchParams.get('itag')].subarray(a, b + 1);
      return { ok: true, status: 206, headers: { get: () => '' }, arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) };
    }
    return prevFetch(url, opts);
  };
  const blobs = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return origCreate(b); };
  const sender = { tab: { id: 41 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'mergeVid123', sabr: true, formats: [] }) }, sender);
  await tick(80);
  const it = (await send({ type: 'get_state', tabId: 41 }, sender)).items.find((i) => i.kind === 'yt');
  const before = downloadsStarted.length;
  assert.equal((await send({ type: 'download', tabId: 41, itemId: it.id, variant: 0, variantLabel: it.variants[0].label }, sender)).ok, true);
  await tick(500);
  globalThis.fetch = prevFetch;
  URL.createObjectURL = origCreate;

  const started = downloadsStarted.slice(before);
  assert.deepEqual(started.map((d) => d.filename), ['Clip_ Test.mp4'], 'one merged file');
  const out = path.join(dir, 'out.mp4');
  fs.writeFileSync(out, Buffer.from(await blobs.at(-1).arrayBuffer()));
  const streams = String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).stdout).trim().split(/\s+/).sort().join(',');
  assert.equal(streams, 'audio,video');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']).status, 0, 'decodes');
});


// ---- client probe (does the client's URL work beyond the first megabytes?) ----
const bigApi = (client) => ({
  playabilityStatus: { status: 'OK' },
  videoDetails: { title: 'Big', lengthSeconds: '600' },
  streamingData: { adaptiveFormats: [
    { itag: 137, mimeType: 'video/mp4; codecs="avc1"', qualityLabel: '1080p', height: 1080, bitrate: 4e6, contentLength: String(100 * 1024 * 1024), url: `https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&c=${client}` },
    { itag: 134, mimeType: 'video/mp4; codecs="avc1"', qualityLabel: '360p', height: 360, bitrate: 6e5, contentLength: String(19 * 1024 * 1024), url: `https://rr1---sn-abc.googlevideo.com/videoplayback?itag=134&c=${client}` },
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a"', bitrate: 130000, contentLength: String(4 * 1024 * 1024), url: `https://rr1---sn-abc.googlevideo.com/videoplayback?itag=140&c=${client}` },
  ] },
});

function stubClients(limitedClients) {
  const prev = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.includes('/youtubei/v1/player')) {
      const name = JSON.parse(opts.body).context.client.clientName;
      asked.push(name);
      return { ok: true, status: 200, json: async () => bigApi(name) };
    }
    if (u.hostname.endsWith('googlevideo.com') && u.searchParams.has('range')) {
      const off = Number(u.searchParams.get('range').split('-')[0]);
      const limited = limitedClients.includes(u.searchParams.get('c'));
      return { ok: !(limited && off >= 20 * 1024 * 1024), status: limited && off >= 20 * 1024 * 1024 ? 403 : 206 };
    }
    return prev(url, opts);
  };
  return { asked, restore: () => { globalThis.fetch = prev; } };
}

test('YouTube download test: walks real tracks, reports where YouTube starts refusing', async () => {
  const prevFetch = globalThis.fetch;
  const sender = { tab: { id: 62 } };
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/youtubei/v1/player')) return { ok: true, status: 200, json: async () => apiJson({ adaptiveFormats: [
      { itag: 303, mimeType: 'video/webm; codecs="vp9"', qualityLabel: '1080p', height: 1080, width: 1920, bitrate: 4e6, contentLength: String(50 * 1024 * 1024), url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=303&c=IOS&expire=9999999999&sig=S' },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: String(3 * 1024 * 1024), url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=140&c=IOS&expire=9999999999&sig=S' },
    ] }) };
    return prevFetch(url, opts);
  };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'testVid12345', sabr: true, formats: [] }) }, sender);
  await tick(80);
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const start = Number(u.searchParams.get('range').split('-')[0]);
    calls.push({ start, cpn: u.searchParams.get('cpn') });
    if (start >= 20 * 1024 * 1024) return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1024) };
  };
  const r = await send({ type: 'yt_test', tabId: 62 }, sender);
  globalThis.fetch = prevFetch;
  assert.equal(r.ok, true);
  const rep = JSON.parse((await send({ type: 'yt_diagnostics', tabId: 62 }, sender)).text);
  assert.equal(rep.test.state, 'done');
  const webm = rep.test.results.find((x) => x.plan === 'webm 5MiB seq');
  assert.equal(webm.firstFailMiB, 20, 'first refused offset reported');
  assert.equal(webm.itag, 303);
  assert.ok(rep.test.results.some((x) => x.plan === 'audio 1MiB seq' && x.firstFailMiB === null));
  assert.ok(new Set(calls.map((c) => c.cpn)).size > 2, 'new-cpn plan used different cpns');
});

const swData = () => {
  const m = new Array(110).fill(null);
  m[0] = 'en'; m[1] = 'US'; m[3] = '1.2.3.4'; m[13] = 'VISITORDATAxyz'; m[17] = 'Windows'; m[18] = '10.0'; m[79] = 'Asia/Yekaterinburg';
  m[86] = 'Firefox'; m[87] = '157.0'; m[11] = ''; m[12] = ''; m[61] = ['x', 'INSTALLDATA']; m[103] = '1'; m[107] = 'ROLLOUT';
  return ")]}\'" + JSON.stringify([[null, null, [[m], 'APIKEY123']]]);
};

test('YouTube API: the session pass (sw.js_data) gets VISIONOS links; IOS formats are not preferred', async () => {
  const prevFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/sw.js_data')) return { ok: true, status: 200, text: async () => swData() };
    if (String(url).includes('/youtubei/v1/player')) {
      const body = JSON.parse(opts.body);
      const name = body.context.client.clientName;
      calls.push({ name, vd: body.context.client.visitorData, hdrVd: opts.headers['X-Goog-Visitor-Id'], cred: opts.credentials, key: new URL(url).searchParams.get('key'), cfg: body.context.client.configInfo, browser: body.context.client.browserName });
      if (name === 'VISIONOS' && body.context.client.visitorData) return { ok: true, status: 200, json: async () => apiJson() };
      if (name === 'IOS') return { ok: true, status: 200, json: async () => apiJson() };
      return { ok: true, status: 200, json: async () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } }) };
    }
    return prevFetch(url, opts);
  };
  const sender = { tab: { id: 71 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'visVid123456', sabr: true, formats: [] }) }, sender);
  await tick(100);
  globalThis.fetch = prevFetch;
  const rep = JSON.parse((await send({ type: 'yt_diagnostics', tabId: 71 }, sender)).text);
  assert.equal(rep.api.client, 'VISIONOS');
  assert.equal(rep.api.mode, 'session');
  assert.equal(rep.api.session, 'ok');
  assert.equal(calls[0].vd, 'VISITORDATAxyz');
  assert.equal(calls[0].hdrVd, 'VISITORDATAxyz');
  assert.equal(calls[0].cred, 'include');
  assert.equal(calls[0].key, 'APIKEY123');
  assert.equal(calls[0].cfg, undefined, 'configInfo is web-only');
  assert.equal(calls[0].browser, undefined);
  assert.equal(calls.length, 1, 'stops at the first client with links');
  assert.equal(JSON.stringify(rep).includes('VISITORDATA'), false, 'visitor data not exported');
});

test('YouTube API: when only IOS answers, its formats are still offered (marked iosOnly)', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/youtubei/v1/player')) {
      const name = JSON.parse(opts.body).context.client.clientName;
      if (name === 'IOS') return { ok: true, status: 200, json: async () => apiJson() };
      return { ok: true, status: 200, json: async () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } }) };
    }
    return prevFetch(url, opts);
  };
  const sender = { tab: { id: 72 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'iosOnly12345', sabr: true, formats: [] }) }, sender);
  await tick(120);
  globalThis.fetch = prevFetch;
  const rep = JSON.parse((await send({ type: 'yt_diagnostics', tabId: 72 }, sender)).text);
  assert.equal(rep.api.client, 'IOS');
  assert.ok(rep.api.formats > 0);
});

test('parseSwData: pulls visitorData and install data out of the JSPB, rejects anything else', async () => {
  const { parseSwData } = await import('../lib/ytapi.js');
  const r = parseSwData(swData());
  assert.equal(r.visitorData, 'VISITORDATAxyz');
  assert.equal(r.appInstallData, 'INSTALLDATA');
  assert.equal(r.apiKey, 'APIKEY123');
  assert.equal(parseSwData('<html>'), null);
  assert.equal(parseSwData(")]}'[]"), null);
});

test('YouTube method 2: the page-made /player answer replaces the formats and downloads through the normal pipeline; no visitor data exported', async () => {
  const prevSend = globalThis.browser.tabs.sendMessage;
  const sent = [];
  globalThis.browser.tabs.sendMessage = async (id, msg, opts) => {
    sent.push({ id, msg, opts });
    if (msg.type === 'yt_page_api') {
      return { id: 1, session: 'ok', results: [
        { client: 'VISIONOS', status: 200, error: '', json: apiJson() },
      ] };
    }
    return { ok: true };
  };
  const sender = { tab: { id: 91 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'pageVid12345', sabr: true, formats: [] }) }, sender);
  await tick(100);
  const r = await send({ type: 'yt_page_download', tabId: 91 }, sender);
  globalThis.browser.tabs.sendMessage = prevSend;
  assert.equal(r.ok, true);
  assert.equal(r.client, 'VISIONOS');
  const call = sent.find((x) => x.msg.type === 'yt_page_api');
  assert.equal(call.opts.frameId, 0);
  assert.equal(call.msg.videoId, 'pageVid12345');
  assert.deepEqual(call.msg.clients.map((c) => c.key), ['VISIONOS', 'ANDROID_VR', 'IOS', 'IOS_VDL']);
  const rep = JSON.parse((await send({ type: 'yt_diagnostics', tabId: 91 }, sender)).text);
  assert.equal(rep.api.mode, 'page');
  assert.equal(rep.apiPage.client, 'VISIONOS');
  assert.equal(rep.apiPage.session, 'ok');
  assert.ok(rep.apiPage.formats > 0);
  assert.equal(JSON.stringify(rep).includes('googlevideo.com'), false, 'no media URLs exported');
});

test('YouTube method 2: reports failure when the page gave nothing or the script is missing', async () => {
  const prevSend = globalThis.browser.tabs.sendMessage;
  globalThis.browser.tabs.sendMessage = async () => ({ id: 1, session: 'ok', results: [{ client: 'VISIONOS', status: 200, json: { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } } }] });
  const sender = { tab: { id: 92 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'pageNone1234', sabr: true, formats: [] }) }, sender);
  await tick(100);
  const r1 = await send({ type: 'yt_page_download', tabId: 92 }, sender);
  globalThis.browser.tabs.sendMessage = async () => { throw new Error('no receiver'); };
  const r2 = await send({ type: 'yt_page_download', tabId: 92 }, sender);
  globalThis.browser.tabs.sendMessage = prevSend;
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'none');
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'no_page');
});

const setSettings = async (v) => { store.local.settings = { template: '{title}', ytCcOnly: false, ...v }; listeners['storage.onChanged'][0].fn({ settings: { newValue: store.local.settings } }, 'local'); await tick(); };

async function methodRun(method, pageWorks, id, vid) {
  await setSettings({ ytMethod: method });
  const prevSend = globalThis.browser.tabs.sendMessage;
  const prevFetch = globalThis.fetch;
  const seen = { page: 0, bg: 0 };
  globalThis.browser.tabs.sendMessage = async (_i, msg) => {
    if (msg.type !== 'yt_page_api') return { ok: true };
    seen.page++;
    return pageWorks ? { id: 1, session: 'ok', results: [{ client: 'VISIONOS', status: 200, json: apiJson() }] } : { id: 1, session: 'ok', results: [{ client: 'VISIONOS', status: 200, json: { playabilityStatus: { status: 'LOGIN_REQUIRED' } } }] };
  };
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('/sw.js_data')) { seen.bg++; return { ok: true, status: 200, text: async () => swData() }; }
    if (String(url).includes('/youtubei/')) { seen.bg++; return { ok: true, status: 200, json: async () => apiJson() }; }
    return prevFetch(url, o);
  };
  const sender = { tab: { id } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: vid, sabr: true, formats: [] }) }, sender);
  await tick(150);
  globalThis.browser.tabs.sendMessage = prevSend;
  globalThis.fetch = prevFetch;
  const rep = JSON.parse((await send({ type: 'yt_diagnostics', tabId: id }, sender)).text);
  await setSettings({});
  return { seen, rep };
}

test('YouTube method setting: auto = page first, no background request when the page works', async () => {
  const { seen, rep } = await methodRun('auto', true, 101, 'autoOk123456');
  assert.equal(seen.page, 1);
  assert.equal(seen.bg, 0);
  assert.equal(rep.api.mode, 'page');
});

test('YouTube method setting: auto falls back to the background when the page gives nothing', async () => {
  const { seen, rep } = await methodRun('auto', false, 102, 'autoFb123456');
  assert.equal(seen.page, 1);
  assert.ok(seen.bg > 0);
  assert.equal(rep.api.mode, 'session');
  assert.equal(rep.api.fellBack, true);
});

test('YouTube method setting: page-only never uses the background; background-only never asks the page', async () => {
  const a = await methodRun('page', false, 103, 'pageOnly1234');
  assert.equal(a.seen.bg, 0);
  assert.equal(a.rep.api.done, true);
  assert.equal(a.rep.api.formats, 0);
  const b = await methodRun('background', true, 104, 'bgOnly123456');
  assert.equal(b.seen.page, 0);
  assert.equal(b.rep.api.mode, 'session');
});

test('Bug button: runs the test, tells the user to wait, saves a diagnostics .json to downloads, state is exposed to the popup', async () => {
  await setSettings({ notifications: false }); // the bug notifications are always shown
  const sender = { tab: { id: 111 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'bugVid123456', sabr: true, formats: [] }) }, sender);
  await tick(100);
  const nBefore = notifications.length;
  const dBefore = downloadsStarted.length;
  const r = await send({ type: 'yt_bug', tabId: 111 }, sender);
  assert.equal(r.ok, true);
  assert.match(r.file, /^vdl-diagnostics-bugVid123456-\d{8}-\d{6}\.json$/);
  const d = downloadsStarted[dBefore];
  assert.equal(d.filename, r.file);
  assert.equal(d.saveAs, false);
  assert.equal(d.blob, true);
  const msgs = notifications.slice(nBefore).map((n) => n.message);
  assert.equal(msgs[0], 'bugNotifStart');
  assert.ok(msgs[1].startsWith('bugNotifDone'));
  const st = await send({ type: 'get_state', tabId: 111 }, sender);
  assert.equal(st.bug.state, 'done');
  assert.equal(st.bug.file, r.file);
  assert.equal(st.bug.text, undefined, 'the big text is not sent with every state refresh');
  const bt = await send({ type: 'bug_text', tabId: 111 }, sender);
  assert.equal(JSON.parse(bt.text).extension !== undefined, true, 'full JSON available for the popup');
  await setSettings({});
});

test('Fallback visibility data: item reports apiState (loading/ok/failed) and dlFailed after a failed download', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => (String(url).includes('/sw.js_data') || String(url).includes('/youtubei/') ? { ok: false, status: 500, text: async () => '', json: async () => ({}) } : prevFetch(url, o));
  const prevSend = globalThis.browser.tabs.sendMessage;
  globalThis.browser.tabs.sendMessage = async (_i, m) => (m.type === 'yt_page_api' ? { id: 1, session: 'bad:500', results: [] } : { ok: true });
  const sender = { tab: { id: 112 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'noLinks12345', sabr: true, formats: [] }) }, sender);
  await tick(150);
  const st = await send({ type: 'get_state', tabId: 112 }, sender);
  globalThis.browser.tabs.sendMessage = prevSend;
  globalThis.fetch = prevFetch;
  const it = st.items.find((x) => x.kind === 'yt');
  assert.equal(it.apiState, 'failed');
  assert.equal(it.dlFailed, false);
});

import { DOMParser as TestDOMParser } from './helpers/xml.js';

const dashSetup = async (tabId, base) => {
  globalThis.DOMParser = TestDOMParser;
  fixtures[`${base}/m.mpd`] = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S">
 <BaseURL>${base}/</BaseURL>
 <Period>
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <SegmentTemplate timescale="1000" duration="10000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/s$Number$.m4s"/>
   <Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01e"/>
   <Representation id="v2" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
   <SegmentTemplate timescale="1000" duration="10000" initialization="a/init.mp4" media="a/$Number$.m4s"/>
   <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
  </AdaptationSet>
 </Period>
</MPD>`;
  for (const f of ['v1/init.mp4', 'v1/s1.m4s', 'v1/s2.m4s', 'v2/init.mp4', 'v2/s1.m4s', 'v2/s2.m4s', 'a/init.mp4', 'a/1.m4s', 'a/2.m4s']) fixtures[`${base}/${f}`] = `<${f}>`;
  listeners.onHeadersReceived[0].fn({ tabId, statusCode: 200, url: `${base}/m.mpd`, responseHeaders: headers({ 'content-type': 'application/dash+xml' }) });
  await tick(80);
  const st = await send({ type: 'get_state', tabId }, { tab: { id: tabId } });
  return st.items.find((i) => i.kind === 'dash');
};

test('DASH item: variants carry type, resolution and an estimated size; the separate audio track is offered as MP3 / M4A', async () => {
  const it = await dashSetup(120, 'https://d1.example.com');
  assert.deepEqual(it.variants.map((v) => v.label), ['720p', '360p']);
  assert.equal(it.variants[0].type, 'mp4');
  assert.equal(it.variants[0].size, Math.round((2400000 + 128000) * 20 / 8), 'bandwidth x duration, video + audio');
  assert.equal(it.variants[0].sizeEstimated, true);
  const mp3 = it.audioVariants.filter((a) => a.mp3);
  assert.deepEqual(mp3.map((a) => a.kbps), [128, 192, 256, 320]);
  assert.equal(mp3[0].size, 320000);
  const m4a = it.audioVariants.find((a) => a.atype === 'm4a');
  assert.equal(m4a.kbps, 128);
  assert.equal(m4a.size, 320000);
});

test('DASH audio only: downloads just the audio track and saves it as .m4a', async () => {
  const it = await dashSetup(121, 'https://d2.example.com');
  const before = downloadsStarted.length;
  let captured;
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { captured = b; return origCreate(b); };
  const a = it.audioVariants.find((x) => x.atype === 'm4a');
  const res = await send({ type: 'download', tabId: 121, itemId: it.id, variant: 0, audio: { rep: a.rep, mp3: false, kbps: a.kbps } }, { tab: { id: 121 } });
  assert.equal(res.ok, true);
  await tick(250);
  URL.createObjectURL = origCreate;
  assert.equal(downloadsStarted.length - before, 1, 'one file only');
  assert.match(downloadsStarted.at(-1).filename, /\.m4a$/);
  assert.equal(await captured.text(), '<a/init.mp4><a/1.m4s><a/2.m4s>');
});

test('DASH video + audio (one file per representation, like VK) are joined into ONE file that has both tracks', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-dashmerge-'));
  const ff = (...a) => assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]).status, 0);
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', path.join(dir, 'v.mp4'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', path.join(dir, 'a.m4a'));
  const ab = (f) => { const b = fs.readFileSync(path.join(dir, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const base = 'https://d9.example.com';
  globalThis.DOMParser = TestDOMParser;
  fixtures[`${base}/m.mpd`] = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT3S"><Period>
   <AdaptationSet mimeType="video/mp4" contentType="video"><Representation id="v" bandwidth="900000" width="320" height="240" codecs="avc1.4d401e"><BaseURL>${base}/v.mp4</BaseURL><SegmentBase indexRange="0-1"/></Representation></AdaptationSet>
   <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en"><Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"><BaseURL>${base}/a.m4a</BaseURL><SegmentBase indexRange="0-1"/></Representation></AdaptationSet></Period></MPD>`;
  fixtures[`${base}/v.mp4`] = ab('v.mp4');
  fixtures[`${base}/a.m4a`] = ab('a.m4a');
  listeners.onHeadersReceived[0].fn({ tabId: 130, statusCode: 200, url: `${base}/m.mpd`, responseHeaders: headers({ 'content-type': 'application/dash+xml' }) });
  await tick(80);
  const it = (await send({ type: 'get_state', tabId: 130 }, { tab: { id: 130 } })).items.find((i) => i.kind === 'dash');
  assert.equal(it.variants.length, 1);
  let captured;
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { captured = b; return origCreate(b); };
  const before = downloadsStarted.length;
  const res = await send({ type: 'download', tabId: 130, itemId: it.id, variant: 0 }, { tab: { id: 130 } });
  assert.equal(res.ok, true);
  await tick(400);
  URL.createObjectURL = origCreate;
  assert.equal(downloadsStarted.length - before, 1, 'ONE file, not video and audio apart');
  assert.match(downloadsStarted.at(-1).filename, /\.mp4$/);
  const out = path.join(dir, 'out.mp4');
  fs.writeFileSync(out, Buffer.from(await captured.arrayBuffer()));
  const streams = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', out]).stdout).streams.map((s) => s.codec_type).sort();
  assert.deepEqual(streams, ['audio', 'video']);
});

test('Finished download job exposes the browser download id (Open file / folder) and can be dismissed with the cross', async () => {
  const it = await dashSetup(140, 'https://d4.example.com');
  const a = it.audioVariants.find((x) => x.atype === 'm4a');
  const before = downloadsStarted.length;
  await send({ type: 'download', tabId: 140, itemId: it.id, variant: 0, audio: { rep: a.rep, mp3: false, kbps: a.kbps } }, { tab: { id: 140 } });
  await tick(250);
  const st = await send({ type: 'get_state', tabId: 140 }, { tab: { id: 140 } });
  const job = st.jobs.at(-1);
  assert.equal(job.state, 'done');
  assert.equal(job.downloadId, downloadsStarted[before].id);
  await send({ type: 'dismiss_job', jobId: job.id, tabId: 140 }, { tab: { id: 140 } });
  const st2 = await send({ type: 'get_state', tabId: 140 }, { tab: { id: 140 } });
  assert.equal(st2.jobs.some((j) => j.id === job.id), false);
});

test('Finished jobs disappear from the popup state after a minute', async () => {
  const st0 = await send({ type: 'get_state', tabId: 121 }, { tab: { id: 121 } });
  assert.ok(st0.jobs.some((j) => j.state === 'done'));
  const realNow = Date.now;
  Date.now = () => realNow() + 61000;
  const st1 = await send({ type: 'get_state', tabId: 121 }, { tab: { id: 121 } });
  Date.now = realNow;
  assert.equal(st1.jobs.some((j) => j.state === 'done'), false);
});

test('Bug button on a non-YouTube page: saves a masked site diagnostics file (no query values, no cookies)', async () => {
  const it = await dashSetup(122, 'https://d3.example.com/path/secrettokenAAAAAAAAAAAAAAAAAAAAAAAA');
  fixtures['https://d3.example.com/path/secrettokenAAAAAAAAAAAAAAAAAAAAAAAA/m.mpd?token=SECRET123'] = fixtures['https://d3.example.com/path/secrettokenAAAAAAAAAAAAAAAAAAAAAAAA/m.mpd'];
  await send({ type: 'page_info', top: true, url: 'https://d3.example.com/watch?v=1&token=SECRET', title: 'T', videos: [] }, { tab: { id: 122 } });
  const prevCreate = URL.createObjectURL;
  let blob;
  URL.createObjectURL = (b) => { blob = b; return prevCreate(b); };
  const dBefore = downloadsStarted.length;
  const r = await send({ type: 'bug', tabId: 122 }, { tab: { id: 122 } });
  URL.createObjectURL = prevCreate;
  assert.equal(r.ok, true);
  assert.match(r.file, /^vdl-diagnostics-d3\.example\.com-\d{8}-\d{6}\.json$/);
  assert.equal(downloadsStarted[dBefore].filename, r.file);
  const text = await blob.text();
  assert.equal(text.includes('SECRET'), false, 'query values never exported');
  const rep = JSON.parse(text);
  assert.equal(rep.fullUrls, false);
  const dash = rep.items.find((x) => x.kind === 'dash');
  assert.equal(dash.videos, 2);
  assert.equal(dash.audios, 1);
  assert.equal(dash.firstVideoPart.status, 200);
  const st = await send({ type: 'get_state', tabId: 122 }, { tab: { id: 122 } });
  assert.equal(st.bug.state, 'done');
  assert.equal(st.bug.site, 'd3.example.com');
});

test('Instagram: page-data manifest becomes ONE DASH item (current post only); sniffed fragments are ignored', async () => {
  globalThis.DOMParser = TestDOMParser;
  const xml = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S"><Period>
   <AdaptationSet mimeType="video/mp4" contentType="video"><Representation id="v" bandwidth="1000000" width="720" height="1280" codecs="avc1.4d401e"><BaseURL>https://ig.cdninstagram.com/v.mp4</BaseURL><SegmentBase indexRange="0-1"/></Representation></AdaptationSet>
   <AdaptationSet mimeType="audio/mp4" contentType="audio"><Representation id="a" bandwidth="96000" codecs="mp4a.40.2"><BaseURL>https://ig.cdninstagram.com/a.m4a</BaseURL><SegmentBase indexRange="0-1"/></Representation></AdaptationSet></Period></MPD>`;
  const dataUrl = (x) => `data:text/plain;charset=UTF-8,${encodeURIComponent(x)}`;
  fixtures[dataUrl(xml)] = xml;
  const sender = { tab: { id: 150 } };
  // a sniffed fragment from the Instagram page itself must be ignored
  listeners.onHeadersReceived[0].fn({ tabId: 150, statusCode: 200, url: 'https://ig.cdninstagram.com/frag.mp4?bytestart=0&byteend=999', documentUrl: 'https://www.instagram.com/reels/AAA/', responseHeaders: headers({ 'content-type': 'video/mp4', 'content-length': '900000' }) });
  listeners.onHeadersReceived[0].fn({ tabId: 150, statusCode: 200, url: 'https://ig.cdninstagram.com/other.mp4', documentUrl: 'https://www.instagram.com/reels/AAA/', responseHeaders: headers({ 'content-type': 'video/mp4', 'content-length': '900000' }) });
  await send({ type: 'ig_media', url: 'https://www.instagram.com/reels/AAA/', title: 'A on Instagram', manifests: [xml], versions: [] }, sender);
  await tick(80);
  let st = await send({ type: 'get_state', tabId: 150 }, sender);
  assert.equal(st.items.length, 1);
  assert.equal(st.items[0].kind, 'dash');
  assert.ok(st.items[0].variants[0].label);
  assert.equal(st.items[0].hasAudioTrack, true);
  // SPA navigation to the next reel replaces the item
  const xml2 = xml.replace('PT10S', 'PT20S');
  fixtures[dataUrl(xml2)] = xml2;
  await send({ type: 'ig_media', url: 'https://www.instagram.com/reels/BBB/', title: 'B', manifests: [xml2], versions: [] }, sender);
  await tick(80);
  st = await send({ type: 'get_state', tabId: 150 }, sender);
  assert.equal(st.items.length, 1);
  assert.equal(st.items[0].duration, 20);
});

test('Instagram: without a manifest the plain mp4 versions are offered, best first', async () => {
  const sender = { tab: { id: 151 } };
  await send({ type: 'ig_media', url: 'https://www.instagram.com/p/CCC/', title: 'C', manifests: [], versions: [
    { url: 'https://ig.cdninstagram.com/low.mp4', width: 360, height: 640 }, { url: 'https://ig.cdninstagram.com/hi.mp4', width: 720, height: 1280 }] }, sender);
  const st = await send({ type: 'get_state', tabId: 151 }, sender);
  assert.deepEqual(st.items.map((i) => i.quality).sort(), ['1280p', '640p']);
  assert.ok(st.items.every((i) => i.kind === 'file'));
});

test('release manifest: no cookies permission, version_name marks the release candidate, data collection declared as none', async () => {
  const { readFileSync } = await import('node:fs');
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.permissions.includes('cookies'), false);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(m.browser_specific_settings.gecko.data_collection_permissions.required, ['none']);
});

test('YouTube: variants carry sizes; audio-only variants (M4A, MP3 with an estimate) are flagged; MP3 is disabled without the encoder', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/youtubei/v1/player')) return { ok: true, status: 200, json: async () => apiJson({ adaptiveFormats: [
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', qualityLabel: '1080p', height: 1080, width: 1920, bitrate: 4e6, contentLength: '118000000', url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&c=IOS&expire=9999999999&sig=S' },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: '4300000', url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=140&c=IOS&expire=9999999999&sig=S' },
    ] }) };
    return prevFetch(url, opts);
  };
  const sender = { tab: { id: 81 } };
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'sizeVid12345', sabr: true, formats: [], lengthSeconds: 269 }) }, sender);
  await tick(100);
  globalThis.fetch = prevFetch;
  const it = (await send({ type: 'get_state', tabId: 81 }, sender)).items.find((i) => i.kind === 'yt');
  const by = (l) => it.variants.find((v) => v.label === l || (l === 'Audio · M4A' && v.atype === 'm4a') || (l === 'Audio · MP3' && v.mp3 && v.kbps === 192));
  assert.equal(by('1080p · MP4').size, 118000000 + 4300000);
  assert.equal(by('1080p · MP4').audio, false);
  assert.equal(by('Audio · M4A').audio, true);
  assert.equal(by('Audio · M4A').size, 4300000);
  assert.equal(by('Audio · MP3').mp3, true);
  assert.equal(by('Audio · MP3').sizeEstimated, true);
  assert.equal(by('Audio · MP3').size, 6456000, '269 s at the default 192 kbps');
  assert.equal(by('Audio · MP3').unavailable, true, 'no vendor/lame.js in the test environment');
  assert.equal(JSON.stringify(it).includes('googlevideo'), false);
});

async function mp3Setup(tabId, videoId) {
  const prevFetch = globalThis.fetch;
  const audio = new Uint8Array(40000).fill(7);
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.includes('/youtubei/v1/player')) {
      return { ok: true, status: 200, json: async () => apiJson({ adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', qualityLabel: '1080p', height: 1080, bitrate: 4e6, contentLength: '1000', url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&c=VISIONOS' },
        { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: String(audio.length), url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=140&c=VISIONOS' },
      ] }) };
    }
    if (u.hostname.endsWith('googlevideo.com')) {
      const [a, b] = u.searchParams.get('range').split('-').map(Number);
      const chunk = audio.subarray(a, b + 1);
      return { ok: true, status: 206, headers: { get: () => '' }, arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) };
    }
    return prevFetch(url, opts);
  };
  const sender = { tab: { id: tabId } };
  await send({ type: 'yt_player', data: ytSummary({ videoId, sabr: true, formats: [] }) }, sender);
  await tick(80);
  const it = (await send({ type: 'get_state', tabId }, sender)).items.find((i) => i.kind === 'yt');
  return { sender, it, restore: () => { globalThis.fetch = prevFetch; } };
}

test('YouTube audio-only MP3: downloads the audio track, decodes it, encodes with the encoder and saves <title>.mp3 with an ID3 title', async () => {
  const calls = [];
  globalThis.lamejs = { Mp3Encoder: class { constructor(ch, rate, kbps) { calls.push([ch, rate, kbps]); }
    encodeBuffer() { return Uint8Array.of(0xff, 0xfb, 1); } flush() { return Uint8Array.of(0xff, 0xfb, 2); } } };
  globalThis.OfflineAudioContext = class { decodeAudioData(ab) { calls.push(['decode', ab.byteLength]); return Promise.resolve({ numberOfChannels: 2, sampleRate: 44100, duration: 2, getChannelData: () => new Float32Array(88200) }); } };
  const { sender, it, restore } = await mp3Setup(91, 'mp3Vid123456');
  const blobs = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return origCreate(b); };
  const before = downloadsStarted.length;
  const idx = it.variants.findIndex((v) => v.mp3 && v.kbps === 192);
  assert.equal(it.variants[idx].unavailable, false, 'encoder present');
  assert.equal((await send({ type: 'download', tabId: 91, itemId: it.id, variant: idx, variantLabel: it.variants[idx].label }, sender)).ok, true);
  await tick(400);
  restore();
  URL.createObjectURL = origCreate;
  delete globalThis.lamejs;
  delete globalThis.OfflineAudioContext;
  assert.deepEqual(downloadsStarted.slice(before).map((d) => d.filename), ['Clip_ Test.mp3']);
  assert.deepEqual(calls[0], ['decode', 40000], 'the whole audio track was downloaded and decoded');
  assert.deepEqual(calls[1], [2, 44100, 192]);
  const out = new Uint8Array(await blobs.at(-1).arrayBuffer());
  assert.equal(blobs.at(-1).type, 'audio/mpeg');
  assert.equal(String.fromCharCode(...out.slice(0, 3)), 'ID3');
  assert.deepEqual([...out.slice(-3)], [0xff, 0xfb, 2]);
});

test('YouTube audio-only MP3: without the encoder the job fails with a clear key and nothing is saved', async () => {
  delete globalThis.lamejs;
  const { sender, it, restore } = await mp3Setup(92, 'mp3Miss12345');
  const before = downloadsStarted.length;
  const idx = it.variants.findIndex((v) => v.mp3 && v.kbps === 192);
  assert.equal(it.variants[idx].unavailable, true);
  await send({ type: 'download', tabId: 92, itemId: it.id, variant: idx, variantLabel: it.variants[idx].label }, sender);
  await tick(300);
  restore();
  const job = (await send({ type: 'get_state', tabId: 92 }, sender)).jobs.filter((j) => j.state === 'error').at(-1);
  assert.equal(job.errorKey, 'mp3Missing');
  assert.equal(downloadsStarted.length, before);
});

test('YouTube audio-only M4A: saves the raw audio track as <title>.m4a without conversion', async () => {
  const { sender, it, restore } = await mp3Setup(93, 'm4aVid123456');
  const before = downloadsStarted.length;
  const idx = it.variants.findIndex((v) => v.atype === 'm4a');
  await send({ type: 'download', tabId: 93, itemId: it.id, variant: idx, variantLabel: it.variants[idx].label }, sender);
  await tick(300);
  restore();
  assert.deepEqual(downloadsStarted.slice(before).map((d) => d.filename), ['Clip_ Test.m4a']);
});

test('LIVE HLS: a live stream offers recording; Stop saves what was captured as one file', async () => {
  let polls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === 'https://live.io/live.m3u8') {
      polls++;
      const segs = [0, 1, 2].map((i) => i + Math.max(0, polls - 1)); // window slides by one per poll
      return { ok: true, status: 200, text: async () => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${segs[0]}\n${segs.map((n) => `#EXTINF:0.2,\ns${n}.ts`).join('\n')}\n` };
    }
    const m = /s(\d+)\.ts$/.exec(url);
    if (m) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(`<${m[1]}>`).buffer };
    return origFetch(url);
  };
  hit('https://live.io/live.m3u8', { 'content-type': 'application/vnd.apple.mpegurl' });
  await tick(80);
  let st = await send({ type: 'get_state', tabId: 1 });
  const item = st.items.find((i) => i.url === 'https://live.io/live.m3u8');
  assert.equal(item.live, true);
  const res = await send({ type: 'download', tabId: 1, itemId: item.id });
  assert.equal(res.ok, true);
  await tick(1400);
  st = await send({ type: 'get_state', tabId: 1 });
  const job = st.jobs.at(-1);
  assert.equal(job.recording, true); assert.ok(job.segments >= 3, `segments ${job.segments}`);
  let captured;
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { captured = b; return origCreate(b); };
  await send({ type: 'stop_job', jobId: job.id });
  await tick(300);
  URL.createObjectURL = origCreate;
  globalThis.fetch = origFetch;
  st = await send({ type: 'get_state', tabId: 1 });
  assert.equal(st.jobs.at(-1).state, 'done');
  const txt = await captured.text();
  assert.match(txt, /^<1><2><3><4>/);
  assert.match(downloadsStarted.at(-1).filename, /\.ts$/);
});

test('LIVE HLS master: duplicate (backup CDN) variants are merged; variants show format and data rate per minute', async () => {
  fixtures['https://dw.io/master.m3u8'] = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\nhi/p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\nhi-b/p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=960x540\nlo/p.m3u8\n';
  fixtures['https://dw.io/hi/p.m3u8'] = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n';
  hit('https://dw.io/master.m3u8', { 'content-type': 'application/x-mpegURL' });
  await tick(120);
  const st = await send({ type: 'get_state', tabId: 1 });
  const it = st.items.find((i) => i.url === 'https://dw.io/master.m3u8');
  assert.equal(it.live, true);
  assert.equal(it.variants.length, 4, 'duplicate removed (2 qualities x MP4/TS)');
  assert.equal(it.variants[0].typeLabel, 'MP4');
  assert.equal(it.variants[2].typeLabel, 'TS');
  assert.equal(it.variants[0].perMin, true);
  assert.equal(it.variants[0].size, 45000000); // 6 Mbit/s = 0.75 MB/s = 45 MB per minute
});

test('Twitch: quality playlists the player fetches are hidden behind the usher master; 60 fps is labelled; file is named after the channel', async () => {
  fixtures['https://usher.ttvnw.net/api/v2/channel/hls/somechan.m3u8?p=1'] = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.000\nhttps://euw1.playlist.ttvnw.net/v1/playlist/A.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,FRAME-RATE=60.000\nhttps://euw1.playlist.ttvnw.net/v1/playlist/B.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2300000,RESOLUTION=1280x720,FRAME-RATE=30.000\nhttps://euw1.playlist.ttvnw.net/v1/playlist/C.m3u8\n';
  fixtures['https://euw1.playlist.ttvnw.net/v1/playlist/A.m3u8'] = '#EXTM3U\n#EXTINF:2,\nx.ts\n';
  fixtures['https://euw1.playlist.ttvnw.net/v1/playlist/Z.m3u8'] = '#EXTM3U\n#EXTINF:2,\nx.ts\n';
  hit('https://usher.ttvnw.net/api/v2/channel/hls/somechan.m3u8?p=1', { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId: 7 });
  hit('https://euw1.playlist.ttvnw.net/v1/playlist/Z.m3u8', { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId: 7 });
  await tick(120);
  const st = await send({ type: 'get_state', tabId: 7 });
  const hls = st.items.filter((i) => i.kind === 'hls');
  assert.equal(hls.length, 1, 'only the master is listed');
  assert.match(hls[0].title, /^twitch_somechan_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/);
  assert.deepEqual(hls[0].variants.map((v) => v.label), ['1080p60', '720p60', '720p', '1080p60', '720p60', '720p']);
});

test('Twitch SPA switch: after moving to another channel the old channel master is not offered until the new one appears', async () => {
  const hdr = { 'content-type': 'application/vnd.apple.mpegurl' };
  fixtures['https://usher.ttvnw.net/api/v2/channel/hls/oldchan.m3u8?p=1'] = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080\nhttps://euw1.playlist.ttvnw.net/v1/playlist/O.m3u8\n';
  fixtures['https://usher.ttvnw.net/api/v2/channel/hls/newchan.m3u8?p=1'] = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080\nhttps://euw1.playlist.ttvnw.net/v1/playlist/N.m3u8\n';
  const sender = { tab: { id: 8 } };
  await send({ type: 'page_info', top: true, url: 'https://www.twitch.tv/oldchan', title: 't', videos: [] }, sender);
  hit('https://usher.ttvnw.net/api/v2/channel/hls/oldchan.m3u8?p=1', hdr, { tabId: 8 });
  await tick(120);
  let st = await send({ type: 'get_state', tabId: 8 });
  assert.equal(st.items.filter((i) => i.kind === 'hls').length, 1);
  await tick(5);
  await send({ type: 'page_info', top: true, url: 'https://www.twitch.tv/newchan', title: 't', videos: [] }, sender);
  st = await send({ type: 'get_state', tabId: 8 });
  assert.equal(st.items.filter((i) => i.kind === 'hls').length, 0, 'old channel is hidden');
  hit('https://usher.ttvnw.net/api/v2/channel/hls/newchan.m3u8?p=1', hdr, { tabId: 8 });
  await tick(120);
  st = await send({ type: 'get_state', tabId: 8 });
  const hls = st.items.filter((i) => i.kind === 'hls');
  assert.equal(hls.length, 1);
  assert.match(hls[0].title, /^twitch_newchan_/);
});

test('YouTube live (beta): shown as a yt item that is recorded from the player (no HLS item, no plain download)', async () => {
  const hls = 'https://manifest.googlevideo.com/api/manifest/hls_variant/id/abc.m3u8';
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'liveVID12345', isLive: true, hls, formats: [] }) }, { tab: { id: 91 } });
  await tick(60);
  const st = await send({ type: 'get_state', tabId: 91 }, { tab: { id: 91 } });
  assert.equal(st.items.filter((i) => i.kind === 'hls').length, 0);
  const y = st.items.find((i) => i.kind === 'yt');
  assert.ok(y);
  assert.equal(y.live, true);
  assert.equal(y.beta, true);
  assert.equal(y.noteKey, '');
});

test('YouTube: home/feed pages are ignored', async () => {
  await send({ type: 'yt_player', data: ytSummary({ videoId: 'homeVID12345', pageType: '' }) }, { tab: { id: 193 } });
  await tick(30);
  const st = await send({ type: 'get_state', tabId: 193 }, { tab: { id: 193 } });
  assert.equal(st.items.length, 0);
});

test('debug log: off by default; when on it records detections and downloads with shortened links, no titles; off again stops it', async () => {
  const change = async (patch) => {
    const oldValue = store.local.settings;
    store.local.settings = { ...oldValue, ...patch };
    listeners['storage.onChanged'][0].fn({ settings: { oldValue, newValue: store.local.settings } }, 'local');
    await tick(20);
  };
  hit('https://cdn.example.com/before.mp4', { 'content-type': 'video/mp4', 'content-length': 5_000_000 });
  await tick(400);
  assert.equal(store.local.debugLog, undefined, 'nothing is written while the option is off');

  await change({ debugLog: true });
  hit('https://cdn.example.com/secret.mp4?token=SECRETVALUE&sig=abc', { 'content-type': 'video/mp4', 'content-length': 6_000_000 });
  await tick(30);
  const st = await send({ type: 'get_state', tabId: 1 });
  const it = st.items.find((i) => i.url.includes('secret.mp4'));
  await send({ type: 'download', tabId: 1, itemId: it.id });
  await tick(500);
  const text = JSON.stringify(store.local.debugLog || []);
  assert.match(text, /"g":"detect"/);
  assert.match(text, /"g":"download"/);
  assert.match(text, /"g":"settings"/);
  assert.match(text, /token&sig/, 'only parameter names are kept');
  assert.doesNotMatch(text, /SECRETVALUE/);

  // the bug button on a normal site: its result is added to the log too
  await send({ type: 'bug', tabId: 1 });
  await tick(500);
  assert.match(JSON.stringify(store.local.debugLog), /"g":"test"/);
  assert.match(JSON.stringify(store.local.debugLog), /auto-diagnostics saved/);

  await change({ debugLog: false });
  await tick(400);
  const n = store.local.debugLog.length;
  hit('https://cdn.example.com/after.mp4', { 'content-type': 'video/mp4', 'content-length': 7_000_000 });
  await tick(400);
  assert.equal(store.local.debugLog.length, n, 'nothing is written after switching off');
});

test('YouTube subtitles: the card lists the tracks; SRT saves <title>.<lang>.srt; "+ with video" (when ticked) adds the .srt; the settings switch them off', async () => {
  const tabId = 97;
  const TT = 'https://www.youtube.com/api/timedtext?v=subVid123456&lang=en';
  const audio = new Uint8Array(40000).fill(7);
  const prevFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/api/timedtext') {
      asked.push(u.searchParams.get('fmt'));
      return { ok: true, status: 200, text: async () => JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: 'Hi there' }] }] }) };
    }
    if (u.pathname.includes('/youtubei/v1/player')) {
      return { ok: true, status: 200, json: async () => ({ ...apiJson({ adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', qualityLabel: '1080p', height: 1080, bitrate: 4e6, contentLength: '1000', url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&c=VISIONOS' },
        { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: String(audio.length), url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?itag=140&c=VISIONOS' },
      ] }), captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: TT, name: { simpleText: 'English' }, languageCode: 'en', isTranslatable: true }], translationLanguages: [] } } }) };
    }
    if (u.hostname.endsWith('googlevideo.com')) {
      const [a, b] = u.searchParams.get('range').split('-').map(Number);
      const chunk = audio.subarray(a, b + 1);
      return { ok: true, status: 206, headers: { get: () => '' }, arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) };
    }
    return prevFetch(url, opts);
  };
  try {
    const sender = { tab: { id: tabId } };
    await send({ type: 'yt_player', data: ytSummary({ videoId: 'subVid123456', sabr: true, formats: [] }) }, sender);
    await tick(80);
    const it = (await send({ type: 'get_state', tabId }, sender)).items.find((i) => i.kind === 'yt');
    assert.deepEqual(it.subs.map((s) => [s.id, s.lang, s.label]), [['t0', 'en', 'English']]);
    const before = downloadsStarted.length;
    const r = await send({ type: 'yt_subs', tabId, itemId: it.id, choice: 't0' }, sender);
    assert.equal(r.ok, true);
    assert.deepEqual(downloadsStarted.slice(before).map((d) => d.filename), ['Clip_ Test.en.srt']);
    assert.ok(asked.includes('json3'));
    // with the video (here an audio-only m4a track stands in for a single-file download): .srt next to it
    const idx = it.variants.findIndex((v) => v.atype === 'm4a');
    const prev = store.local.settings;
    const setS = (o) => { store.local.settings = { ...prev, ...o }; listeners['storage.onChanged'][0].fn({ settings: { newValue: store.local.settings } }, 'local'); };
    const dl = async (extra) => {
      const b = downloadsStarted.length;
      await send({ type: 'download', tabId, itemId: it.id, variant: idx, variantLabel: it.variants[idx].label, ...extra }, sender);
      await tick(300);
      return downloadsStarted.slice(b).map((d) => d.filename);
    };
    try {
      assert.deepEqual(await dl({ subs: 't0' }), ['Clip_ Test.m4a'], '"+ with video" not ticked: only the video');
      setS({ subsWithVideo: true });
      assert.equal((await send({ type: 'get_state', tabId }, sender)).prefs.subsWithVideo, true);
      assert.deepEqual(await dl({ subs: 't0' }), ['Clip_ Test.m4a', 'Clip_ Test.en.srt']);
      assert.deepEqual(await dl({}), ['Clip_ Test.m4a', 'Clip_ Test.en.srt'], 'a hotkey (no choice sent) takes the default track');
      // subtitles off in the settings: no row, no SRT, nothing with the video even when ticked
      setS({ subsWithVideo: true, subs: false });
      const off = await send({ type: 'get_state', tabId }, sender);
      assert.equal(off.prefs.subs, false);
      assert.deepEqual(off.items.find((i) => i.kind === 'yt').subs, []);
      assert.deepEqual(await send({ type: 'yt_subs', tabId, itemId: it.id, choice: 't0' }, sender), { ok: false, error: 'subsOff' });
      assert.deepEqual(await dl({ subs: 't0' }), ['Clip_ Test.m4a']);
      setS({ subsSrt: false });
      const p2 = (await send({ type: 'get_state', tabId }, sender)).prefs;
      assert.deepEqual([p2.subs, p2.subsSrt], [true, false]);
    } finally { store.local.settings = prev; listeners['storage.onChanged'][0].fn({ settings: { newValue: prev } }, 'local'); }
  } finally { globalThis.fetch = prevFetch; }
});

test('LL-HLS: the same playlist asked with new _HLS_msn / _HLS_part is one entry', async () => {
  const P = 'https://ll.example.com/live/chunklist_0.m3u8';
  fixtures[`${P}?session=s1`] = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:2,\na.ts\n';
  for (let n = 0; n < 6; n++) hit(`${P}?session=s1&_HLS_msn=${100 + n}&_HLS_part=${n % 3}`, { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId: 41 });
  await tick(120);
  const hls = (await send({ type: 'get_state', tabId: 41 })).items.filter((i) => i.kind === 'hls');
  assert.equal(hls.length, 1);
  assert.equal(hls[0].url, `${P}?session=s1`, 'kept without the LL-HLS parameters');
});

test('HLS: separate video and audio playlists without a readable master become one entry with qualities and sound', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-synth-'));
  const mk = (name, args) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, '-t', '4', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', `${name}_init.mp4`, '-hls_segment_filename', `${name}_%d.m4s`, `chunklist_${name}.m3u8`], { cwd: dir }); // run inside dir: on Windows the init file otherwise lands in the current folder
    assert.equal(r.status, 0, String(r.stderr));
  };
  mk('0_video', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-an']);
  mk('1_video', ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-an']);
  mk('5_audio', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'aac', '-vn']);
  const B = 'https://edge.example.net/v1/streams/origin.abc/';
  for (const f of fs.readdirSync(dir)) { const b = fs.readFileSync(path.join(dir, f)); fixtures[B + f] = f.endsWith('.m3u8') ? b.toString() : b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }
  const tabId = 42;
  const pl = { 'content-type': 'application/vnd.apple.mpegurl' };
  hit(`${B}llhls.m3u8?token=one-time`, pl, { tabId }); // the master: refused on a second request (no fixture -> 404)
  for (const name of ['0_video', '5_audio', '1_video']) {
    for (let n = 0; n < 3; n++) hit(`${B}chunklist_${name}.m3u8?_HLS_msn=${10 + n}&_HLS_part=${n}`, pl, { tabId });
  }
  await tick(400);
  const st = await send({ type: 'get_state', tabId });
  const hls = st.items.filter((i) => i.kind === 'hls');
  const main = hls.filter((i) => !i.secondary);
  assert.equal(main.length, 1, 'one entry for the stream');
  assert.deepEqual(main[0].variants.map((v) => v.label), ['360p', '180p']);
  assert.equal(hls.filter((i) => i.secondary).length, 4, 'three playlists and the refused master under "More"');
  // download the best quality: video and sound in ONE mp4
  const blobs = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return origCreate(b); };
  try {
    const before = downloadsStarted.length;
    await send({ type: 'download', tabId, itemId: main[0].id, variant: 0, variantLabel: '360p' });
    for (let i = 0; i < 100 && downloadsStarted.length === before; i++) await tick(50);
    assert.equal(downloadsStarted.length - before, 1, 'one file');
    assert.match(downloadsStarted.at(-1).filename, /\.mp4$/);
    const out = path.join(dir, 'out.mp4');
    fs.writeFileSync(out, Buffer.from(await blobs.at(-1).arrayBuffer()));
    const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', out]);
    const lines = String(pr.stdout).trim().split(/\r?\n/).map((l) => l.trim()).sort(); // Windows ffprobe ends lines with CRLF
    assert.deepEqual(lines, ['audio', 'video,640,360']);
  } finally { URL.createObjectURL = origCreate; }
});

test('LIVE HLS: separate video and audio playlists are recorded together and saved as ONE mp4', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-synthlive-'));
  const mk = (name, args) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, '-t', '12', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', `${name}_init.mp4`, '-hls_segment_filename', `${name}_%d.m4s`, `${name}.m3u8`], { cwd: dir }); // run inside dir (Windows: see above)
    assert.equal(r.status, 0, String(r.stderr));
  };
  mk('v', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-an']);
  mk('a', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'aac', '-vn']);
  const B = 'https://edge.live.example.org/streams/xyz/';
  let polls = 0;
  const origFetch = globalThis.fetch;
  const file = (f) => { const b = fs.readFileSync(path.join(dir, f)); return { ok: true, status: 200, headers: { get: () => String(b.length) }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), body: null }; };
  globalThis.fetch = async (url) => {
    const m = /\/(v|a)\.m3u8/.exec(url);
    if (m) {
      polls++;
      const first = Math.min(6, Math.floor(polls / 2));
      const segs = [0, 1, 2].map((i) => first + i);
      return { ok: true, status: 200, text: async () => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-MAP:URI="${m[1]}_init.mp4"\n${segs.map((n) => `#EXTINF:1.000,\n${m[1]}_${n}.m4s`).join('\n')}\n` };
    }
    if (url.startsWith(B)) return file(url.slice(B.length));
    return origFetch(url);
  };
  const tabId = 43;
  try {
    for (const n of ['v', 'a']) hit(`${B}${n}.m3u8?_HLS_msn=3&_HLS_part=0`, { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId });
    await tick(300);
    let st = await send({ type: 'get_state', tabId });
    const main = st.items.filter((i) => i.kind === 'hls' && !i.secondary);
    assert.equal(main.length, 1);
    assert.equal(main[0].live, true);
    assert.deepEqual(main[0].variants.map((v) => v.label), ['240p']);
    let captured;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (b) => { captured = b; return origCreate(b); };
    try {
      const before = downloadsStarted.length;
      assert.equal((await send({ type: 'download', tabId, itemId: main[0].id, variant: 0 })).ok, true);
      await tick(2500);
      st = await send({ type: 'get_state', tabId });
      const job = st.jobs.at(-1);
      assert.equal(job.recording, true);
      await send({ type: 'stop_job', jobId: job.id });
      for (let i = 0; i < 100 && downloadsStarted.length === before; i++) await tick(50);
      assert.equal(downloadsStarted.length - before, 1, 'one file');
      assert.match(downloadsStarted.at(-1).filename, /\.mp4$/);
    } finally { URL.createObjectURL = origCreate; }
    const out = path.join(dir, 'out.mp4');
    fs.writeFileSync(out, Buffer.from(await captured.arrayBuffer()));
    const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time,duration', '-of', 'json', out]);
    const streams = JSON.parse(String(pr.stdout)).streams;
    assert.deepEqual(streams.map((x) => x.codec_type).sort(), ['audio', 'video']);
    const d = streams.map((x) => Number(x.duration));
    assert.ok(Math.min(...d) >= 2, `durations ${d}`);
    assert.ok(Math.abs(d[0] - d[1]) < 1.2, `video and audio of about the same length: ${d}`);
  } finally { globalThis.fetch = origFetch; }
});

test('Feed of short HLS videos: cover pictures and names from the page, videos off screen go under "More"', async () => {
  const tabId = 44;
  const pl = (name) => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="https://media.feed.example/${name}.m4s",BYTERANGE="800@0"\n#EXT-X-BYTERANGE:5000@800\n#EXTINF:2,\nhttps://media.feed.example/${name}.m4s\n#EXT-X-ENDLIST\n`;
  fixtures['https://api.feed.example/v2/gifs/weeklyskybluechick/hd.m3u8'] = pl('WeeklySkyblueChick');
  fixtures['https://api.feed.example/v2/gifs/genuinewigglygiraffe/hd.m3u8'] = pl('GenuineWigglyGiraffe');
  for (const id of ['weeklyskybluechick', 'genuinewigglygiraffe']) hit(`https://api.feed.example/v2/gifs/${id}/hd.m3u8`, { 'content-type': 'text/plain' }, { tabId });
  await tick(150);
  const sender = { tab: { id: tabId } };
  const feed = (vis) => send({ type: 'page_info', top: true, url: 'https://www.feed.example/', title: 'Feed | Example', thumbnail: '', videos: [], feed: [
    { poster: 'https://media.feed.example/WeeklySkyblueChick-poster.jpg', src: '', visible: vis === 0, playing: vis === 0 },
    { poster: 'https://media.feed.example/GenuineWigglyGiraffe-poster.jpg', src: '', visible: vis === 1, playing: vis === 1 },
  ] }, sender);
  await feed(1);
  let hls = (await send({ type: 'get_state', tabId }, sender)).items.filter((i) => i.kind === 'hls');
  const by = (n) => hls.find((i) => i.url.includes(n));
  assert.equal(by('genuine').thumbnail, 'https://media.feed.example/GenuineWigglyGiraffe-poster.jpg');
  assert.equal(by('genuine').title, 'Genuine Wiggly Giraffe');
  assert.ok(!by('genuine').secondary, 'the video on screen is a main card');
  assert.equal(by('weekly').secondary, true, 'the other one is under "More"');
  await feed(0); // scrolled to the other video
  hls = (await send({ type: 'get_state', tabId }, sender)).items.filter((i) => i.kind === 'hls');
  assert.ok(!by('weekly').secondary);
  assert.equal(by('genuine').secondary, true);
});

test('Firefox for Android: the finished file is handed to the page of the video (the downloads API never answers there)', async () => {
  const tabId = 45;
  const base = 'https://and.example.com/live.m3u8';
  let polls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === base) {
      polls++;
      const segs = [0, 1, 2].map((i) => i + Math.max(0, polls - 1));
      return { ok: true, status: 200, text: async () => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${segs[0]}\n${segs.map((n) => `#EXTINF:0.2,\ns${n}.ts`).join('\n')}\n` };
    }
    const m = /and\.example\.com\/s(\d+)\.ts$/.exec(url);
    if (m) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(`<${m[1]}>`).buffer };
    return origFetch(url);
  };
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:160.0) Gecko/160.0 Firefox/160.0' }, configurable: true, writable: true });
  try {
    hit(base, { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId });
    await tick(80);
    let st = await send({ type: 'get_state', tabId });
    const item = st.items.find((i) => i.url === base);
    const store0 = { ...store.local.settings };
    store.local.settings = { ...store0, tsToMp4: false };
    listeners['storage.onChanged'][0].fn({ settings: { newValue: store.local.settings } }, 'local');
    const before = downloadsStarted.length;
    const msgs = tabMessages.length;
    await send({ type: 'download', tabId, itemId: item.id });
    await tick(900);
    st = await send({ type: 'get_state', tabId });
    await send({ type: 'stop_job', jobId: st.jobs.at(-1).id });
    for (let i = 0; i < 40 && !tabMessages.slice(msgs).some((x) => x.msg.type === 'vdl_save'); i++) await tick(50);
    const saved = tabMessages.slice(msgs).find((x) => x.msg.type === 'vdl_save');
    assert.ok(saved, 'the page got the file');
    assert.equal(saved.id, tabId);
    assert.deepEqual(saved.opts, { frameId: 0 });
    assert.match(saved.msg.name, /\.ts$/);
    assert.match(await saved.msg.blob.text(), /^<\d+>/);
    assert.equal(downloadsStarted.length, before, 'downloads.download is not used on the phone');
    await tick(100);
    assert.equal((await send({ type: 'get_state', tabId })).jobs.at(-1).state, 'done');
    store.local.settings = store0;
    listeners['storage.onChanged'][0].fn({ settings: { newValue: store0 } }, 'local');
  } finally {
    globalThis.fetch = origFetch;
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator;
  }
});

test('HLS fMP4 with video and sound in one playlist is saved as an ordinary MP4 (index first, seekable)', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-defrag-'));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 's%d.m4s', 'p.m3u8'], { cwd: dir }); // run inside dir (Windows: see above)
  assert.equal(r.status, 0, String(r.stderr));
  const B = 'https://frag.example.com/v/';
  for (const f of fs.readdirSync(dir)) { const b = fs.readFileSync(path.join(dir, f)); fixtures[B + f] = f.endsWith('.m3u8') ? b.toString() : b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }
  const tabId = 46;
  hit(`${B}p.m3u8`, { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId });
  await tick(150);
  const item = (await send({ type: 'get_state', tabId })).items.find((i) => i.url === `${B}p.m3u8`);
  const blobs = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return origCreate(b); };
  try {
    const before = downloadsStarted.length;
    await send({ type: 'download', tabId, itemId: item.id, variant: 0 });
    for (let i = 0; i < 100 && downloadsStarted.length === before; i++) await tick(50);
    assert.equal(downloadsStarted.length - before, 1);
  } finally { URL.createObjectURL = origCreate; }
  const out = Buffer.from(await blobs.at(-1).arrayBuffer());
  const top = [];
  for (let p = 0; p + 8 <= out.length;) { const size = out.readUInt32BE(p); top.push(out.toString('latin1', p + 4, p + 8)); if (!size) break; p += size; }
  assert.deepEqual(top, ['ftyp', 'moov', 'mdat'], 'no moof pieces, the index comes first');
  const file = path.join(dir, 'out.mp4');
  fs.writeFileSync(file, out);
  const same = (f) => String(spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0', '-c', 'copy', '-f', 'framemd5', '-']).stdout).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').map((x) => x.trim())).map((x) => `${x[0]},${x[5]}`).sort((a, b) => a[0].localeCompare(b[0])).join('\n'); // per track, in order (the interleaving may differ)
  const src = path.join(dir, 'src.mp4');
  fs.writeFileSync(src, Buffer.concat(['init.mp4', 's0.m4s', 's1.m4s', 's2.m4s'].map((f) => fs.readFileSync(path.join(dir, f)))));
  assert.equal(same(file), same(src), 'the same packets in the same tracks');
});

test('Kick / Amazon IVS: quality playlists without a quality list go under "More" when the master is there', async () => {
  const M = 'https://fa1.us-west-2.playback.live-video.net/api/video/v1/us-west-2.x.channel.y.m3u8?token=t';
  fixtures[M] = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080,FRAME-RATE=60.000\nhttps://fa1.euw12.playlist.live-video.net/v1/playlist/A.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,FRAME-RATE=60.000\nhttps://fa1.euw12.playlist.live-video.net/v1/playlist/B.m3u8\n';
  for (const k of ['A', 'Q', 'R']) fixtures[`https://fa1.euw11.playlist.live-video.net/v1/playlist/${k}.m3u8`] = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nx.ts\n';
  fixtures['https://fa1.euw12.playlist.live-video.net/v1/playlist/A.m3u8'] = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nx.ts\n';
  hit(M, { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId: 31 });
  hit('https://fa1.euw11.playlist.live-video.net/v1/playlist/Q.m3u8', { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId: 31 });
  hit('https://fa1.euw11.playlist.live-video.net/v1/playlist/R.m3u8', { 'content-type': 'application/vnd.apple.mpegurl' }, { tabId: 31 });
  await tick(150);
  const hls = (await send({ type: 'get_state', tabId: 31 })).items.filter((i) => i.kind === 'hls');
  assert.equal(hls.length, 3);
  assert.deepEqual(hls.filter((i) => !i.secondary).map((i) => i.url), [M], 'only the master stays in the main list');
  assert.equal(hls.filter((i) => i.secondary).length, 2);
});
