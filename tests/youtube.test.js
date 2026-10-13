import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGooglevideoUrl, validateSummary, buildVariants, rangedParts, classifyFormats, buildDiagnostics, newDiag, recordRequest, trackExt,
} from '../lib/youtube.js';

const GV = 'https://rr3---sn-abc.googlevideo.com/videoplayback';
const direct = (itag, extra = {}) => ({ itag, mode: 'direct', url: `${GV}?itag=${itag}&id=o-SECRET&expire=9999999999`, ...extra });

function rawSummary() {
  return {
    videoId: 'dQw4w9WgXcQ', title: 'Secret Title', author: 'Chan', lengthSeconds: 212, isLive: false, status: 'OK', sabr: false,
    license: 'standard', pageType: 'watch', thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg',
    formats: [
      direct(18, { mime: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', label: '360p', h: 360, audio: true, adaptive: false, clen: 5_000_000 }),
      direct(137, { mime: 'video/mp4; codecs="avc1.640028"', label: '1080p', h: 1080, adaptive: true, clen: 40_000_000, bitrate: 4_000_000 }),
      direct(140, { mime: 'audio/mp4; codecs="mp4a.40.2"', adaptive: true, audio: true, clen: 3_400_000, bitrate: 130_000 }),
      direct(251, { mime: 'audio/webm; codecs="opus"', adaptive: true, audio: true, clen: 3_000_000, bitrate: 140_000 }),
      { itag: 248, mode: 'cipher', mime: 'video/webm; codecs="vp9"', label: '1080p', h: 1080, adaptive: true },
      { itag: 313, mode: 'none', mime: 'video/webm; codecs="vp9"', label: '2160p', h: 2160, adaptive: true },
      direct(399, { mime: 'video/mp4; codecs="av01"', label: '1080p', h: 1080, adaptive: true, drm: true }),
    ],
  };
}

test('parseGooglevideoUrl extracts stream info and strips range params', () => {
  const p = parseGooglevideoUrl(`${GV}?itag=137&mime=video%2Fmp4&clen=1234&dur=212.5&range=0-999&rn=3&rbuf=900&expire=1`);
  assert.equal(p.itag, '137');
  assert.equal(p.kind, 'video');
  assert.equal(p.len, 1234);
  assert.equal(p.dur, 212.5);
  assert.equal(new URL(p.url).searchParams.has('range'), false);
  assert.equal(new URL(p.url).searchParams.has('rn'), false);
  assert.equal(parseGooglevideoUrl(`${GV}?itag=137&sabr=1`).sabr, true);
  assert.equal(parseGooglevideoUrl(`${GV}?itag=137`, 'POST').sabr, true);
  assert.equal(parseGooglevideoUrl('https://example.com/videoplayback?itag=1'), null);
  assert.equal(parseGooglevideoUrl('https://x.googlevideo.com/other'), null);
});

test('validateSummary rejects junk and keeps URLs only for direct https formats', () => {
  assert.equal(validateSummary(null), null);
  assert.equal(validateSummary({ videoId: '<script>' }), null);
  const s = validateSummary(rawSummary());
  assert.equal(s.formats.find((f) => f.itag === 248).url, '');
  assert.ok(s.formats.find((f) => f.itag === 18).url.startsWith('https://'));
  const bad = rawSummary();
  bad.formats[0].url = 'javascript:alert(1)';
  assert.equal(validateSummary(bad).formats[0].url, '');
});

test('classifyFormats counts direct / cipher / none / drm', () => {
  const c = classifyFormats(validateSummary(rawSummary()));
  assert.deepEqual(c, { total: 7, direct: 4, cipher: 1, none: 1, drm: 1, unsupported: 3 });
});

test('buildVariants: muxed, video+audio pair (same container), audio-only; cipher/none/drm excluded', () => {
  const v = buildVariants(validateSummary(rawSummary()), []);
  assert.deepEqual(v.map((x) => x.label), ['1080p · MP4', '360p · MP4', 'Audio · M4A 130 kbps', 'Audio · WEBM 140 kbps']);
  assert.deepEqual(v.map((x) => !!x.audio), [false, false, true, true], 'audio-only variants are flagged and come last');
  assert.ok(v[0].size > 0 && v[0].size === v[0].tracks.reduce((n, t) => n + t.len, 0), 'size = sum of the track lengths');
  const pair = v[0];
  assert.deepEqual(pair.tracks.map((t) => [t.itag, t.role]), [[137, 'video'], [140, 'audio']]);
  assert.equal(v.some((x) => /2160|248|399/.test(JSON.stringify(x.tracks.map((t) => t.itag)))), false);
});

test('buildVariants merges verified captured streams and ignores other videos by duration', () => {
  const s = validateSummary(rawSummary());
  const captured = [
    { itag: '247', mime: 'video/webm', kind: 'video', len: 20_000_000, dur: 212.1, url: `${GV}?itag=247&cap=1` },
    { itag: '251', mime: 'audio/webm', kind: 'audio', len: 3_100_000, dur: 212.1, url: `${GV}?itag=251&cap=1` },
    { itag: '135', mime: 'video/mp4', kind: 'video', len: 9_000_000, dur: 999, url: `${GV}?itag=135&other-video=1` },
  ];
  const v = buildVariants(s, captured);
  const webm = v.find((x) => x.container === 'webm' && x.tracks.some((t) => t.itag === 247));
  assert.ok(webm, 'captured webm 720p present');
  assert.equal(webm.label, '720p · WEBM');
  assert.equal(webm.tracks[1].itag, 251);
  assert.equal(webm.tracks[0].verified, true);
  assert.equal(v.some((x) => x.tracks.some((t) => t.itag === 135)), false, 'wrong-duration stream ignored');
  // captured URL replaces the page copy for the same itag
  const withCap = buildVariants(s, [{ itag: '137', mime: 'video/mp4', kind: 'video', len: 41_000_000, dur: 212, url: `${GV}?itag=137&cap=1` }]);
  assert.match(withCap[0].tracks[0].url, /cap=1/);
});

test('video without any audio is labelled, not silently paired wrong', () => {
  const s = validateSummary({ ...rawSummary(), formats: [direct(137, { mime: 'video/mp4', label: '1080p', h: 1080, adaptive: true })] });
  assert.equal(buildVariants(s, [])[0].label, '1080p · MP4 · no audio');
});

test('rangedParts splits by chunk and keeps final byte exact', () => {
  const parts = rangedParts({ url: `${GV}?itag=137`, len: 12 }, 5);
  assert.deepEqual(parts.map((p) => new URL(p.url).searchParams.get('range')), ['0-4', '5-9', '10-11']);
  assert.deepEqual(rangedParts({ url: `${GV}?itag=1`, len: 0 }), [{ url: `${GV}?itag=1` }]);
  assert.equal(trackExt('audio/webm'), 'weba');
});

test('diagnostics contain no URLs, ids, titles or channel names', () => {
  const s = validateSummary(rawSummary());
  const diag = newDiag();
  recordRequest(diag, parseGooglevideoUrl(`${GV}?itag=137&sabr=1`, 'POST'), 'POST');
  recordRequest(diag, parseGooglevideoUrl(`${GV}?itag=140`), 'GET');
  const text = JSON.stringify(buildDiagnostics(s, diag, { version: '1.2.0', userAgent: 'UA' }, []));
  for (const secret of ['dQw4w9WgXcQ', 'Secret Title', 'Chan', 'rr3---sn-abc', 'o-SECRET', 'https://']) assert.equal(text.includes(secret), false, secret);
  const r = JSON.parse(text);
  assert.equal(r.formats.cipher, 1);
  assert.equal(r.googlevideo.post, 1);
  assert.equal(r.googlevideo.sabr, 1);
  assert.deepEqual(r.googlevideo.itags, ['137', '140']);
  assert.equal(buildDiagnostics(null, null).summary, null);
});

import { groupByType, pickQuality, videoType } from '../lib/youtube.js';

test('video types: codec family decides the type; groups ordered MP4 (H.264), MP4 AV1, WEBM; default quality picker', () => {
  assert.equal(videoType({ mime: 'video/mp4; codecs="avc1.640028"' }).short, 'MP4');
  assert.equal(videoType({ mime: 'video/mp4; codecs="av01.0.08M.08"' }).short, 'MP4 AV1');
  assert.equal(videoType({ mime: 'video/webm; codecs="vp9"' }).short, 'WEBM');
  const v = (type, height, label) => ({ type, height, muxed: false, label, typeLabel: type });
  const g = groupByType([v('webm', 2160, 'a'), v('mp4', 360, 'b'), v('mp4-av1', 1080, 'c'), v('mp4', 1080, 'd'), v('webm', 720, 'e')]);
  assert.deepEqual(g.map((x) => x.type), ['mp4', 'mp4-av1', 'webm']);
  assert.deepEqual(g[0].items.map((x) => x.height), [1080, 360]);
  assert.equal(pickQuality(g[2].items, 'best').height, 2160);
  assert.equal(pickQuality(g[2].items, '1080').height, 720);
  assert.equal(pickQuality(g[0].items, '720').height, 360);
  assert.equal(pickQuality([v('mp4', 1440, 'x')], '480').height, 1440, 'everything above the limit -> the lowest available');
});

test('H.264 and AV1 at the same height are separate variants with unique labels', () => {
  const s = validateSummary({ ...rawSummary(), formats: [
    direct(137, { mime: 'video/mp4; codecs="avc1.640028"', label: '1080p', h: 1080, adaptive: true, clen: 40_000_000 }),
    direct(399, { mime: 'video/mp4; codecs="av01.0.08M.08"', label: '1080p', h: 1080, adaptive: true, clen: 20_000_000 }),
    direct(140, { mime: 'audio/mp4; codecs="mp4a.40.2"', adaptive: true, audio: true, clen: 3_000_000 }),
  ] });
  const v = buildVariants(s, []).filter((x) => !x.audio);
  assert.deepEqual(v.map((x) => x.label).sort(), ['1080p · MP4', '1080p · MP4 AV1']);
  assert.deepEqual(v.map((x) => x.type).sort(), ['mp4', 'mp4-av1']);
});

import { groupAudio, pickAudioQuality, pickType } from '../lib/youtube.js';

test('default type: highest resolution wins (ties: H.264), explicit preference respected; quality preference never above what exists', () => {
  const v = (type, height) => ({ type, height, muxed: false, label: `${height}p`, typeLabel: type });
  const g = groupByType([v('mp4', 1080), v('mp4', 720), v('webm', 2160), v('webm', 1080), v('mp4-av1', 1080)]);
  assert.equal(pickType(g, 'auto', 'best').type, 'webm');
  assert.equal(pickType(g, 'auto', '1080').type, 'mp4', 'tie at 1080p -> H.264');
  assert.equal(pickType(g, 'mp4-av1', 'best').type, 'mp4-av1');
  assert.equal(pickType(groupByType([v('mp4', 720)]), 'webm', 'best').type, 'mp4', 'absent preferred type -> what exists');
  assert.equal(pickQuality(groupByType([v('mp4', 720)])[0].items, '1080').height, 720, 'asked 1080p, video has 720p -> 720p');
});

test('audio picker: MP3 / M4A / WEBM groups, "best" = highest track (MP3 capped at 256), 192/128 limits', () => {
  const a = (atype, kbps, mp3) => ({ atype, kbps, mp3: !!mp3, label: `${atype}${kbps}` });
  const list = [a('m4a', 48), a('m4a', 130), a('webm', 140), a('webm', 70), a('mp3', 128, true), a('mp3', 192, true), a('mp3', 256, true), a('mp3', 320, true)];
  const g = groupAudio(list);
  assert.deepEqual(g.map((x) => x.type), ['mp3', 'm4a', 'webm']);
  assert.equal(pickAudioQuality(g[0].items, 'best', true).kbps, 256);
  assert.equal(pickAudioQuality(g[1].items, 'best', false).kbps, 130);
  assert.equal(pickAudioQuality(g[0].items, '192', true).kbps, 192);
  assert.equal(pickAudioQuality(g[1].items, '128', false).kbps, 48);
  assert.equal(pickAudioQuality(g[2].items, '128', false).kbps, 70, 'nothing at/below 128 -> lowest... except 70 <= 128');
});
