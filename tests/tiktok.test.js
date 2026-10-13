import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = { module: { exports: {} }, URL, decodeURIComponent, String };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../injected/tiktok.js', import.meta.url), 'utf8'), ctx);
const { pathKey, videoLink } = ctx.module.exports;

test('pathKey ignores host and signed query', () => {
  assert.equal(pathKey('https://v16-webapp-prime.tiktok.com/video/tos/alisg/tos-x/abc/?a=1&signature=zz'), '/video/tos/alisg/tos-x/abc');
  assert.equal(pathKey('https://v19-webapp-prime.tiktok.com/video/tos/alisg/tos-x/abc/?a=2'), '/video/tos/alisg/tos-x/abc');
  assert.equal(pathKey('nonsense'), '');
});
test('videoLink reads author and id', () => {
  assert.equal(videoLink('/@some.user/video/7301234567890123456').id, '7301234567890123456');
  assert.equal(videoLink('https://www.tiktok.com/@a_b/video/123?lang=en').author, 'a_b');
  assert.equal(videoLink('/foryou'), null);
});
