import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DOMParser } from './helpers/xml.js';

import { sanitizeFilename, buildFilename, normalizeUrl, formatBytes, formatDuration, urlExt, mimeToExt } from '../lib/util.js';
import { parsePlaylist, ivBytes } from '../lib/hls.js';
import { parseMPD, parseISODuration } from '../lib/dash.js';
import { downloadParts, hlsParts, dashParts, StreamError } from '../lib/downloader.js';
import { resolveVimeo, resolveDailymotion, vimeoIdFromUrl, dailymotionIdFromUrl } from '../lib/sites.js';

// ---------------------------------------------------------------- util ----
test('sanitizeFilename strips illegal chars, trailing dots, reserved names', () => {
  assert.equal(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeFilename('name...  '), 'name');
  assert.equal(sanitizeFilename('CON'), 'video_CON');
  assert.equal(sanitizeFilename(''), 'video_file');
  assert.equal(sanitizeFilename('x'.repeat(400)).length, 150);
});

test('buildFilename applies template, suffix, extension', () => {
  const d = new Date(2026, 9, 12, 3, 4, 5);
  assert.equal(buildFilename('{title}', { title: 'My: Video', ext: 'mp4', date: d }), 'My_ Video.mp4');
  assert.equal(buildFilename('{title} [{quality}]', { title: 'T', quality: '720p', ext: 'ts', date: d }), 'T [720p].ts');
  assert.equal(buildFilename('{date}_{title}', { title: 'T', ext: 'mp4', suffix: '.audio', date: d }), '2026-10-12_T.audio.mp4');
  assert.equal(buildFilename('no-title-token', { title: 'T', ext: 'mp4' }), 'T.mp4');
});

test('normalizeUrl drops range-ish params and hash', () => {
  assert.equal(normalizeUrl('https://a.com/v.mp4?x=1&range=0-100&bytestart=5#t'), 'https://a.com/v.mp4?x=1');
});

test('misc helpers', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(urlExt('https://a.com/path/x.M3U8?z=1'), 'm3u8');
  assert.equal(mimeToExt('video/mp4; codecs=avc1'), 'mp4');
});

// ----------------------------------------------------------------- HLS ----
const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,AUDIO="aud"
720/index.m3u8
`;

test('HLS master playlist: variants sorted, audio attached, labels', () => {
  const pl = parsePlaylist(MASTER, 'https://cdn.example.com/v/master.m3u8');
  assert.equal(pl.type, 'master');
  assert.deepEqual(pl.variants.map((v) => v.label), ['720p', '360p']);
  assert.equal(pl.variants[0].url, 'https://cdn.example.com/v/720/index.m3u8');
  assert.equal(pl.variants[0].audio.url, 'https://cdn.example.com/v/audio/en.m3u8');
});

test('HLS media playlist: byterange, map, endlist, live flag', () => {
  const text = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@0
f.mp4
#EXTINF:4.0,
#EXT-X-BYTERANGE:500
f.mp4
#EXT-X-ENDLIST`;
  const pl = parsePlaylist(text, 'https://x.io/a/p.m3u8');
  assert.equal(pl.live, false);
  assert.equal(pl.hasMap, true);
  assert.equal(pl.duration, 10);
  assert.deepEqual(pl.segments[0].range, { start: 0, end: 999 });
  assert.deepEqual(pl.segments[1].range, { start: 1000, end: 1499 });
  assert.equal(parsePlaylist(text.replace('#EXT-X-ENDLIST', ''), 'https://x.io/p.m3u8').live, true);
});

test('HLS: SAMPLE-AES / Widevine keys are flagged protected, AES-128 is not', () => {
  const base = '#EXTM3U\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST';
  assert.equal(parsePlaylist(`#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST`, 'https://a/p.m3u8').protected, true);
  assert.equal(parsePlaylist(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST`, 'https://a/p.m3u8').protected, true);
  assert.equal(parsePlaylist(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST`, 'https://a/p.m3u8').protected, false);
  assert.equal(parsePlaylist(base, 'https://a/p.m3u8').protected, false);
});

test('HLS: default IV is the sequence number, explicit IV is honored', () => {
  assert.equal(ivBytes({ iv: null }, 258)[14], 1);
  assert.equal(ivBytes({ iv: null }, 258)[15], 2);
  assert.equal(ivBytes({ iv: '0x000102030405060708090a0b0c0d0e0f' }, 0)[15], 15);
});

// ---------------------------------------------------------------- DASH ----
const MPD_TEMPLATE = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S">
 <BaseURL>https://cdn.example.com/dash/</BaseURL>
 <Period>
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s"/>
   <Representation id="v1" bandwidth="500000" width="640" height="360" codecs="avc1.42c01e"/>
   <Representation id="v2" bandwidth="2000000" width="1280" height="720" codecs="avc1.4d401f"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
   <SegmentTemplate timescale="1000" duration="4000" initialization="a/init.mp4" media="a/$Time$.m4s"/>
   <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
  </AdaptationSet>
 </Period>
