import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClients, buildPlayerRequest, parsePlayerResponse, urlParamNames, probeFormats } from '../lib/ytapi.js';

test('resolveClients: order, unknown names dropped, JSON overrides applied, bad JSON ignored', () => {
  assert.deepEqual(resolveClients('ios, android_vr, nope, IOS').map((c) => c.name), ['IOS', 'ANDROID_VR']);
  assert.deepEqual(resolveClients().map((c) => c.key), ['VISIONOS', 'ANDROID_VR', 'IOS', 'IOS_VDL']);
  assert.deepEqual(resolveClients('VISIONOS,ANDROID_VR,IOS').map((c) => c.key), ['VISIONOS', 'ANDROID_VR', 'IOS', 'IOS_VDL'], 'old saved defaults migrate');
  assert.equal(resolveClients('IOS_VDL')[0].name, 'IOS');
  assert.equal(resolveClients('IOS_VDL')[0].version, '20.11.6');
  const c = resolveClients('IOS', '{"IOS":{"version":"99.1","ua":"X/1","extra":{"osVersion":"9"}}}')[0];
  assert.equal(c.version, '99.1');
  assert.equal(c.ua, 'X/1');
  assert.equal(c.extra.osVersion, '9');
  assert.equal(c.extra.deviceMake, 'Apple');
  assert.equal(resolveClients('IOS', '{oops')[0].version, resolveClients('IOS')[0].version);
});

test('buildPlayerRequest: client context, headers, no cookies', () => {
  const c = resolveClients('ANDROID_VR')[0];
  const r = buildPlayerRequest(c, 'abcDEF12345', 'VISITOR');
  const body = JSON.parse(r.init.body);
  assert.equal(body.videoId, 'abcDEF12345');
  assert.equal(body.context.client.clientName, 'ANDROID_VR');
  assert.equal(body.context.client.visitorData, 'VISITOR');
  assert.equal(r.init.headers['X-YouTube-Client-Name'], '28');
  assert.equal(r.init.credentials, 'omit');
  assert.ok(r.url.startsWith('https://www.youtube.com/youtubei/v1/player'));
});

test('parsePlayerResponse: keeps only googlevideo https URLs, drops DRM, ciphers and dubbed audio', () => {
  const g = (q) => `https://rr2---sn-x.googlevideo.com/videoplayback?${q}`;
  const p = parsePlayerResponse({
    playabilityStatus: { status: 'OK' },
    videoDetails: { title: 'T', lengthSeconds: '10' },
    streamingData: {
      hlsManifestUrl: 'https://manifest.googlevideo.com/x.m3u8',
      formats: [{ itag: 18, mimeType: 'video/mp4', url: g('n=abc&itag=18') }],
      adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4', url: g('itag=137'), drmFamilies: ['WIDEVINE'] },
        { itag: 140, mimeType: 'audio/mp4', url: g('itag=140'), audioTrack: { audioIsDefault: true } },
        { itag: 140, mimeType: 'audio/mp4', url: g('itag=140&dub=1'), audioTrack: { audioIsDefault: false } },
        { itag: 248, mimeType: 'video/webm', signatureCipher: 's=x&url=y' },
        { itag: 22, mimeType: 'video/mp4', url: 'http://rr1.googlevideo.com/videoplayback' },
        { itag: 399, mimeType: 'video/mp4', url: 'https://evil.example.com/videoplayback' },
      ],
    },
  }, 'IOS');
  assert.deepEqual(p.formats.map((f) => f.itag), [18, 140]);
  assert.equal(p.formats[0].n, true);
  assert.equal(p.formats[0].client, 'IOS');
  assert.equal(p.hlsUrl, 'https://manifest.googlevideo.com/x.m3u8');
  assert.equal(p.status, 'OK');
  assert.deepEqual(urlParamNames(p.formats[0].url), ['itag', 'n']);
  assert.deepEqual(parsePlayerResponse(null).formats, []);
});

test('resolveClients: custom clients from JSON need id, version and ua', () => {
  const json = '{"mine":{"id":9,"version":"1.0","ua":"X/1","clientName":"MYAPP","extra":{"osName":"Z"}},"bad":{"version":"1"}}';
  const list = resolveClients('MINE,BAD,VISIONOS', json);
  assert.deepEqual(list.map((c) => c.key), ['MINE', 'VISIONOS']);
  assert.equal(list[0].name, 'MYAPP');
  assert.equal(list[0].id, 9);
  const body = JSON.parse(buildPlayerRequest(list[0], 'abcDEF12345').init.body);
  assert.equal(body.context.client.clientName, 'MYAPP');
  assert.equal(body.context.client.osName, 'Z');
});

test('probeFormats: reports the first refused offset and never reads bodies', async () => {
  const MB = 1024 * 1024;
  const formats = [
    { mime: 'video/mp4', clen: 100 * MB, url: 'https://rr1---sn-a.googlevideo.com/videoplayback?itag=1' },
    { mime: 'video/mp4', clen: 5 * MB, url: 'https://rr1---sn-a.googlevideo.com/videoplayback?itag=2' },
  ];
  const seen = [];
  const r = await probeFormats(formats, async (u) => { const off = Number(new URL(u).searchParams.get('range').split('-')[0]); seen.push(off); return { status: off >= 20 * MB ? 403 : 206 }; });
  assert.deepEqual(seen.sort((a, b) => a - b), [0, 5 * MB, 10 * MB, 15 * MB, 20 * MB, 25 * MB, 30 * MB, 40 * MB, 100 * MB - 1]);
  assert.equal(r.ok, false);
  assert.equal(r.limitBytes, 20 * MB);
  const ok = await probeFormats(formats, async () => ({ status: 206 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.limitBytes, Infinity);
  assert.equal((await probeFormats([], async () => ({ status: 500 }))).ok, true, 'nothing to probe');
  const dead = await probeFormats(formats, async () => { throw new TypeError('x'); });
  assert.equal(dead.limitBytes, 0);
});
