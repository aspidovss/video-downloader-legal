// Updater package (Chrome / Edge, #62): versions, the GitHub release, the package build (1.6.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVersion, isNewer, releaseInfo, isUpdaterBuild, isEdge } from '../lib/updatecheck.js';
import { chromeManifest, build, packageName } from '../scripts/build-chrome.mjs';

test('update check: versions compare by numbers', () => {
  assert.deepEqual(parseVersion('v1.6.2'), [1, 6, 2]);
  assert.equal(parseVersion('1.6.4dev8'), null);
  assert.equal(isNewer('1.6.10', '1.6.9'), true);
  assert.equal(isNewer('v1.6.4', '1.6.4'), false);
  assert.equal(isNewer('1.6.3', '1.6.4'), false);
  assert.equal(isNewer('1.7', '1.6.4'), true);
  assert.equal(isNewer('garbage', '1.6.4'), false);
});

test('update check: the latest release gives the updater package of the browser, else the release page', () => {
  const rel = {
    tag_name: 'v1.6.5', html_url: 'https://github.com/aspidovss/video-downloader-legal/releases/tag/v1.6.5', draft: false, prerelease: false,
    assets: [
      { name: 'video-downloader-legal-chrome-1.6.5.zip', browser_download_url: 'https://github.com/x/chrome.zip' },
      { name: 'video-downloader-legal-chrome-updater-1.6.5.zip', browser_download_url: 'https://github.com/x/chrome-updater.zip' },
      { name: 'video-downloader-legal-edge-updater-1.6.5.zip', browser_download_url: 'https://github.com/x/edge-updater.zip' },
    ],
  };
  assert.deepEqual(releaseInfo(rel, '1.6.4'), { version: '1.6.5', page: rel.html_url, zip: 'https://github.com/x/chrome-updater.zip', newer: true });
  assert.equal(releaseInfo(rel, '1.6.4', true).zip, 'https://github.com/x/edge-updater.zip');
  assert.equal(releaseInfo({ ...rel, assets: [] }, '1.6.5').zip, '');
  assert.equal(releaseInfo({ ...rel, assets: [] }, '1.6.5').newer, false);
  assert.equal(releaseInfo({ ...rel, prerelease: true }, '1.6.4'), null);
  assert.equal(releaseInfo({ ...rel, html_url: 'https://evil.example/' }, '1.6.4').page, 'https://github.com/aspidovss/video-downloader-legal/releases/latest');
  assert.equal(isEdge('Mozilla/5.0 ... Chrome/130.0 Safari/537.36 Edg/130.0'), true);
  assert.equal(isEdge('Mozilla/5.0 ... Chrome/130.0 Safari/537.36'), false);
});

test('updater package: own service worker and version name; the regular package has no update check', () => {
  const src = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const up = chromeManifest(src, { updater: true });
  assert.equal(up.background.service_worker, 'platform/sw-updater.js');
  assert.equal(isUpdaterBuild(up), true);
  assert.deepEqual(up.permissions, chromeManifest(src).permissions, 'no extra permission');
  assert.equal(isUpdaterBuild(chromeManifest(src)), false);
  assert.equal(packageName('1.6.4', false, true), 'video-downloader-legal-chrome-updater-1.6.4.zip');
  assert.equal(packageName('1.6.4', true, true), 'video-downloader-legal-edge-updater-1.6.4.zip');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-upd-'));
  const { dir } = build({ outDir: path.join(tmp, 'plain') });
  assert.equal(fs.existsSync(path.join(dir, 'platform', 'updater.js')), false);
  const u = build({ updater: true, outDir: path.join(tmp, 'updater') });
  assert.equal(fs.existsSync(path.join(u.dir, 'platform', 'updater.js')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(u.dir, 'manifest.json'), 'utf8')).background.service_worker, 'platform/sw-updater.js');
  fs.rmSync(tmp, { recursive: true, force: true });
});