</MPD>`;

test('DASH SegmentTemplate with Number/Time, BaseURL, sorting', () => {
  const m = parseMPD(MPD_TEMPLATE, 'https://x.com/m.mpd', DOMParser);
  assert.equal(m.protected, false);
  assert.equal(m.duration, 20);
  assert.deepEqual(m.videos.map((v) => v.label), ['720p', '360p']);
  const v720 = m.videos[0];
  assert.equal(v720.segments.length, 5);
  assert.equal(v720.initUrl, 'https://cdn.example.com/dash/v2/init.mp4');
  assert.equal(v720.segments[0].url, 'https://cdn.example.com/dash/v2/seg-001.m4s');
  assert.equal(m.audios[0].segments[2].url, 'https://cdn.example.com/dash/a/8000.m4s');
  const { parts, ext } = dashParts(v720);
  assert.equal(parts.length, 6);
  assert.equal(ext, 'mp4');
  assert.equal(dashParts(m.audios[0]).ext, 'm4a');
});

test('DASH SegmentTimeline with repeat', () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S"><Period>
  <AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="100" media="s-$Time$.m4s" initialization="i.mp4">
   <SegmentTimeline><S t="0" d="200" r="2"/><S d="400"/></SegmentTimeline></SegmentTemplate>
   <Representation id="x" bandwidth="1" height="480"/></AdaptationSet></Period></MPD>`;
  const m = parseMPD(xml, 'https://x.com/m.mpd', DOMParser);
  assert.deepEqual(m.videos[0].segments.map((s) => s.url.split('/').pop()), ['s-0.m4s', 's-200.m4s', 's-400.m4s', 's-600.m4s']);
});

test('DASH SegmentList and single-file BaseURL', () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S"><Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="l" bandwidth="1" height="240"><BaseURL>l/</BaseURL><SegmentList><Initialization sourceURL="i.mp4"/><SegmentURL media="1.m4s"/><SegmentURL media="2.m4s"/></SegmentList></Representation>
   <Representation id="s" bandwidth="2" height="360"><BaseURL>whole.mp4</BaseURL><SegmentBase indexRange="0-100"/></Representation>
  </AdaptationSet></Period></MPD>`;
  const m = parseMPD(xml, 'https://x.com/d/m.mpd', DOMParser);
  const list = m.videos.find((v) => v.id === 'l');
  assert.equal(list.initUrl, 'https://x.com/d/l/i.mp4');
  assert.equal(list.segments.length, 2);
  assert.equal(m.videos.find((v) => v.id === 's').segments[0].url, 'https://x.com/d/whole.mp4');
});

test('DASH ContentProtection and live are flagged', () => {
  const xml = (type, cp) => `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="${type}" mediaPresentationDuration="PT8S"><Period>
  <AdaptationSet mimeType="video/mp4">${cp}<SegmentTemplate timescale="1" duration="4" media="$Number$.m4s"/><Representation id="a" bandwidth="1"/></AdaptationSet></Period></MPD>`;
  assert.equal(parseMPD(xml('static', '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>'), 'https://x/m.mpd', DOMParser).protected, true);
  assert.equal(parseMPD(xml('dynamic', ''), 'https://x/m.mpd', DOMParser).live, true);
  assert.equal(parseISODuration('PT1H2M3.5S'), 3723.5);
});

// ----------------------------------------------------------- downloader ----
function mockFetch(map, { failFirst = 0 } = {}) {
  const calls = [];
  let fails = failFirst;
  const fn = async (url, opts = {}) => {
    calls.push({ url, range: opts.headers?.Range });
    if (fails-- > 0) throw new Error('network');
    if (!(url in map)) return { ok: false, status: 404 };
    const body = map[url];
    return {
      ok: true, status: 200,
      arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
      text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
    };
  };
  fn.calls = calls;
  return fn;
}
const textOf = async (blobs) => new Blob(blobs).text();

test('downloadParts keeps order under concurrency, reports progress, retries', async () => {
  const map = {};
  const parts = [];
  for (let i = 0; i < 12; i++) { map[`https://x/${i}`] = `s${i};`; parts.push({ url: `https://x/${i}` }); }
  const progress = [];
  const f = mockFetch(map, { failFirst: 2 });
  const blobs = await downloadParts(parts, { fetchFn: f, concurrency: 4, onProgress: (p) => progress.push(p.done) });
  assert.equal(await textOf(blobs), Array.from({ length: 12 }, (_, i) => `s${i};`).join(''));
  assert.equal(progress.at(-1), 12);
});

test('downloadParts: http error, abort, size cap', async () => {
  await assert.rejects(downloadParts([{ url: 'https://x/missing' }], { fetchFn: mockFetch({}) }), (e) => e instanceof StreamError && e.code === 'http');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(downloadParts([{ url: 'https://x/a' }], { fetchFn: mockFetch({ 'https://x/a': 'z' }), signal: ac.signal }), (e) => e.code === 'aborted');
  await assert.rejects(downloadParts([{ url: 'https://x/a' }, { url: 'https://x/b' }], { fetchFn: mockFetch({ 'https://x/a': '1234', 'https://x/b': '5678' }), maxBytes: 5, concurrency: 1 }), (e) => e.code === 'toolarge');
});

