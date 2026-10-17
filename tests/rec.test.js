// Unit tests for the segment parsers inside injected/youtube_rec.js, using hand-built MP4/WebM structures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { module: { exports: {} }, Blob };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../lib/mux.js', import.meta.url), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(new URL('../injected/youtube_rec.js', import.meta.url), 'utf8'), ctx);
const { Mp4Parser, WebmParser, concat, decideEnd, looksLikeInit } = ctx.module.exports;

// ---- builders ----
const be = (n, bytes) => { const out = []; for (let i = bytes - 1; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) % 256); return out; };
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const box = (type, ...payload) => { const p = payload.flatMap((x) => (typeof x === 'number' ? [x] : [...x])); return Uint8Array.from([...be(8 + p.length, 4), ...ascii(type), ...p]); };
const tkhd = (height) => box('tkhd', [0, 0, 0, 0], new Array(72).fill(0), be(1280 << 16, 4), be(height << 16, 4)); // v0: width@76 height@80
const moov = (height) => box('moov', box('trak', tkhd(height)));
const moof = (time) => box('moof', box('mfhd', [0, 0, 0, 0, 0, 0, 0, 1]), box('traf', box('tfhd', [0, 0, 0, 0, 0, 0, 0, 1]), box('tfdt', [0, 0, 0, 0], be(time, 4))));
const frag = (time, payload) => [moof(time), box('mdat', payload)];

function feed(parser, bytes, chunk) {
  for (let o = 0; o < bytes.length; o += chunk) parser.push(bytes.slice(o, o + chunk));
}
function collect(Parser) {
  const state = { inits: [], frags: new Map(), meta: [] };
  const p = new Parser((i, m) => { state.inits.push(i); state.meta.push(m); }, (t, b) => state.frags.set(t, b));
  return { p, state };
}

test('MP4: init + fragments are reassembled from arbitrary chunking; height read from tkhd; styp/sidx dropped', () => {
  const file = concat([box('ftyp', ascii('isom'), [0, 0, 2, 0]), moov(720), box('styp', ascii('msdh')), box('sidx', [0, 0, 0, 0]), ...frag(0, [1, 2, 3]), ...frag(4000, [4, 5, 6, 7])]);
  for (const chunk of [1, 5, 13, 10000]) {
    const { p, state } = collect(Mp4Parser);
    feed(p, file, chunk);
    assert.equal(state.inits.length, 1, `chunk ${chunk}`);
    assert.equal(state.meta[0].height, 720);
    assert.deepEqual([...state.frags.keys()], [0, 4000]);
    assert.equal(String.fromCharCode(...state.inits[0].slice(4, 8)), 'ftyp');
    assert.deepEqual([...state.frags.get(4000).slice(-4)], [4, 5, 6, 7]);
  }
});

test('MP4: a second init (quality switch) starts a new representation', () => {
  const file = concat([box('ftyp', ascii('isom')), moov(360), ...frag(0, [1]), box('ftyp', ascii('isom')), moov(720), ...frag(0, [2])]);
  const { p, state } = collect(Mp4Parser);
  feed(p, file, 7);
  assert.deepEqual(state.meta.map((m) => m.height), [360, 720]);
});

// ---- WebM ----
const vsize = (n) => (n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 255]);
const el = (idBytes, payload) => { const p = [...payload]; return Uint8Array.from([...idBytes, ...vsize(p.length), ...p]); };
const EBML = el([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, ...ascii('webm')]);
const SEGMENT_HDR = Uint8Array.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const info = el([0x15, 0x49, 0xa9, 0x66], [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
const tracks = (h) => el([0x16, 0x54, 0xae, 0x6b], el([0xae], [...el([0xe0], [0xba, 0x82, h >> 8, h & 255])]));
const cluster = (tc, payload) => el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x82, tc >> 8, tc & 255, ...payload]);

