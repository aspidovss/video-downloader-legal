import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebaseTimestamps } from '../lib/rebase.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); assert.equal(r.status, 0, String(r.stderr)); };
const startTime = (f) => Number(String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', f]).stdout).trim());
const md5 = (f, map) => String(spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-c', 'copy', '-map', map, '-f', 'md5', '-']).stdout);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-rb-'));
const join = async (blobs) => Buffer.concat(await Promise.all(blobs.map(async (x) => Buffer.from(await x.arrayBuffer()))));
const SRC = ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac'];

test('TS recording that starts at the stream clock is moved to 0, streams stay identical', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const src = path.join(dir, 'a.ts');
  ff(...SRC, '-output_ts_offset', '2654', '-f', 'mpegts', src);
  assert.ok(startTime(src) > 2000);
  const b = fs.readFileSync(src);
  const segs = [];
  for (let o = 0; o < b.length; o += 188 * 150) segs.push(new Blob([b.subarray(o, Math.min(b.length, o + 188 * 150))]));
  const out = path.join(dir, 'b.ts');
  fs.writeFileSync(out, await join(await rebaseTimestamps(segs, 'ts')));
  assert.ok(startTime(out) < 2, `start ${startTime(out)}`);
  assert.equal(md5(out, '0:v'), md5(src, '0:v'));
  assert.equal(md5(out, '0:a'), md5(src, '0:a'));
  ff('-i', out, '-f', 'null', '-');
});

test('fMP4 recording (init + fragments with a late tfdt) is moved to 0, streams stay identical', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const src = path.join(dir, 'a.mp4');
  ff(...SRC, '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', src);
  const d = fs.readFileSync(src);
  // like Twitch: split into blobs and add 2654 s to every tfdt
  const u32 = (o) => d.readUInt32BE(o);
  const top = [];
  for (let o = 0; o + 8 <= d.length;) { const n = u32(o); top.push({ t: d.toString('latin1', o + 4, o + 8), o, n }); o += n; }
  const scale = {};
  const kids = (o, n) => { const r = []; for (let p = o + 8; p + 8 <= o + n;) { const s = u32(p); r.push({ t: d.toString('latin1', p + 4, p + 8), o: p, n: s }); p += s; } return r; };
  for (const moov of top.filter((x) => x.t === 'moov')) for (const trak of kids(moov.o, moov.n).filter((x) => x.t === 'trak')) {
    const k = kids(trak.o, trak.n);
    const tid = u32(k.find((x) => x.t === 'tkhd').o + 8 + 12);
    const mdhd = kids(k.find((x) => x.t === 'mdia').o, k.find((x) => x.t === 'mdia').n).find((x) => x.t === 'mdhd');
    scale[tid] = u32(mdhd.o + 8 + 12);
  }
  const shifted = Buffer.from(d);
  for (const moof of top.filter((x) => x.t === 'moof')) for (const traf of kids(moof.o, moof.n).filter((x) => x.t === 'traf')) {
    const k = kids(traf.o, traf.n);
    const tid = u32(k.find((x) => x.t === 'tfhd').o + 8 + 4);
    const p = k.find((x) => x.t === 'tfdt').o + 8;
    const add = 2654 * scale[tid];
    if (shifted[p] === 1) { const v = Number(shifted.readBigUInt64BE(p + 4)) + add; shifted.writeBigUInt64BE(BigInt(v), p + 4); } else shifted.writeUInt32BE(shifted.readUInt32BE(p + 4) + add, p + 4);
  }
  const shiftedFile = path.join(dir, 'late.mp4');
  fs.writeFileSync(shiftedFile, shifted);
  assert.ok(startTime(shiftedFile) > 2000);
  const blobs = [];
  let cur = [];
  for (const x of top) { if (x.t === 'moof' && cur.length) { blobs.push(new Blob(cur)); cur = []; } cur.push(shifted.subarray(x.o, x.o + x.n)); }
  blobs.push(new Blob(cur));
  const out = path.join(dir, 'b.mp4');
  fs.writeFileSync(out, await join(await rebaseTimestamps(blobs, 'mp4')));
  assert.ok(startTime(out) < 0.5, `start ${startTime(out)}`);
  assert.equal(md5(out, '0:v'), md5(src, '0:v'));
  assert.equal(md5(out, '0:a'), md5(src, '0:a'));
  ff('-i', out, '-f', 'null', '-');
});

test('recordings that already start near 0, and unknown formats, are returned unchanged', async () => {
  const b = [new Blob([new Uint8Array(400)])];
  assert.equal(await rebaseTimestamps(b, 'aac'), b);
  assert.equal(await rebaseTimestamps(b, 'ts'), b);
  assert.deepEqual(await rebaseTimestamps([], 'mp4'), []);
});
