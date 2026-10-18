// MPEG-TS -> Matroska without re-encoding (lib/ts2mp4.js convertTsMkv + lib/mux.js writeMkvAvcAac), 1.6.4.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { tsToMkv, convertTsMkv } from '../lib/ts2mp4.js';

const ctx = { module: { exports: {} }, Blob };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../lib/mux.js', import.meta.url), 'utf8'), ctx);
const mux = ctx.module.exports;

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); assert.equal(r.status, 0, String(r.stderr)); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-mkv-'));
const out = (cmd, args) => String(spawnSync(cmd, args).stdout).trim();
const frames = (f) => out('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-fps_mode', 'passthrough', '-f', 'framemd5', '-']).split(/\r?\n/).filter((l) => !l.startsWith('#')).map((l) => l.split(',').pop().trim());
const pcm = (f) => spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:a', '-f', 's16le', '-']).stdout;
const probe = (f, e) => out('ffprobe', ['-v', 'error', '-show_entries', e, '-of', 'csv=p=0', f]);
const IN_V = (size) => ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30`];
const IN_A = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'];
const OUT_V = (extra = []) => ['-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...extra];

async function convert(src, dst) {
  const res = await tsToMkv(new Blob([fs.readFileSync(src)]), mux);
  assert.ok(res, 'converted');
  assert.equal(res.type, 'video/x-matroska');
  fs.writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
}

test('TS with B-frames + AAC at a stream clock -> MKV: starts at 0, same frames, audio decodes, seekable', { skip: !hasFfmpeg }, async () => {
  const d = tmp();
  const ts = path.join(d, 'a.ts');
  const mkv = path.join(d, 'a.mkv');
  ff(...IN_V('320x180'), ...IN_A, ...OUT_V(['-bf', '2', '-g', '45']), '-c:a', 'aac', '-output_ts_offset', '2654', '-f', 'mpegts', ts);
  await convert(ts, mkv);
  assert.match(probe(mkv, 'format=format_name'), /matroska/);
  assert.ok(Math.abs(Number(probe(mkv, 'format=start_time'))) < 0.05);
  assert.deepEqual(frames(mkv), frames(ts));
  assert.ok(Math.abs(Number(probe(mkv, 'format=duration')) - 6) < 0.15);
  ff('-i', mkv, '-f', 'null', '-');
  const a = pcm(mkv);
  const b = pcm(ts);
  assert.ok(a.length > 0 && Math.abs(a.length - b.length) <= 2048 * 2, `audio ${a.length} vs ${b.length}`);
  assert.equal(probe(mkv, 'stream=codec_name').split(/\r?\n/).sort().join(), 'aac,h264');
  ff('-ss', '4', '-i', mkv, '-frames:v', '1', '-f', 'null', '-'); // seeking through Cues works
});

test('HLS segments joined -> MKV keeps every frame; video only TS keeps the picture size', { skip: !hasFfmpeg }, async () => {
  const d = tmp();
  ff(...IN_V('640x360'), ...IN_A, ...OUT_V(['-g', '30']), '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(d, 's%d.ts'), path.join(d, 'p.m3u8'));
  const segs = fs.readdirSync(d).filter((x) => /^s\d+\.ts$/.test(x)).sort((x, y) => parseInt(x.slice(1)) - parseInt(y.slice(1)));
  const joined = path.join(d, 'all.ts');
  fs.writeFileSync(joined, Buffer.concat(segs.map((s) => fs.readFileSync(path.join(d, s)))));
  await convert(joined, path.join(d, 'all.mkv'));
  assert.deepEqual(frames(path.join(d, 'all.mkv')), frames(joined));

  const ts = path.join(d, 'v.ts');
  ff(...IN_V('1280x720'), ...OUT_V(['-profile:v', 'high', '-bf', '3']), '-f', 'mpegts', ts);
  await convert(ts, path.join(d, 'v.mkv'));
  assert.equal(probe(path.join(d, 'v.mkv'), 'stream=width,height'), '1280,720');
  assert.deepEqual(frames(path.join(d, 'v.mkv')), frames(ts));
});

test('MKV: not convertible input or no writer -> null, never throws', async () => {
  assert.equal(await tsToMkv(new Blob([new Uint8Array(5000)]), mux), null);
  assert.equal(convertTsMkv(new Uint8Array(188 * 10), mux), null);
  assert.equal(convertTsMkv(new Uint8Array(188 * 10), null), null);
});