test('WebM: init (EBML+Info+Tracks) and clusters are reassembled from arbitrary chunking; height read', () => {
  const file = concat([EBML, SEGMENT_HDR, el([0x11, 0x4d, 0x9b, 0x74], [1, 2, 3]), info, tracks(360), cluster(0, [0xa3, 0x81, 9]), cluster(1000, [0xa3, 0x81, 8]), el([0x1c, 0x53, 0xbb, 0x6b], [1])]);
  for (const chunk of [1, 3, 11, 10000]) {
    const { p, state } = collect(WebmParser);
    feed(p, file, chunk);
    assert.equal(state.inits.length, 1, `chunk ${chunk}`);
    assert.equal(state.meta[0].height, 360);
    assert.deepEqual([...state.frags.keys()], [0, 1000]);
    // rebuilt init keeps EBML header, advertises unknown-size Segment, drops SeekHead
    const init = state.inits[0];
    assert.deepEqual([...init.slice(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    assert.ok(Buffer.from(init).includes(Buffer.from(SEGMENT_HDR)));
    assert.equal(Buffer.from(init).includes(Buffer.from([0x11, 0x4d, 0x9b, 0x74])), false);
  }
});

const ucluster = (tc, payload) => Uint8Array.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x82, tc >> 8, tc & 255, ...payload]);

test('WebM live: clusters of unknown size are cut at the next cluster and re-emitted with a real size', () => {
  const file = concat([EBML, SEGMENT_HDR, info, tracks(720), ucluster(0, [0xa3, 0x81, 9, 0xa3, 0x82, 7, 7]), ucluster(2000, [0xa3, 0x81, 8]), ucluster(4000, [0xa3, 0x81, 5])]);
  for (const chunk of [1, 3, 11, 10000]) {
    const { p, state } = collect(WebmParser);
    feed(p, file, chunk);
    assert.equal(state.inits.length, 1, `chunk ${chunk}`);
    assert.equal(state.meta[0].height, 720);
    assert.deepEqual([...state.frags.keys()], [0, 2000], `chunk ${chunk}`); // the last one waits for its successor
    const c0 = state.frags.get(0);
    assert.deepEqual([...c0.slice(0, 5)], [0x1f, 0x43, 0xb6, 0x75, 0x01]);
    assert.equal(c0[11], 0x00 + (c0.length - 12)); // 8-byte size = payload length (small here)
    assert.equal(c0.length, 12 + 4 + 3 + 4); // header + timecode element + two blocks
  }
});

test('WebM live: a cluster whose children cannot be walked is still cut at the next cluster header', () => {
  const odd = [0xa0, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 2, 3, 0xa3, 0x81, 4]; // child of unknown size
  const file = concat([EBML, SEGMENT_HDR, info, tracks(720), ucluster(0, odd), ucluster(2000, [0xa3, 0x81, 8]), ucluster(4000, [0xa3, 0x81, 5])]);
  for (const chunk of [1, 7, 10000]) {
    const { p, state } = collect(WebmParser);
    feed(p, file, chunk);
    assert.deepEqual([...state.frags.keys()], [0, 2000], `chunk ${chunk}`);
  }
});

test('WebM live: joining mid-stream (seekCluster) skips the partial bytes up to the next cluster', () => {
  const head = concat([EBML, SEGMENT_HDR, info, tracks(360)]);
  const tail = concat([Uint8Array.from([0x81, 7, 7, 0xa3, 0x83, 1, 2]), ucluster(2000, [0xa3, 0x81, 8]), ucluster(4000, [0xa3, 0x81, 5]), ucluster(6000, [0xa3, 0x81, 1])]);
  for (const chunk of [1, 5, 10000]) {
    const { p, state } = collect(WebmParser);
    feed(p, head, 100000);
    p.seekCluster = true;
    feed(p, tail, chunk);
    assert.deepEqual([...state.frags.keys()], [2000, 4000], `chunk ${chunk}`);
  }
});

test('MP4 live: joining mid-segment (seekMoof) skips the bytes up to the next moof', () => {
  const box = (type, payload) => { const n = 8 + payload.length; return concat([Uint8Array.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...[...type].map((c) => c.charCodeAt(0))]), payload]); };
  const moof = (seq) => box('moof', concat([box('mfhd', Uint8Array.from([0, 0, 0, 0, 0, 0, 0, seq])), box('traf', concat([box('tfhd', Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1])), box('tfdt', Uint8Array.from([0, 0, 0, 0, 0, 0, 0, seq * 10]))]))]));
  const init = concat([box('ftyp', new Uint8Array(8)), box('moov', box('trak', new Uint8Array(4)))]);
  const tail = concat([Uint8Array.from([0x8e, 0x11, 0xc1, 0xcd, 0xc3, 0x80, 0x13, 0x65, 0x0b, 0x25, 0xd4, 0x11]), moof(1), box('mdat', new Uint8Array(30)), moof(2), box('mdat', new Uint8Array(30))]);
  for (const chunk of [1, 6, 10000]) {
    const { p, state } = collect(Mp4Parser);
    feed(p, init, 100000);
    p.seekMoof = true;
    feed(p, tail, chunk);
    assert.deepEqual([...state.frags.keys()], [10, 20], `chunk ${chunk}`);
  }
  // garbage that looks like a gigantic box must not stall the parser
  const { p, state } = collect(Mp4Parser);
  feed(p, init, 100000);
  feed(p, tail, 7);
  assert.equal(state.frags.size, 2);
});

