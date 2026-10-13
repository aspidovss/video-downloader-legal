import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { id3Tag, encodeMp3, floatToInt16, mp3Bitrate, mp3EstimateBytes, decodeToPcm, MP3_MAX_SECONDS } from '../lib/mp3.js';

test('mp3 helpers: bitrate whitelist, size estimate, int16 conversion clamps', () => {
  assert.equal(mp3Bitrate(320), 320);
  assert.equal(mp3Bitrate(999), 192);
  assert.equal(mp3Bitrate('128'), 128);
  assert.equal(mp3EstimateBytes(269, 192), 6456000);
  assert.deepEqual([...floatToInt16(Float32Array.of(0, 1, -1, 2, -2, 0.5))], [0, 32767, -32768, 32767, -32768, 16384]);
  assert.ok(MP3_MAX_SECONDS >= 1800);
});

test('encodeMp3: feeds 16-bit blocks to the encoder, reports progress, adds the ID3 tag and flushes', async () => {
  const calls = [];
  const lame = { Mp3Encoder: class { constructor(ch, rate, kbps) { calls.push(['new', ch, rate, kbps]); }
    encodeBuffer(l, r) { calls.push(['buf', l.constructor.name, l.length, r ? r.length : 0]); return Uint8Array.of(1, 2, 3); }
    flush() { calls.push(['flush']); return Uint8Array.of(9); } } };
  const pcm = { sampleRate: 44100, channels: [new Float32Array(50000), new Float32Array(50000)] };
  const prog = [];
  const out = await encodeMp3(pcm, { kbps: 256, lame, title: 'Привет – test', onProgress: (p) => prog.push(p) });
  assert.deepEqual(calls[0], ['new', 2, 44100, 256]);
  assert.ok(calls.some((c) => c[0] === 'buf' && c[1] === 'Int16Array' && c[3] === c[2]));
  assert.deepEqual(calls.at(-1), ['flush']);
  assert.equal(prog.at(-1), 1);
  assert.equal(String.fromCharCode(...out[0].slice(0, 3)), 'ID3');
  assert.deepEqual([...out.at(-1)], [9]);
});

test('encodeMp3: mono input uses one channel; missing encoder and abort are reported', async () => {
  let ch = 0;
  const lame = { Mp3Encoder: class { constructor(c) { ch = c; } encodeBuffer() { return []; } flush() { return []; } } };
  await encodeMp3({ sampleRate: 48000, channels: [new Float32Array(3000)] }, { lame });
  assert.equal(ch, 1);
  await assert.rejects(encodeMp3({ sampleRate: 44100, channels: [new Float32Array(10)] }, {}), /mp3_encoder_missing/);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(encodeMp3({ sampleRate: 44100, channels: [new Float32Array(100000)] }, { lame, signal: ctl.signal }), /aborted/);
});

test('decodeToPcm: wraps decodeAudioData, keeps at most two channels', async () => {
  const ctx = { decodeAudioData: async () => ({ numberOfChannels: 6, sampleRate: 44100, duration: 2, getChannelData: (c) => new Float32Array([c]) }) };
  const pcm = await decodeToPcm(new ArrayBuffer(8), () => ctx);
  assert.equal(pcm.channels.length, 2);
  assert.equal(pcm.seconds, 2);
});

test('id3Tag: a real decoder reads the title back (UTF-16, non-ASCII, emoji)', { skip: spawnSync('ffprobe', ['-version']).status !== 0 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'id3-'));
  const raw = path.join(dir, 'a.mp3');
  const gen = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-b:a', '128k', raw]);
  if (gen.status !== 0) return; // no mp3 encoder in this ffmpeg: nothing to check
  const title = 'Чем занимаются ЧВК-боты 🎵';
  fs.writeFileSync(path.join(dir, 'b.mp3'), Buffer.concat([Buffer.from(id3Tag(title)), fs.readFileSync(raw)]));
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title', '-of', 'default=nw=1:nk=1', path.join(dir, 'b.mp3')]);
  assert.equal(r.stdout.toString().trim(), title);
});

test('vendor/lame.js: the real encoder produces a valid stereo MP3 at the requested bitrate with the ID3 title', { skip: !fs.existsSync(new URL('../vendor/lame.js', import.meta.url)) || spawnSync('ffprobe', ['-version']).status !== 0 }, async () => {
  const vm = await import('node:vm');
  const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../vendor/lame.js', import.meta.url), 'utf8'), ctx);
  const rate = 44100, n = rate * 3;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / rate); R[i] = 0.4 * Math.sin(2 * Math.PI * 660 * i / rate); }
  const parts = await encodeMp3({ sampleRate: rate, channels: [L, R] }, { kbps: 128, lame: ctx.lamejs, title: 'Тест ✓' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-'));
  const f = path.join(dir, 'o.mp3');
  fs.writeFileSync(f, Buffer.concat(parts));
  const probe = String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,bit_rate:format_tags=title:stream=codec_name,channels', '-of', 'default=nw=1', f]).stdout);
  assert.match(probe, /codec_name=mp3/);
  assert.match(probe, /channels=2/);
  assert.match(probe, /TAG:title=Тест ✓/);
  assert.ok(Math.abs(Number(/duration=([\d.]+)/.exec(probe)[1]) - 3) < 0.2);
  assert.ok(Math.abs(Number(/bit_rate=(\d+)/.exec(probe)[1]) - 128000) < 3000);
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']).status, 0);
});
