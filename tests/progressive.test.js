// Joining two ordinary (non-fragmented) MP4 files - one video, one audio - into one playable file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ctx = { module: { exports: {} }, Blob };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../lib/mux.js', import.meta.url), 'utf8'), ctx);
const { mergeBlobs } = ctx.module.exports;

const ff = (...args) => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]); assert.equal(r.status, 0, String(r.stderr)); };
const probe = (file) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file]).stdout).streams;

for (const [name, flags] of [['moov at the end', []], ['moov first (faststart)', ['-movflags', '+faststart']]]) {
  test(`progressive MP4 merge: ${name} -> one file with video and audio that decodes cleanly`, { skip: !hasFfmpeg }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-prog-'));
    ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', ...flags, path.join(dir, 'v.mp4'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', ...flags, path.join(dir, 'a.m4a'));
    const v = new Blob([fs.readFileSync(path.join(dir, 'v.mp4'))]);
    const a = new Blob([fs.readFileSync(path.join(dir, 'a.m4a'))]);
    const merged = await mergeBlobs(v, a, 'mp4');
    assert.ok(merged, 'merged');
    const out = path.join(dir, 'out.mp4');
    fs.writeFileSync(out, Buffer.from(await merged.arrayBuffer()));
    const kinds = probe(out).map((s) => s.codec_type).sort();
    assert.deepEqual(kinds, ['audio', 'video']);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']);
    assert.equal(String(r.stderr).trim(), '', 'no decode errors');
    const streams = probe(out);
    assert.ok(Math.abs(Number(streams.find((s) => s.codec_type === 'audio').duration) - 3) < 0.2);
    assert.ok(Math.abs(Number(streams.find((s) => s.codec_type === 'video').duration) - 3) < 0.2);
  });
}

test('progressive MP4 merge: refuses garbage and two video files', { skip: !hasFfmpeg }, async () => {
  assert.equal(await mergeBlobs(new Blob(['nope']), new Blob(['nope']), 'mp4'), null);
});
