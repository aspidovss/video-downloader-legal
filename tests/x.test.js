import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = { module: { exports: {} }, String };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../injected/x.js', import.meta.url), 'utf8'), ctx);
const { mediaIdFrom, parseTweetHref } = ctx.module.exports;

test('x: media id from poster / video address', () => {
  assert.equal(mediaIdFrom('https://pbs.twimg.com/amplify_video_thumb/2109201879087591424/img/abc.jpg'), '2109201879087591424');
  assert.equal(mediaIdFrom('https://video.twimg.com/amplify_video/2109201879087591424/vid/avc1/0/0/720x950/x.mp4'), '2109201879087591424');
  assert.equal(mediaIdFrom('https://pbs.twimg.com/tweet_video_thumb/HUXhvkrWcAAQ0Qb.jpg'), 'HUXhvkrWcAAQ0Qb');
  assert.equal(mediaIdFrom('https://video.twimg.com/tweet_video/HUXhvkrWcAAQ0Qb.mp4'), 'HUXhvkrWcAAQ0Qb');
  assert.equal(mediaIdFrom('blob:https://x.com/abc'), '');
});
test('x: tweet link', () => {
  assert.deepEqual({ ...parseTweetHref('/some_user/status/123/video/1') }, { author: 'some_user', tweetId: '123' });
  assert.equal(parseTweetHref('/home'), null);
});
