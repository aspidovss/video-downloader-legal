// Converter: a part of a video cut out without re-encoding (lib/mux.js trimMp4 / trimMkv), 1.6.8.
// FFmpeg makes the test files and checks the results (only when it is installed; see THIRD-PARTY.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const ctx = { module: { exports: {} }, Blob };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../lib/mux.js', import.meta.url), 'utf8'), ctx);
const mux = ctx.module.exports;

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-trim-'));
const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); assert.equal(r.status, 0, String(r.stderr)); };
const probe = (f) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', f]).stdout.toString());
const decodes = (f) => spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']).stderr.toString().trim() === '';
const firstFrame = (f, ss = null) => spawnSync('ffmpeg', ['-v', 'error', ...(ss != null ? ['-ss', String(ss)] : []), '-i', f, '-frames:v', '1', '-f', 'framemd5', '-']).stdout.toString().split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim())[0];

const src = (name) => path.join(dir, name);
if (hasFfmpeg) {
  const lav = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20'];
  ff(...lav, '-c:v', 'libx264', '-g', '50', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src('prog.mp4'));
  ff('-i', src('prog.mp4'), '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov', src('frag.mp4'));
  ff('-i', src('prog.mp4'), '-c', 'copy', src('h264.mkv'));
  ff('-i', src('prog.mp4'), '-vn', '-c:a', 'copy', src('sound.m4a'));
  ff(...lav, '-c:v', 'libvpx-vp9', '-g', '50', '-deadline', 'realtime', '-b:v', '150k', '-c:a', 'libopus', '-shortest', src('vp9.webm'));
}

const cases = [['prog.mp4', 'trimMp4'], ['frag.mp4', 'trimMp4'], ['h264.mkv', 'trimMkv'], ['vp9.webm', 'trimMkv']];
for (const [name, fn] of cases) {
  test(`cut ${name} 5.3 s – 12.25 s: starts at the keyframe before, decodes, both tracks, right length`, { skip: !hasFfmpeg }, async () => {
    const r = await mux[fn](new Blob([fs.readFileSync(src(name))]), 5.3, 12.25);
    assert.ok(r, 'no result');
    assert.ok(r.from <= 5.3 + 1e-6 && r.from >= 3.9, `from ${r.from}`); // keyframes every 2 s
    const out = src(`cut-${name}`);
    fs.writeFileSync(out, Buffer.from(await r.blob.arrayBuffer()));
    assert.ok(decodes(out));
    const p = probe(out);
    assert.deepEqual(p.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
    assert.ok(Math.abs(Number(p.format.duration) - (12.25 - r.from)) < 0.25, `duration ${p.format.duration} vs ${12.25 - r.from}`);
    assert.equal(firstFrame(out), firstFrame(src(name), r.from)); // the same picture as the source at `from`
  });
}

test('cut an M4A (sound only): exact start, no video needed', { skip: !hasFfmpeg }, async () => {
  const r = await mux.trimMp4(new Blob([fs.readFileSync(src('sound.m4a'))]), 3, 6);
  assert.ok(r);
  assert.ok(Math.abs(r.from - 3) < 0.03, `from ${r.from}`);
  const out = src('cut.m4a');
  fs.writeFileSync(out, Buffer.from(await r.blob.arrayBuffer()));
  assert.ok(decodes(out));
  assert.ok(Math.abs(Number(probe(out).format.duration) - 3) < 0.1);
});

test('cut: a start inside the first GOP begins at 0; garbage gives null', { skip: !hasFfmpeg }, async () => {
  const r = await mux.trimMp4(new Blob([fs.readFileSync(src('prog.mp4'))]), 1, 3);
  assert.equal(r.from, 0);
  assert.equal(await mux.trimMp4(new Blob([new Uint8Array(1000)]), 1, 2), null);
  assert.equal(await mux.trimMkv(new Blob([new Uint8Array(1000)]), 1, 2), null);
});
