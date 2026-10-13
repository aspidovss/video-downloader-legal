// Extraction of the DASH manifest and plain mp4 list from Instagram page data (injected/instagram.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { module: { exports: {} }, JSON, String, Number, Array };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../injected/instagram.js', import.meta.url), 'utf8'), ctx);
const { extractManifests, extractVersions } = ctx.module.exports;

const XML = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><BaseURL>https://x.cdninstagram.com/</BaseURL></Period></MPD>';

test('manifest from "dash_manifests" array', () => {
  const html = `<script>{"a":1,"dash_manifests":[{"manifest_xml":${JSON.stringify(XML)},"quality":"hd"}],"b":2}</script>`;
  assert.deepEqual([...extractManifests(html)], [XML]);
});

test('manifest from an escaped "video_dash_manifest" string', () => {
  const html = `{"video_dash_manifest":${JSON.stringify(XML)},"x":1}`;
  assert.deepEqual([...extractManifests(html)], [XML]);
  assert.deepEqual([...extractManifests('{"video_dash_manifest":"not a manifest"}')], []);
});

test('video_versions: only https urls, sizes kept', () => {
  const html = '{"video_versions":[{"type":101,"width":720,"height":1280,"url":"https:\\/\\/a.cdninstagram.com\\/v.mp4?x=1"},{"width":1,"height":1,"url":"http:\\/\\/bad"}]}';
  const v = [...extractVersions(html)];
  assert.equal(v.length, 1);
  assert.equal(v[0].url, 'https://a.cdninstagram.com/v.mp4?x=1');
  assert.equal(v[0].height, 1280);
});

test('nothing found -> empty lists', () => {
  assert.deepEqual([...extractManifests('<html></html>')], []);
  assert.deepEqual([...extractVersions('<html></html>')], []);
});

test('media pages: reels, posts, IGTV and STORIES (with or without a user prefix); the home feed and profiles are not scanned', () => {
  const { isMediaPage } = ctx.module.exports;
  for (const u of ['https://www.instagram.com/reels/DeUk1X-oV03/', 'https://www.instagram.com/reel/abc/', 'https://www.instagram.com/p/abc/', 'https://www.instagram.com/someuser/reel/abc/', 'https://www.instagram.com/stories/edccustoms/4005431611356118709/', 'https://www.instagram.com/tv/abc/']) assert.equal(isMediaPage(u), true, u);
  for (const u of ['https://www.instagram.com/', 'https://www.instagram.com/someuser/', 'https://www.instagram.com/explore/']) assert.equal(isMediaPage(u), false, u);
});

test('account name from address or page data', () => {
  const { extractAccount } = ctx.module.exports;
  assert.equal(extractAccount('https://www.instagram.com/stories/fatiaodan/', ''), 'fatiaodan');
  assert.equal(extractAccount('https://www.instagram.com/some.user/reel/ABC/', ''), 'some.user');
  assert.equal(extractAccount('https://www.instagram.com/reel/ABC/', '"owner":{"id":"1","username":"own_er"}'), 'own_er');
});

test('facebook: media pages, escaped mp4 urls, account', () => {
  const { isMediaPage, extractFbVersions, extractAccount } = ctx.module.exports;
  assert.ok(isMediaPage('https://www.facebook.com/watch/?v=123'));
  assert.ok(isMediaPage('https://www.facebook.com/reel/123'));
  assert.ok(isMediaPage('https://www.facebook.com/somepage/videos/123/'));
  assert.ok(!isMediaPage('https://www.facebook.com/'));
  const html = '{"browser_native_sd_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/a.mp4?x=1\\u0026y=2","browser_native_hd_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/b.mp4?x=1","playable_url":null}';
  const v = extractFbVersions(html);
  assert.equal(v.length, 2);
  assert.equal(v[0].url, 'https://video.xx.fbcdn.net/v/a.mp4?x=1&y=2');
  assert.equal(v[1].height, 720);
  assert.equal(extractAccount('https://www.facebook.com/somepage/videos/123/', ''), 'somepage');
  assert.equal(extractAccount('https://www.facebook.com/watch/?v=1', '"owner":{"__typename":"Page","name":"My Page"}'), 'My_Page');
});
