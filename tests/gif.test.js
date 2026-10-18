// GIF encoder (lib/gif.js) and JoyReactor addresses (lib/joyreactor.js), 1.6.4.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGifEncoder, gifSize } from '../lib/gif.js';
import { jrParse, jrTitle, jrGifCandidates, isJoyreactorPage } from '../lib/joyreactor.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function frames(W, H, N) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  for (let f = 0; f < N; f++) {
    const a = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      const x = p % W;
      const y = Math.floor(p / W);
      // still background (gradient), a moving square, and noise in one corner (many colours, long LZW runs)
      let c = [(x * 255 / W) | 0, (y * 255 / H) | 0, 128];
      if (x >= f * 8 && x < f * 8 + 30 && y >= 40 && y < 70) c = [250, 30, 30];
      if (x < 40 && y < 40) c = [(rnd() * 256) | 0, (rnd() * 256) | 0, (rnd() * 256) | 0];
      a.set([...c, 255], p * 4);
    }
    out.push(a);
  }
  return out;
}

test('GIF: decodes in FFmpeg to the same frames (within the palette error), the still background is not stored again', { skip: !hasFfmpeg }, () => {
  const W = 160, H = 100, N = 10;
  const src = frames(W, H, N);
  const enc = createGifEncoder(W, H);
  for (const f of src) enc.addFrame(f, 10);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-gif-')), 'o.gif');
  fs.writeFileSync(file, Buffer.concat(enc.finish().map((b) => Buffer.from(b))));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.equal(String(r.stderr), '');
  assert.equal(r.stdout.length, W * H * 3 * N, 'every frame, full size');
  let sum = 0;
  let bad = 0;
  for (let f = 0; f < N; f++) {
    for (let p = 0; p < W * H; p++) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(r.stdout[(f * W * H + p) * 3 + c] - src[f][p * 4 + c]);
        sum += d;
        if (d > 40) bad++;
      }
    }
  }
  assert.ok(sum / (N * W * H * 3) < 6, `mean error ${sum / (N * W * H * 3)}`);
  assert.ok(bad < N * W * H * 3 * 0.002, `${bad} values off by more than 40`);
  const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString().trim();
  assert.ok(Math.abs(Number(dur) - 1) < 0.05, `duration ${dur}`);
  // later frames hold only the changed box (the square and the noise), not the whole picture
  const one = createGifEncoder(W, H);
  one.addFrame(src[0], 10);
  assert.equal(fs.statSync(file).size, enc.bytes);
  assert.ok(enc.bytes < one.bytes * N * 0.75, `size ${enc.bytes} vs one full frame ${one.bytes}`);
});

test('GIF: size from the video keeps the aspect, never upscales', () => {
  assert.deepEqual(gifSize(1280, 720, 480), { width: 480, height: 270 });
  assert.deepEqual(gifSize(300, 400, 480), { width: 300, height: 400 });
  assert.throws(() => createGifEncoder(0, 10));
});

test('JoyReactor: addresses of the post files, the GIF next to them, the name from the tags', () => {
  assert.deepEqual(jrParse('https://img0.joyreactor.com/pics/post/webm/videogif-gif-parrot-9524498.webm'), { host: 'img0.joyreactor.com', slug: 'videogif-gif-parrot', id: '9524498', fmt: 'webm' });
  assert.equal(jrParse('https://img10.joyreactor.cc/pics/post/mp4/cats-video-with-sound-9523827.mp4').fmt, 'mp4');
  assert.equal(jrParse('https://img1.joyreactor.com/pics/post/rats-videogif-gif-9524425.gif').fmt, 'gif');
  assert.equal(jrParse('https://img1.joyreactor.com/pics/post/cats-boss-9524419.webp'), null);
  assert.equal(jrParse('https://img1.joyreactor.com/pics/post/webm/x-1.mp4'), null);
  assert.equal(jrParse('https://example.com/pics/post/webm/x-1.webm'), null);
  assert.deepEqual(jrGifCandidates(jrParse('https://img0.joyreactor.com/pics/post/mp4/videogif-gif-parrot-9524498.mp4')), [
    'https://img0.joyreactor.com/pics/post/videogif-gif-parrot-9524498.gif',
    'https://img0.joyreactor.com/pics/post/full/videogif-gif-parrot-9524498.gif',
  ]);
  assert.equal(jrTitle('maine-coon-cats-video-with-sound'), 'maine coon cats');
  assert.equal(jrTitle('FemDraco-Potteriana-video-with-sound'), 'FemDraco Potteriana');
  assert.equal(jrTitle('videogif-gif'), '');
  assert.equal(isJoyreactorPage('https://joyreactor.com/'), true);
  assert.equal(isJoyreactorPage('https://anime.reactor.cc/post/1'), true);
  assert.equal(isJoyreactorPage('https://example.com/'), false);
});