test('WebM: garbage and truncated input never throw', () => {
  const { p } = collect(WebmParser);
  assert.doesNotThrow(() => { p.push(Uint8Array.from([0, 0, 0, 0, 0])); p.push(Uint8Array.from([0x1f, 0x43])); });
  const m = collect(Mp4Parser);
  assert.doesNotThrow(() => { m.p.push(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 2])); });
});

// ---- muxing (real media, skipped when ffmpeg is not installed) ----
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const { TrackCapture, mergeReps } = ctx.module.exports;

async function capture(file, mime) {
  const c = new TrackCapture(mime, () => {});
  const b = fs.readFileSync(file);
  for (let o = 0; o < b.length; o += 4000) c.parser.push(new Uint8Array(b.subarray(o, o + 4000)));
  return c;
}
function ff(...args) { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]); assert.equal(r.status, 0, String(r.stderr)); }
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
  return String(r.stdout).trim().split(/\s+/).sort().join(',');
}

for (const [name, vArgs, aArgs, vm_, am, ext] of [
  ['WebM', ['-c:v', 'libvpx-vp9', '-g', '25', '-f', 'webm'], ['-c:a', 'libopus', '-f', 'webm'], 'video/webm; codecs="vp9"', 'audio/webm; codecs="opus"', 'webm'],
  ['MP4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'], ['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'], 'video/mp4; codecs="avc1"', 'audio/mp4; codecs="mp4a"', 'mp4'],
]) {
  test(`${name}: recorded video + audio are joined into one playable file`, { skip: !hasFfmpeg }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-mux-'));
    const vf = path.join(dir, `v.${ext}`);
    const af = path.join(dir, `a.${ext}`);
    ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '5', ...vArgs, vf);
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '5', ...aArgs, af);
    const blob = await mergeReps(await capture(vf, vm_), await capture(af, am));
    assert.ok(blob, 'merge succeeded');
    const out = path.join(dir, `m.${ext}`);
    fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
    assert.equal(probe(out), 'audio,video');
    ff('-i', out, '-f', 'null', '-');
  });
}

test('WebM video + AAC (MP4) audio are joined into one Matroska file (no re-encoding)', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-mkv-'));
  const vf = path.join(dir, 'v.webm');
  const af = path.join(dir, 'a.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '6', '-c:v', 'libvpx-vp9', '-g', '25', '-f', 'webm', vf);
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', af);
  const blob = await mergeReps(await capture(vf, 'video/webm; codecs="vp9"'), await capture(af, 'audio/mp4; codecs="mp4a"'), { mkv: true });
  assert.ok(blob, 'merge succeeded');
  assert.equal(blob.type, 'video/x-matroska');
  const out = path.join(dir, 'm.mkv');
  fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  assert.equal(probe(out), 'audio,video');
  const codecs = String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out]).stdout).trim().split(/\s+/).sort().join(',');
  assert.equal(codecs, 'aac,vp9');
  ff('-i', out, '-f', 'null', '-'); // decodes cleanly
  // the audio really is there: about 6 s of a 440 Hz tone -> measurable level
  const vol = spawnSync('ffmpeg', ['-i', out, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  assert.match(String(vol.stderr), /mean_volume: -\d+/);
  const dur = Number(String(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out]).stdout).trim());
  assert.ok(dur > 200, `audio packets: ${dur}`); // 6 s of AAC 48 kHz is about 280 packets
});

