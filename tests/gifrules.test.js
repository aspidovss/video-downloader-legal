// GIF settings (lib/gifrules.js, 1.6.5): expressions, sites and exceptions, clean values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatterns, gifSiteAllowed, gifPrefs, GIF_LIMIT_SECONDS } from '../lib/gifrules.js';

test('GIF expressions: one per line, notes and empty lines skipped, errors with their line', () => {
  const r = parsePatterns('joyreactor\\.(cc|com)$\n\n# note\n[bad\nREDDIT');
  assert.equal(r.list.length, 2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 4);
  assert.ok(r.list[1].test('www.reddit.com'), 'case does not matter');
});

test('GIF sites: empty = all; page host, then the video host; exceptions win; broken lines ignored', () => {
  assert.equal(gifSiteAllowed('https://a.example/x', 'https://cdn.b/v.mp4', '', ''), true);
  assert.equal(gifSiteAllowed('https://joyreactor.cc/top', 'https://img10.joyreactor.cc/v.webm', 'joyreactor\\.(cc|com)$', ''), true);
  assert.equal(gifSiteAllowed('https://a.example/x', 'https://img10.joyreactor.cc/v.webm', '^joyreactor\\.cc$', ''), false);
  assert.equal(gifSiteAllowed('https://a.example/x', 'https://img10.joyreactor.cc/v.webm', 'joyreactor', ''), true, 'the video host is the second chance');
  assert.equal(gifSiteAllowed('https://joyreactor.cc/', 'https://img.joyreactor.cc/v.webm', '', 'joyreactor'), false);
  assert.equal(gifSiteAllowed('https://a.example/', 'https://a.example/v.mp4', '[broken', ''), true, 'only broken lines: no list');
  assert.equal(gifSiteAllowed('', '', '', ''), false);
});

test('GIF settings: defaults, limits, widths and frame rate', () => {
  assert.deepEqual(gifPrefs({}), { enabled: true, maxSec: 60, sizes: [640, 480, 320, 240], width: 480, fps: 10, sites: '', exclude: '' });
  const g = gifPrefs({ gifEnabled: false, gifMaxSec: 999, gifWidth: 999, gifFps: 7 });
  assert.equal(g.enabled, false);
  assert.equal(g.maxSec, GIF_LIMIT_SECONDS);
  assert.equal(g.width, 480, 'an unknown width falls back to 480');
  assert.equal(g.fps, 10);
  assert.equal(gifPrefs({ gifWidth: '320' }).width, 320);
  assert.equal(gifPrefs({ gifMaxSec: 0 }).maxSec, 60);
});
