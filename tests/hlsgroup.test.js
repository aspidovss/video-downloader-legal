// Separate video / audio HLS playlists put together (lib/hlsgroup.js) and LL-HLS parameters (lib/util.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSynthGroups, playlistDir, trackInfo } from '../lib/hlsgroup.js';
import { stripLlHls, normalizeUrl } from '../lib/util.js';

const V = (id, url, h, bw) => ({ id, url, live: true, bandwidth: bw, track: { video: true, audio: false, width: h * 16 / 9, height: h, codec: 'avc1' } });
const A = (id, url, bw) => ({ id, url, live: true, bandwidth: bw, track: { video: false, audio: true, width: 0, height: 0, codec: 'mp4a' } });

test('LL-HLS parameters are dropped, the rest of the address stays', () => {
  assert.equal(stripLlHls('https://e.x/a/p.m3u8?session=1&_HLS_msn=9&_HLS_part=2'), 'https://e.x/a/p.m3u8?session=1');
  assert.equal(stripLlHls('https://e.x/a/p.m3u8?_HLS_skip=YES'), 'https://e.x/a/p.m3u8');
  assert.equal(stripLlHls('https://e.x/a/p.m3u8?x=1'), 'https://e.x/a/p.m3u8?x=1');
  assert.equal(normalizeUrl('https://e.x/p.m3u8?s=1&_HLS_msn=5'), normalizeUrl('https://e.x/p.m3u8?s=1&_HLS_msn=6&_HLS_part=1'));
});

test('one group per folder: qualities from the highest, each with the sound; same heights get the bitrate', () => {
  const d = 'https://e.x/streams/origin.abc/';
  const g = buildSynthGroups([
    V('v0', `${d}chunklist_0_video.m3u8?session=s`, 360, 800000),
    A('a5', `${d}chunklist_5_audio.m3u8?session=s`, 100000),
    V('v2', `${d}chunklist_2_video.m3u8?session=s`, 720, 3000000),
    V('v3', `${d}chunklist_3_video.m3u8?session=s`, 720, 4000000),
    V('o1', 'https://e.x/other/v.m3u8', 1080, 5000000), // another folder without sound: no group
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].dir, d);
  assert.deepEqual(g[0].variants.map((v) => v.label), ['720p 4.0M', '720p 3.0M', '360p']);
  assert.ok(g[0].variants.every((v) => v.audioUrl === `${d}chunklist_5_audio.m3u8?session=s`));
  assert.equal(g[0].variants[0].bandwidth, 4100000);
  assert.deepEqual(g[0].members.sort(), ['a5', 'v0', 'v2', 'v3']);
  assert.equal(playlistDir('https://e.x/a/b/c.m3u8?q=1'), 'https://e.x/a/b/');
});

test('no group without both a video-only and an audio-only playlist; muxed playlists are left alone', () => {
  const d = 'https://e.x/s/';
  assert.deepEqual(buildSynthGroups([V('v', `${d}v.m3u8`, 720, 1)]), []);
  assert.deepEqual(buildSynthGroups([{ id: 'm', url: `${d}m.m3u8`, track: { video: true, audio: true } }, A('a', `${d}a.m3u8`, 1)]), []);
  assert.deepEqual(trackInfo({ tracks: [{ handler: 'vide', width: 640, height: 360, entry: 'avc1' }] }), { video: true, audio: false, width: 640, height: 360, codec: 'avc1' });
});