test('WebM + AAC with different media offsets are cut to the common span and start at 0', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-mkv2-'));
  const vf = path.join(dir, 'v.webm');
  const af = path.join(dir, 'a.mp4');
  // video covers 5..15 s, audio covers 0..10 s of the stream clock -> common 5..10
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '10', '-c:v', 'libvpx-vp9', '-g', '50', '-output_ts_offset', '5', '-f', 'webm', vf);
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:a', 'aac', '-frag_duration', '1000000', '-movflags', 'empty_moov+default_base_moof', af);
  const blob = await mergeReps(await capture(vf, 'video/webm; codecs="vp9"'), await capture(af, 'audio/mp4; codecs="mp4a"'), { trimSilent: true });
  assert.ok(blob);
  const out = path.join(dir, 'm.mkv');
  fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  const r = String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'csv=p=0', out]).stdout).trim().split(/\s+/);
  for (const line of r) assert.ok(Number(line.split(',')[1]) < 2.5, `start_time ${line}`);
  ff('-i', out, '-f', 'null', '-');
  const dur = Number(String(spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'a:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out]).stdout).trim());
  assert.ok(dur > 140 && dur < 280, `audio packets ${dur}`); // 4-5 s of AAC at 48 kHz = 188-235 packets
});

test('WebM + AAC: no video without sound is left at the start or the end', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-mkv3-'));
  const vf = path.join(dir, 'v.webm');
  const af = path.join(dir, 'a.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '20', '-c:v', 'libvpx-vp9', '-g', '50', '-f', 'webm', vf);
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '15', '-c:a', 'aac', '-frag_duration', '1000000', '-movflags', 'empty_moov+default_base_moof', af);
  const aCap = await capture(af, 'audio/mp4; codecs="mp4a"');
  const aRep = aCap.best();
  for (const k of [...aRep.frags.keys()]) if (k < 5 * 48000) aRep.frags.delete(k); // audio only exists from ~5 s on
  const blob = await mergeReps(await capture(vf, 'video/webm; codecs="vp9"'), aCap, { trimSilent: true });
  assert.ok(blob);
  const out = path.join(dir, 'm.mkv');
  fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  const pts = (sel) => String(spawnSync('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', out]).stdout).trim().split(/\s+/).map(Number).sort((a, b) => a - b);
  const v = pts('v:0');
  const a = pts('a:0');
  assert.ok(Math.abs(v[0] - a[0]) < 0.3, `start v=${v[0]} a=${a[0]}`);
  assert.ok(Math.abs(v[v.length - 1] - a[a.length - 1]) < 2.2, `end v=${v[v.length - 1]} a=${a[a.length - 1]}`);
});

const hasEnc = (name) => hasFfmpeg && String(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout).includes(name);

for (const [label, enc, mime, codec] of [['AV1', 'libsvtav1', 'video/mp4; codecs="av01.0.05M.08"', 'av1'], ['H.264', 'libx264', 'video/mp4; codecs="avc1.4D401F"', 'h264']]) {
  test(`MP4 ${label} video + WebM Opus audio are joined into one Matroska file (no re-encoding)`, { skip: !hasEnc(enc) || !hasEnc('libopus') }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-opus-'));
    const vf = path.join(dir, 'v.mp4');
    const af = path.join(dir, 'a.webm');
    ff('-f', 'lavfi', '-i', 'testsrc=size=160x96:rate=25', '-t', '8', '-c:v', enc, '-g', '50', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', vf);
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:a', 'libopus', '-f', 'webm', af);
    const blob = await mergeReps(await capture(vf, mime), await capture(af, 'audio/webm; codecs="opus"'), { mkv: true });
    assert.ok(blob, 'merge succeeded');
    assert.equal(blob.type, 'video/x-matroska');
    const out = path.join(dir, 'm.mkv');
    fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
    const codecs = String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out]).stdout).trim().split(/\s+/).sort().join(',');
    assert.equal(codecs, `${codec},opus`);
    ff('-i', out, '-f', 'null', '-'); // decodes cleanly
    const frames = Number(String(spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out]).stdout).trim());
    assert.equal(frames, 200); // 8 s at 25 fps: every video sample is there
    const dur = Number(String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).stdout).trim());
    assert.ok(dur > 7.5 && dur < 8.6, `duration ${dur}`);
    const vol = spawnSync('ffmpeg', ['-i', out, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    assert.match(String(vol.stderr), /mean_volume: -\d+/);
  });
}

