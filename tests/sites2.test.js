import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { md5 } from '../lib/md5.js';
import { biliComId, biliTvId, wbiSign, buildMpd, biliComFromPlayurl, biliTvFromPlayurl, resolveBilibili } from '../lib/sites.js';
import { parseMPD } from '../lib/dash.js';
import { DOMParser } from './helpers/xml.js';

test('md5 known vectors', () => {
  assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
  assert.equal(md5('a'.repeat(100)), '36a92cc94a9e0fa21f625f8bfb007adf');
});

test('bilibili ids', () => {
  assert.deepEqual({ ...biliComId('https://www.bilibili.com/video/BV1xx411c7mD/?p=3') }, { bvid: 'BV1xx411c7mD', page: 3 });
  assert.equal(biliComId('https://www.bilibili.com/'), null);
  assert.deepEqual({ ...biliTvId('https://www.bilibili.tv/en/play/2001/123') }, { ep: '123' });
  assert.deepEqual({ ...biliTvId('https://www.bilibili.tv/en/video/456') }, { aid: '456' });
});

test('wbi signature is md5(sorted query + mixin key) and stable', () => {
  const q = wbiSign({ bvid: 'BV1', cid: 5, fnval: 4048, try_look: 1 }, 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png', 1700000000);
  assert.match(q, /^bvid=BV1&cid=5&fnval=4048&try_look=1&wts=1700000000&w_rid=[0-9a-f]{32}$/);
  // known mixin key for this img/sub pair (public documentation): ea1db124af3c7062474693fa704f4ff8
  const body = q.replace(/&w_rid=.*/, '');
  assert.equal(q.split('w_rid=')[1], md5(body + 'ea1db124af3c7062474693fa704f4ff8'));
});

test('buildMpd round-trips through parseMPD', () => {
  const xml = buildMpd({ duration: 12.5, videos: [{ url: 'https://x.bilivideo.com/v.m4s?a=1&b=2', bandwidth: 1000, mime: 'video/mp4', codecs: 'avc1.64001f', width: 1280, height: 720 }], audios: [{ url: 'https://x.bilivideo.com/a.m4s', bandwidth: 64000, codecs: 'mp4a.40.2' }] });
  const m = parseMPD(xml, 'https://x/', DOMParser);
  assert.equal(m.videos.length, 1); assert.equal(m.audios.length, 1);
  assert.equal(m.videos[0].segments[0].url, 'https://x.bilivideo.com/v.m4s?a=1&b=2');
  assert.equal(m.videos[0].height, 720);
  assert.equal(m.duration, 12.5);
});

test('playurl parsers', () => {
  const a = biliComFromPlayurl({ timelength: 60000, dash: { video: [{ baseUrl: 'http://a/v.m4s', bandwidth: 5, height: 480 }], audio: [{ base_url: 'https://a/a.m4s', bandwidth: 1 }] } });
  assert.equal(a.videos[0].url, 'https://a/v.m4s'); assert.equal(a.audios.length, 1);
  const b = biliTvFromPlayurl({ playurl: { video: [{ video_resource: { url: 'https://t/v.mp4', height: 720, bandwidth: 9 } }], audio_resource: [{ url: 'https://t/a.m4a', bandwidth: 2 }] } });
  assert.equal(b.videos[0].height, 720); assert.equal(b.audios.length, 1);
  assert.equal(biliComFromPlayurl({}), null);
});

test('resolveBilibili (com) walks view -> nav -> signed playurl', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const j = (o) => ({ json: async () => o });
    if (url.includes('web-interface/view')) return j({ data: { title: 'T', pic: 'https://p/x.jpg', cid: 9, pages: [{ cid: 9 }] } });
    if (url.includes('web-interface/nav')) return j({ data: { wbi_img: { img_url: 'https://i/a/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i/a/4932caff0ff746eab6f01bf08b70ac45.png' } } });
    return j({ data: { dash: { duration: 20, video: [{ baseUrl: 'https://c.bilivideo.com/v.m4s', bandwidth: 5, height: 720, codecs: 'avc1' }], audio: [{ baseUrl: 'https://c.bilivideo.com/a.m4s', bandwidth: 1 }] } } });
  };
  const items = await resolveBilibili('https://www.bilibili.com/video/BV1xx411c7mD', fetchFn, 1700000000);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'dash'); assert.equal(items[0].title, 'T');
  assert.ok(calls[2].includes('w_rid=') && calls[2].includes('cid=9'));
});

const ctx = { module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../injected/canva.js', import.meta.url), 'utf8'), ctx);
test('canva: hls address from page script', () => {
  const { findHls, isWatch } = ctx.module.exports;
  assert.equal(findHls('var a={"hlsManifestUrl":"https:\\u002F\\u002Fv.canva.com\\u002Fx\\u002Fmaster.m3u8"}'), 'https://v.canva.com/x/master.m3u8');
  assert.equal(findHls('nothing'), '');
  assert.ok(isWatch('https://www.canva.com/design/DAF/abc/watch'));
  assert.ok(!isWatch('https://www.canva.com/'));
});
