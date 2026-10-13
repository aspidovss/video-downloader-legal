import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { describeInit } from '../lib/mp4info.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ctx = { module: { exports: {} }, Blob };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../lib/mux.js', import.meta.url), 'utf8'), ctx);

test('describeInit: tracks, timescales, sample entries and edit lists of a real fragmented mp4', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-info-'));
  const f = path.join(dir, 'a.m4a');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:a', 'aac', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', f]);
  assert.equal(r.status, 0, String(r.stderr));
  const info = describeInit(fs.readFileSync(f));
  assert.equal(info.fragmented, true);
  assert.equal(info.tracks.length, 1);
  assert.equal(info.tracks[0].handler, 'soun');
  assert.equal(info.tracks[0].entry, 'mp4a');
  assert.ok(info.tracks[0].timescale > 0 && info.movieTimescale > 0);
});

test('merging two fragmented mp4: the audio edit list is not carried into the joined movie, video keeps its own', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-edts-'));
  const run = (...a) => assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]).status, 0);
  const fm = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'];
  run('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2', ...fm, path.join(dir, 'v.mp4'));
  run('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', ...fm, path.join(dir, 'a.m4a'));
  const v = new Blob([fs.readFileSync(path.join(dir, 'v.mp4'))]);
  const a = new Blob([fs.readFileSync(path.join(dir, 'a.m4a'))]);
  const merged = await ctx.module.exports.mergeBlobs(v, a, 'mp4');
  assert.ok(merged);
  const info = describeInit(new Uint8Array(await merged.arrayBuffer()));
  assert.equal(info.tracks.length, 2);
  const [vt, at] = info.tracks;
  assert.equal(at.edits.length, 0, 'audio edit list removed');
  assert.notEqual(vt.id, at.id);
  const out = path.join(dir, 'out.mp4');
  fs.writeFileSync(out, Buffer.from(await merged.arrayBuffer()));
  const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', out]).stdout).streams;
  assert.deepEqual(probe.map((s) => s.codec_type).sort(), ['audio', 'video']);
  assert.ok(Math.abs(Number(probe.find((s) => s.codec_type === 'audio').duration) - 3) < 0.3);
  assert.equal(String(spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']).stderr).trim(), '');
});