test('MP4 video + WebM Opus audio with different media offsets are cut to the common span and start at 0', { skip: !hasEnc('libx264') || !hasEnc('libopus') }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-opus2-'));
  const vf = path.join(dir, 'v.mp4');
  const af = path.join(dir, 'a.webm');
  // video covers 5..15 s of the stream clock, audio 0..10 s -> common 5..10
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x96:rate=25', '-t', '10', '-c:v', 'libx264', '-g', '50', '-output_ts_offset', '5', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', vf);
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:a', 'libopus', '-f', 'webm', af);
  const blob = await mergeReps(await capture(vf, 'video/mp4; codecs="avc1.4D401F"'), await capture(af, 'audio/webm; codecs="opus"'));
  assert.ok(blob);
  const out = path.join(dir, 'm.mkv');
  fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  const starts = String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', out]).stdout).trim().split(/\s+/).map(Number);
  for (const st of starts) assert.ok(st < 2.5, `start_time ${st}`);
  ff('-i', out, '-f', 'null', '-');
});

test('MP4 + WebM merge refuses what it cannot copy: VP9 in MP4 is not handled, garbage gives null', async () => {
  const mk = (mime, container, kind) => { const c = new TrackCapture(mime, () => {}); c.container = container; c.kind = kind; c.reps.set('x', { init: new Uint8Array(8), frags: new Map([[0, new Blob([1])]]), height: 0, bytes: 1 }); return c; };
  assert.equal(await mergeReps(mk('video/mp4', 'mp4', 'video'), mk('audio/webm', 'webm', 'audio')), null);
});

test('merge refuses mixed containers', async () => {
  const mk = (mime) => { const c = new TrackCapture(mime, () => {}); c.reps.set('x', { init: new Uint8Array(1), frags: new Map([[0, new Blob([1])]]), height: 0, bytes: 1 }); return c; };
  assert.equal(await mergeReps(mk('video/webm'), mk('audio/mp4')), null);
});

test('recording end: margin scales with playback speed, so 2x/4x playback cannot jump over the end', () => {
  const base = { duration: 269, bufferedEnd: 269, speed: 2, ad: false, idChanged: false, durChanged: false, holdMs: 0 };
  assert.equal(decideEnd({ ...base, current: 100 }), 'continue');
  assert.equal(decideEnd({ ...base, current: 266.9 }), 'continue', 'more than speed*1s left');
  assert.equal(decideEnd({ ...base, current: 267.1 }), 'finish', 'within the 2 s margin and fully buffered');
  assert.equal(decideEnd({ ...base, speed: 4, current: 265.5 }), 'finish', '4x uses a 4 s margin');
  assert.equal(decideEnd({ ...base, speed: 1, current: 268.6 }), 'finish');
  assert.equal(decideEnd({ ...base, speed: 1, current: 267.9 }), 'continue');
});

test('recording end: waits (paused) for the last segments, gives up after 8 s', () => {
  const near = { duration: 269, current: 268.5, speed: 2, ad: false, idChanged: false, durChanged: false };
  assert.equal(decideEnd({ ...near, bufferedEnd: 250, holdMs: 0 }), 'hold');
  assert.equal(decideEnd({ ...near, bufferedEnd: 250, holdMs: 7000 }), 'hold');
  assert.equal(decideEnd({ ...near, bufferedEnd: 250, holdMs: 8500 }), 'finish');
  assert.equal(decideEnd({ ...near, bufferedEnd: 268.8, holdMs: 100 }), 'finish', 'tail arrived');
});

test('recording end: another video or a changed duration ends the recording at once; ads never do', () => {
  const base = { duration: 269, current: 12, bufferedEnd: 40, speed: 2, holdMs: 0 };
  assert.equal(decideEnd({ ...base, ad: false, idChanged: true, durChanged: false }), 'finish');
  assert.equal(decideEnd({ ...base, ad: false, idChanged: false, durChanged: true }), 'finish');
  assert.equal(decideEnd({ ...base, ad: true, idChanged: true, durChanged: true }), 'continue', 'ad showing: ignore everything');
  assert.equal(decideEnd({ ...base, duration: 0, current: 0, ad: false, idChanged: false, durChanged: false }), 'continue');
});

test('init-segment detection (lets a live recording start without a page reload)', () => {
  const pad = (a) => Uint8Array.from([...a, ...new Array(Math.max(0, 16 - a.length)).fill(0)]);
  assert.equal(looksLikeInit(pad([0x1a, 0x45, 0xdf, 0xa3])), true); // WebM EBML header
  assert.equal(looksLikeInit(pad([0, 0, 0, 0x18, ...ascii('ftyp')])), true); // MP4 ftyp
  assert.equal(looksLikeInit(pad([0, 0, 0x02, 0x00, ...ascii('moov')])), true);
  assert.equal(looksLikeInit(pad([0x1f, 0x43, 0xb6, 0x75])), false); // WebM cluster
  assert.equal(looksLikeInit(pad([0, 0, 0x01, 0x00, ...ascii('moof')])), false); // MP4 fragment
  assert.equal(looksLikeInit(Uint8Array.of(1, 2, 3)), false);
});