test('downloadParts sends Range header for byteranges', async () => {
  const f = mockFetch({ 'https://x/a': 'abc' });
  await downloadParts([{ url: 'https://x/a', range: { start: 10, end: 19 } }], { fetchFn: f });
  assert.equal(f.calls[0].range, 'bytes=10-19');
});

test('HLS end-to-end: AES-128 encrypted segments are decrypted and joined in order', async () => {
  const keyBytes = webcrypto.getRandomValues(new Uint8Array(16));
  const ck = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  const plain = ['AAAA-first-', 'BBBB-second-', 'CCCC-third'];
  const map = { 'https://c.io/key.bin': keyBytes.buffer.slice(0) };
  for (let i = 0; i < plain.length; i++) {
    map[`https://c.io/s${i}.ts`] = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: ivBytes({ iv: null }, 7 + i) }, ck, new TextEncoder().encode(plain[i]));
  }
  map['https://c.io/p.m3u8'] = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\ns0.ts\n#EXTINF:4,\ns1.ts\n#EXTINF:4,\ns2.ts\n#EXT-X-ENDLIST`;
  const f = mockFetch(map);
  const { parts, ext } = await hlsParts('https://c.io/p.m3u8', { fetchFn: f });
  assert.equal(ext, 'ts');
  const blobs = await downloadParts(parts, { fetchFn: f, cryptoApi: webcrypto });
  assert.equal(await textOf(blobs), plain.join(''));
});

test('hlsParts refuses DRM and live', async () => {
  const drm = mockFetch({ 'https://c.io/d.m3u8': '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST' });
  await assert.rejects(hlsParts('https://c.io/d.m3u8', { fetchFn: drm }), (e) => e.code === 'drm');
  const live = mockFetch({ 'https://c.io/l.m3u8': '#EXTM3U\n#EXTINF:4,\ns.ts' });
  await assert.rejects(hlsParts('https://c.io/l.m3u8', { fetchFn: live }), (e) => e.code === 'live');
});

test('HLS fMP4: init segment is fetched once and first', async () => {
  const f = mockFetch({ 'https://c.io/p.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na.m4s\n#EXTINF:4,\nb.m4s\n#EXT-X-ENDLIST' });
  const { parts, ext } = await hlsParts('https://c.io/p.m3u8', { fetchFn: f });
  assert.equal(ext, 'mp4');
  assert.deepEqual(parts.map((p) => p.url.split('/').pop()), ['init.mp4', 'a.m4s', 'b.m4s']);
});

// ---------------------------------------------------------------- sites ----
test('site id extraction', () => {
  assert.deepEqual(vimeoIdFromUrl('https://vimeo.com/123456789'), { id: '123456789', hash: null });
  assert.deepEqual(vimeoIdFromUrl('https://player.vimeo.com/video/123456789?h=abcdef0123'), { id: '123456789', hash: 'abcdef0123' });
  assert.equal(vimeoIdFromUrl('https://example.com/123456789'), null);
  assert.equal(dailymotionIdFromUrl('https://www.dailymotion.com/video/x8abcd1'), 'x8abcd1');
  assert.equal(dailymotionIdFromUrl('https://dai.ly/x8abcd1'), 'x8abcd1');
});

test('Vimeo resolver maps config JSON to items', async () => {
  const cfg = {
    video: { title: 'Clip', duration: 61, thumbs: { base: 'https://i.vimeocdn.com/t' } },
    request: { files: {
      progressive: [{ url: 'https://v/720.mp4', height: 720, mime: 'video/mp4' }],
      hls: { default_cdn: 'a', cdns: { a: { url: 'https://v/master.m3u8' } } },
    } },
  };
  const fetchFn = async () => ({ ok: true, json: async () => cfg });
  const items = await resolveVimeo('https://vimeo.com/123456789', fetchFn);
  assert.deepEqual(items.map((i) => [i.kind, i.quality || '']), [['file', '720p'], ['hls', '']]);
  assert.equal(items[0].title, 'Clip');
  assert.deepEqual(await resolveVimeo('https://vimeo.com/123456789', async () => ({ ok: false })), []);
});

test('Dailymotion resolver maps metadata to items', async () => {
  const meta = { title: 'DM', duration: 30, posters: { 720: 'https://p/720.jpg' }, qualities: {
    auto: [{ type: 'application/x-mpegURL', url: 'https://d/auto.m3u8' }],
    480: [{ type: 'video/mp4', url: 'https://d/480.mp4' }],
  } };
  const items = await resolveDailymotion('https://www.dailymotion.com/video/x8abcd1', async () => ({ ok: true, json: async () => meta }));
  assert.deepEqual(items.map((i) => i.kind).sort(), ['file', 'hls']);
  assert.equal(items.find((i) => i.kind === 'file').quality, '480p');
});
