// Feed of short videos: playlist <-> <video> on the page by file names (lib/feed.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileStem, playlistStems, matchFeed, humanStem } from '../lib/feed.js';

test('file names without folder, extension and size / role suffixes', () => {
  assert.equal(fileStem('https://m.x/WeeklySkyblueChick-poster.jpg'), 'weeklyskybluechick');
  assert.equal(fileStem('https://m.x/WeeklySkyblueChick-mobile.jpg?x=1'), 'weeklyskybluechick');
  assert.equal(fileStem('https://m.x/WeeklySkyblueChick.m4s'), 'weeklyskybluechick');
  assert.equal(fileStem('https://m.x/clip_720p.mp4'), 'clip');
  assert.equal(fileStem('https://m.x/WeeklySkyblueChick.m4s', true), 'WeeklySkyblueChick');
});

test('a playlist is matched to the video with the same name; short or missing names never match', () => {
  const stems = playlistStems('https://api.x/v2/gifs/weeklyskybluechick/hd.m3u8', ['https://m.x/WeeklySkyblueChick.m4s']);
  assert.deepEqual(stems, ['weeklyskybluechick']); // 'v2', 'gifs' are too short to be a name
  const feed = [{ poster: 'https://m.x/OtherVideoName-poster.jpg', visible: false }, { poster: 'https://m.x/WeeklySkyblueChick-poster.jpg', visible: true }];
  assert.equal(matchFeed(stems, feed), feed[1]);
  assert.equal(matchFeed(stems, [{ poster: 'https://m.x/a-poster.jpg' }]), null);
  assert.equal(matchFeed(['index'], [{ poster: '', src: '' }]), null);
  assert.equal(humanStem('WeeklySkyblueChick'), 'Weekly Skyblue Chick');
  assert.equal(humanStem('my_clip-01'), 'my clip 01');
});