test('MP4 video + audio with different fragment lengths become an ordinary MP4 with identical streams', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-flat-'));
  const vf = path.join(dir, 'v.mp4');
  const af = path.join(dir, 'a.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-bf', '2', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', vf);
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '12', '-c:a', 'aac', '-movflags', 'empty_moov+default_base_moof', '-frag_duration', '6000000', af);
  const blob = await mergeReps(await capture(vf, 'video/mp4; codecs="avc1"'), await capture(af, 'audio/mp4; codecs="mp4a"'));
  assert.ok(blob);
  const bytes = Buffer.from(await blob.arrayBuffer());
  const out = path.join(dir, 'm.mp4');
  fs.writeFileSync(out, bytes);
  const top = [];
  for (let p = 0; p + 8 <= bytes.length;) { const n = bytes.readUInt32BE(p); top.push(bytes.toString('latin1', p + 4, p + 8)); p += n; }
  assert.deepEqual(top, ['ftyp', 'moov', 'mdat']); // no moof: not fragmented
  const md5 = (f, map) => String(spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-c', 'copy', '-map', map, '-f', 'md5', '-']).stdout);
  assert.equal(md5(out, '0:v'), md5(vf, '0:v'));
  assert.equal(md5(out, '0:a'), md5(af, '0:a'));
  ff('-i', out, '-f', 'null', '-');
});

// ---- Matroska layout of the joined files: seekable in ordinary players ----
function mkvLayout(buf) {
  const vi = (o, id) => { const f = buf[o]; let l = 1; let m = 0x80; while (l <= 8 && !(f & m)) { l++; m >>= 1; } let v = id ? f : f & (m - 1); let ones = (f & (m - 1)) === m - 1; for (let i = 1; i < l; i++) { v = v * 256 + buf[o + i]; if (buf[o + i] !== 255) ones = false; } return { v, l, unknown: !id && ones }; };
  const kids = (start, end) => { const out = []; let o = start; while (o < end) { const id = vi(o, true); const sz = vi(o + id.l, false); out.push({ id: id.v, start: o, data: o + id.l + sz.l, end: o + id.l + sz.l + sz.v }); o += id.l + sz.l + sz.v; } return out; };
  const uint = (e) => { let v = 0; for (let i = e.data; i < e.end; i++) v = v * 256 + buf[i]; return v; };
  const [ebml] = kids(0, buf.length);
  const sid = vi(ebml.end, true);
  const ssz = vi(ebml.end + sid.l, false);
  const segData = ebml.end + sid.l + ssz.l;
  const top = kids(segData, buf.length);
  const cues = top.find((e) => e.id === 0x1c53bb6b);
  const points = cues ? kids(cues.data, cues.end).map((cp) => { const k = kids(cp.data, cp.end); const tp = kids(k.find((x) => x.id === 0xb7).data, k.find((x) => x.id === 0xb7).end); return { time: uint(k.find((x) => x.id === 0xb3)), track: uint(tp.find((x) => x.id === 0xf7)), pos: uint(tp.find((x) => x.id === 0xf1)) }; }) : [];
  const clusters = top.filter((e) => e.id === 0x1f43b675).map((c) => ({ pos: c.start - segData, tracks: new Set(kids(c.data, c.end).filter((b) => b.id === 0xa3 || b.id === 0xa0).map((b) => buf[b.id === 0xa3 ? b.data : kids(b.data, b.end)[0].data] & 0x7f)) }));
  const seek = top[0].id === 0x114d9b74 ? kids(top[0].data, top[0].end).map((s) => { const k = kids(s.data, s.end); return { id: k[0], pos: uint(k[1]) }; }) : [];
  return { unknownSize: ssz.unknown, sizeOk: segData + ssz.v === buf.length, firstId: top[0].id, seekTargets: seek.map((s) => top.find((e) => e.start - segData === s.pos)?.id), points, clusters };
}

