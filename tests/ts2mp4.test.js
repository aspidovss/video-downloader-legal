import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { convertTs, tsToMp4, parseSps } from '../lib/ts2mp4.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); assert.equal(r.status, 0, String(r.stderr)); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-ts-'));
const out = (cmd, args) => String(spawnSync(cmd, args).stdout).trim();
const frames = (f) => out('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-fps_mode', 'passthrough', '-f', 'framemd5', '-']).split(/\r?\n/).filter((l) => !l.startsWith('#')).map((l) => l.split(',').pop().trim());
const pcm = (f) => spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:a', '-f', 's16le', '-']).stdout;
const probe = (f, e) => out('ffprobe', ['-v', 'error', '-show_entries', e, '-of', 'csv=p=0', f]);
const IN_V = (size) => ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30`];
const IN_A = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'];
const OUT_V = (extra = [], codec = 'libx264') => ['-t', '6', '-c:v', codec, '-pix_fmt', 'yuv420p', ...extra];

async function convert(src, dst) {
  const blob = new Blob([fs.readFileSync(src)]);
  const res = await tsToMp4(blob);
  assert.ok(res, 'converted');
  fs.writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
}

test('TS with B-frames + AAC at a stream clock: MP4 starts at 0, every video frame is identical, audio decodes', { skip: !hasFfmpeg }, async () => {
  const d = tmp();
  const ts = path.join(d, 'a.ts');
  const mp4 = path.join(d, 'a.mp4');
  ff(...IN_V('320x180'), ...IN_A, ...OUT_V(['-bf', '2', '-g', '45']), '-c:a', 'aac', '-output_ts_offset', '2654', '-f', 'mpegts', ts);
  await convert(ts, mp4);
  assert.equal(probe(mp4, 'format=start_time'), '0.000000');
  assert.deepEqual(frames(mp4), frames(ts));
  assert.ok(Math.abs(Number(probe(mp4, 'format=duration')) - 6) < 0.1);
  ff('-i', mp4, '-f', 'null', '-');
  const a = pcm(mp4);
  const b = pcm(ts);
  assert.ok(a.length > 0 && Math.abs(a.length - b.length) <= 2048 * 2, `audio ${a.length} vs ${b.length}`);
  assert.equal(probe(mp4, 'stream=codec_name').split(/\r?\n/).sort().join(), 'aac,h264');
});

test('HLS segments written by FFmpeg and joined (what the extension records) convert correctly', { skip: !hasFfmpeg }, async () => {
  const d = tmp();
  ff(...IN_V('640x360'), ...IN_A, ...OUT_V(['-g', '30']), '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(d, 's%d.ts'), path.join(d, 'p.m3u8'));
  const segs = fs.readdirSync(d).filter((x) => /^s\d+\.ts$/.test(x)).sort((x, y) => parseInt(x.slice(1)) - parseInt(y.slice(1)));
  assert.ok(segs.length >= 3);
  const joined = path.join(d, 'all.ts');
  fs.writeFileSync(joined, Buffer.concat(segs.map((s) => fs.readFileSync(path.join(d, s)))));
  const mp4 = path.join(d, 'all.mp4');
  await convert(joined, mp4);
  assert.deepEqual(frames(mp4), frames(joined));
  ff('-i', mp4, '-f', 'null', '-');
});

test('video only TS converts; High profile / larger picture keeps size', { skip: !hasFfmpeg }, async () => {
  const d = tmp();
  const ts = path.join(d, 'v.ts');
  const mp4 = path.join(d, 'v.mp4');
  ff(...IN_V('1280x720'), ...OUT_V(['-profile:v', 'high', '-bf', '3']), '-f', 'mpegts', ts);
  await convert(ts, mp4);
  assert.equal(probe(mp4, 'stream=width,height'), '1280,720');
  assert.deepEqual(frames(mp4), frames(ts));
});

test('Odd height (cropping in SPS) is read correctly', { skip: !hasFfmpeg }, async () => {
  const d = tmp();
  const ts = path.join(d, 'c.ts');
  const mp4 = path.join(d, 'c.mp4');
  ff(...IN_V('426x240'), ...OUT_V([]), '-vf', 'crop=422:238', '-f', 'mpegts', ts);
  await convert(ts, mp4);
  assert.equal(probe(mp4, 'stream=width,height'), '422,238');
});

test('not convertible input returns null and never throws', async () => {
  assert.equal(await tsToMp4(new Blob([new Uint8Array(5000)])), null);
  assert.equal(await tsToMp4(new Blob([])), null);
  assert.equal(convertTs(new Uint8Array(188 * 10)), null);
  assert.throws(() => parseSps(new Uint8Array([0x67, 0])));
});

test('HEVC in TS is left alone (null)', { skip: !hasFfmpeg || spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout.indexOf('libx265') < 0 }, async () => {
  const d = tmp();
  const ts = path.join(d, 'h.ts');
  ff(...IN_V('320x180'), ...OUT_V([], 'libx265'), '-f', 'mpegts', ts);
  assert.equal(convertTs(new Uint8Array(fs.readFileSync(ts))), null);
});
