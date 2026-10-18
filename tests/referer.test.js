// Servers that refuse the extension (403 / 412): page Referer / Origin rules, the site resolver for the page data (1.6.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { refDomain, mediaExt } from '../lib/util.js';
import { buildRules, hdr } from '../service/headers.js';
import { pornhubViewKey, pornhubFlashvars, objectAt, resolvePornhub } from '../lib/sites.js';

test('refDomain: the site part of a host', () => {
  assert.equal(refDomain('https://hv-h.phncdn.com/hls/x.m3u8'), 'phncdn.com');
  assert.equal(refDomain('https://cdn.a.example.co.uk/v.mp4'), 'example.co.uk');
  assert.equal(refDomain('https://example.com/'), 'example.com');
  assert.equal(refDomain('nonsense'), '');
});

test('header refs: never for YouTube / Google; a rule per refused site with the page as Referer and its origin', () => {
  assert.equal(hdr.setRef('googlevideo.com', 'https://www.youtube.com/watch?v=x'), false);
  assert.equal(hdr.setRef('phncdn.com', 'not a url'), false);
  const s = { ua: '', live: false, on: true, refs: new Map([['phncdn.com', 'https://www.example.com/view_video.php?viewkey=1']]) };
  const r = buildRules(s, 'abc').find((x) => x.condition.requestDomains?.[0] === 'phncdn.com');
  assert.ok(r, 'rule for the refused site');
  assert.deepEqual(r.condition.tabIds, [-1], 'only the extension\'s own requests');
  assert.deepEqual(r.action.requestHeaders, [
    { header: 'referer', operation: 'set', value: 'https://www.example.com/view_video.php?viewkey=1' },
    { header: 'origin', operation: 'set', value: 'https://www.example.com' },
  ]);
});

const FV = { video_title: 'Some "title" {x}', image_url: 'https://ei.phncdn.com/cover.jpg', video_duration: '754',
  mediaDefinitions: [
    { format: 'hls', videoUrl: 'https://hv-h.phncdn.com/hls/720P/master.m3u8?h=1', quality: '720' },
    { format: 'mp4', videoUrl: 'https://www.pornhub.com/video/get_media?s=abc', quality: [], remote: true },
  ] };
const HTML = `<html><script>var a = 1; var flashvars_64621625 = ${JSON.stringify(FV)};\nvar b = "}";</script></html>`;

test('page data: the flashvars object is read whole (braces inside strings do not end it)', () => {
  assert.equal(pornhubViewKey('https://www.pornhub.com/view_video.php?viewkey=6ac1'), '6ac1');
  assert.equal(pornhubViewKey('https://www.pornhub.com/'), null);
  assert.equal(pornhubViewKey('https://example.com/view_video.php?viewkey=1'), null);
  assert.deepEqual(pornhubFlashvars(HTML), FV);
  assert.equal(objectAt('{"a":"}"', 0), null);
  assert.equal(pornhubFlashvars('<html>nothing</html>'), null);
});

test('resolver: an HLS entry with every quality (the default) and an MP4 entry (under "More"), the page as Referer, ids that survive new signatures', async () => {
  const page = 'https://www.pornhub.com/view_video.php?viewkey=6ac1';
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    if (url === page) return { ok: true, text: async () => HTML };
    if (url.includes('/video/get_media')) return { ok: true, json: async () => [
      { format: 'mp4', videoUrl: 'https://cv-h.phncdn.com/videos/480P.mp4?x=1', quality: '480' },
      { format: 'mp4', videoUrl: 'https://cv-h.phncdn.com/videos/1080P.mp4?x=1', quality: '1080' },
      { format: 'hls', videoUrl: 'https://hv-h.phncdn.com/master.m3u8', quality: '1080' },
    ] };
    return { ok: false };
  };
  const items = await resolvePornhub(page, fetchFn);
  assert.deepEqual(items.map((i) => i.kind), ['hls', 'file']);
  const h = items[0];
  assert.ok(h.master && h.siteList && h.referer === page);
  assert.deepEqual(h.variants.map((v) => [v.label, v.nested]), [['720p', true]]);
  const it = items[1];
  assert.equal(it.secondary, true, 'the MP4 list goes under "More" when there is HLS');
  assert.equal(it.kind, 'file');
  assert.deepEqual(it.variants.map((v) => [v.label, v.height, v.type]), [['1080p', 1080, 'mp4'], ['480p', 480, 'mp4']]);
  assert.equal(it.url, it.variants[0].url);
  assert.ok(it.referer === page && it.title === FV.video_title && it.duration === 754 && it.thumbnail === FV.image_url && it.ext === 'mp4');
  const again = await resolvePornhub(page, fetchFn);
  assert.deepEqual(again.map((i) => i.id), [h.id, it.id], 'same ids on the next load');
  assert.deepEqual(await resolvePornhub('https://example.com/x', fetchFn), []);
  assert.deepEqual(await resolvePornhub(page, async () => ({ ok: false })), []);
});

test('mediaExt: a script address gives the media type named in its query, never "php"', () => {
  assert.equal(mediaExt('https://cdn-08.viidoos.com/remote_control.php?file=pHHr_MHun.mp4&acctoken=NGM3'), 'mp4');
  assert.equal(mediaExt('https://x.example/get.php?v=clip.webm'), 'webm');
  assert.equal(mediaExt('https://x.example/a/b.mkv?x=1'), 'mkv');
  assert.equal(mediaExt('https://x.example/stream.php?id=5'), '');
  assert.equal(mediaExt('https://x.example/page.html'), '');
});

test('page Referers: only plain host names (one bad entry would break every Chrome rule); kept across a sleeping background', async () => {
  const { hdr, buildRules } = await import('../service/headers.js');
  assert.equal(hdr.setRef('[::1]', 'https://a.example/'), false);
  assert.equal(hdr.setRef('host:8080', 'https://a.example/'), false);
  assert.equal(hdr.setRef('JoyReactor.CC', 'https://joyreactor.cc/'), true);
  assert.deepEqual(hdr.refEntries().find((e) => e[0] === 'joyreactor.cc'), ['joyreactor.cc', 'https://joyreactor.cc/']);
  assert.equal(hdr.restoreRefs([['bad host', 'https://x/'], ['other.example', 'https://other.example/p'], ['joyreactor.cc', 'https://joyreactor.cc/']]), 1);
  const rules = buildRules({ refs: new Map(hdr.refEntries()) }, 'extid');
  assert.ok(rules.some((r) => r.condition.requestDomains?.[0] === 'other.example'));
});