for (const [label, make, enc] of [
  ['H.264 + Opus', (dir) => {
    const vf = path.join(dir, 'v.mp4'); const af = path.join(dir, 'a.webm');
    ff('-f', 'lavfi', '-i', 'testsrc=size=160x96:rate=25', '-t', '20', '-c:v', 'libx264', '-g', '50', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', vf);
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-c:a', 'libopus', '-f', 'webm', af);
    return [vf, 'video/mp4; codecs="avc1.4D401F"', af, 'audio/webm; codecs="opus"'];
  }, 'libx264'],
  ['VP9 + AAC', (dir) => {
    const vf = path.join(dir, 'v.webm'); const af = path.join(dir, 'a.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '20', '-c:v', 'libvpx-vp9', '-g', '50', '-f', 'webm', vf);
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', af);
    return [vf, 'video/webm; codecs="vp9"', af, 'audio/mp4; codecs="mp4a"'];
  }, 'libvpx-vp9'],
  ['VP9 + Opus (.webm)', (dir) => {
    const vf = path.join(dir, 'v.webm'); const af = path.join(dir, 'a.webm');
    ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '20', '-c:v', 'libvpx-vp9', '-g', '50', '-f', 'webm', vf);
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-c:a', 'libopus', '-f', 'webm', af);
    return [vf, 'video/webm; codecs="vp9"', af, 'audio/webm; codecs="opus"'];
  }, 'libvpx-vp9'],
]) {
  test(`${label} -> .mkv: known size, SeekHead, interleaved clusters, Cues; a seek reads only a part of the file`, { skip: !hasEnc(enc) || !hasEnc(label.includes('Opus') ? 'libopus' : 'aac') }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-seek-'));
    const [vf, vm, af, am] = make(dir);
    const blob = await mergeReps(await capture(vf, vm), await capture(af, am), { mkv: true });
    assert.ok(blob);
    const buf = Buffer.from(await blob.arrayBuffer());
    const out = path.join(dir, 'm.mkv');
    fs.writeFileSync(out, buf);
    const L = mkvLayout(buf);
    assert.equal(L.unknownSize, false);
    assert.ok(L.sizeOk, 'Segment size = rest of the file');
    assert.equal(L.firstId, 0x114d9b74, 'SeekHead first');
    assert.deepEqual(L.seekTargets, [0x1549a966, 0x1654ae6b, 0x1c53bb6b], 'SeekHead -> Info, Tracks, Cues');
    assert.ok(L.points.length >= 8, `cue points: ${L.points.length}`); // 20 s, keyframe every 2 s
    const at = new Set(L.clusters.map((c) => c.pos));
    for (const p of L.points) { assert.ok(at.has(p.pos), `cue ${p.time} -> cluster`); assert.equal(p.track, 1); }
    assert.ok(L.clusters.filter((c) => c.tracks.size === 2).length >= L.clusters.length - 1, 'both tracks share the clusters');
    ff('-i', out, '-f', 'null', '-');
    const vPk = Number(String(spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out]).stdout).trim());
    assert.equal(vPk, 500, 'all 20 s x 25 fps video frames'); // nothing lost on the way
    if (label.includes('.webm')) { assert.equal(blob.type, 'video/webm'); assert.ok(buf.includes(Buffer.from('webm')), 'DocType webm'); }
    // seeking to 15 s with the index: far less than the whole file is read, and sound comes with the picture
    const r = spawnSync('ffmpeg', ['-v', 'debug', '-ss', '15', '-i', out, '-t', '1', '-f', 'null', '-']);
    const read = Number((/Statistics: (\d+) bytes read/.exec(String(r.stderr)) || [])[1]);
    assert.ok(read < buf.length * 0.6, `read ${read} of ${buf.length}`);
    const pk = String(spawnSync('ffprobe', ['-v', 'error', '-read_intervals', '15%+1', '-show_entries', 'packet=stream_index', '-of', 'csv=p=0', out]).stdout).trim().split(/\s+/);
    assert.ok(pk.includes('0') && pk.includes('1'), 'both tracks right after the seek');
  });
}


// ---- default since 1.6.0dev6: the joins of different containers are written as an ordinary MP4 ----
// (Telegram Desktop sends any MP4 / WebM as a video, an .mkv as a document: test of 17.10.2026)
function topBoxes(buf) { const out = []; let i = 0; while (i + 8 <= buf.length) { let sz = buf.readUInt32BE(i); const ty = buf.toString('latin1', i + 4, i + 8); if (sz === 1) sz = Number(buf.readBigUInt64BE(i + 8)); out.push(ty); if (sz < 8) break; i += sz; } return out; }

for (const [label, enc, vmime, amime, venc, aenc, vext, aext, codecs] of [
  ['AV1 (MP4) + Opus', 'libsvtav1', 'video/mp4; codecs="av01.0.05M.08"', 'audio/webm; codecs="opus"', ['-c:v', 'libsvtav1', '-preset', '12', '-g', '50'], ['-c:a', 'libopus'], 'mp4', 'webm', 'av1,opus'],
  ['H.264 with B-frames (MP4) + Opus', 'libx264', 'video/mp4; codecs="avc1.64001F"', 'audio/webm; codecs="opus"', ['-c:v', 'libx264', '-bf', '2', '-g', '50'], ['-c:a', 'libopus'], 'mp4', 'webm', 'h264,opus'],
  ['VP9 (WebM) + AAC', 'libvpx-vp9', 'video/webm; codecs="vp9"', 'audio/mp4; codecs="mp4a"', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', '50'], ['-c:a', 'aac'], 'webm', 'mp4', 'aac,vp9'],
  ['AV1 (WebM) + AAC', 'libsvtav1', 'video/webm; codecs="av01"', 'audio/mp4; codecs="mp4a"', ['-c:v', 'libsvtav1', '-preset', '12', '-g', '50'], ['-c:a', 'aac'], 'webm', 'mp4', 'aac,av1'],
]) {
  test(`${label} -> ordinary MP4 (index first, both tracks complete, in sync, seekable)`, { skip: !hasEnc(enc) || !hasEnc(aenc[1]) }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-mp4j-'));
    const vf = path.join(dir, `v.${vext}`); const af = path.join(dir, `a.${aext}`);
    const fragV = vext === 'mp4' ? ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'] : ['-f', 'webm'];
    const fragA = aext === 'mp4' ? ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'] : ['-f', 'webm'];
    ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '12', '-pix_fmt', 'yuv420p', ...venc, ...fragV, vf);
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', ...aenc, ...fragA, af);
    const blob = await mergeReps(await capture(vf, vmime), await capture(af, amime));
    assert.ok(blob, 'merge succeeded');
    assert.equal(blob.type, 'video/mp4');
    const buf = Buffer.from(await blob.arrayBuffer());
    assert.deepEqual(topBoxes(buf), ['ftyp', 'moov', 'mdat'], 'index before the data');
    const out = path.join(dir, 'm.mp4');
    fs.writeFileSync(out, buf);
    assert.equal(String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out]).stdout).trim().split(/\s+/).sort().join(','), codecs);
    ff('-i', out, '-f', 'null', '-');
    const n = (sel) => Number(String(spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', sel, '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out]).stdout).trim());
    assert.equal(n('v:0'), 300, 'every video frame (12 s x 25 fps)');
    assert.ok(n('a:0') > 400, `audio packets ${n('a:0')}`);
    const st = String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=start_time,duration', '-of', 'csv=p=0', out]).stdout).trim().split(/\s+/).map((l) => l.split(',').map(Number));
    for (const [start, dur] of st) { assert.ok(Math.abs(start) < 0.1, `start ${start}`); assert.ok(dur > 11.5 && dur < 12.3, `duration ${dur}`); }
    const vol = spawnSync('ffmpeg', ['-i', out, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    assert.match(String(vol.stderr), /mean_volume: -\d+/);
    // a seek to 8 s finds the frame through the index
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', '8', '-i', out, '-frames:v', '1', '-f', 'null', '-']);
    assert.equal(r.status, 0);
  });
}

test('MP4 writer: Opus packet durations from the TOC byte; the Opus head becomes dOps', () => {
  const { opusPacketSamples, opusEntry } = ctx.module.exports;
  assert.equal(opusPacketSamples(Uint8Array.of(0xfc)), 960); // CELT 20 ms, one frame
  assert.equal(opusPacketSamples(Uint8Array.of(0xfd)), 1920); // two frames
  assert.equal(opusPacketSamples(Uint8Array.of(0x78)), 960); // hybrid 20 ms
  assert.equal(opusPacketSamples(Uint8Array.of(0x03, 0x03)), 1440); // SILK 10 ms x 3
  const head = Uint8Array.from([...Buffer.from('OpusHead'), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
  const e = opusEntry(head);
  assert.equal(e.preSkip, 312);
  assert.equal(e.channels, 2);
  assert.ok(Buffer.from(e.entry).includes(Buffer.from('dOps')));
});
