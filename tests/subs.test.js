// YouTube subtitles: track list, json3 -> cues -> SRT, choices, and the subtitle track inside a joined .webm
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { captionTracks, validateTracks, subsUrl, json3ToCues, cuesToSrt, subsChoices, defaultSubs, iso639b } from '../lib/subs.js';

const TT = 'https://www.youtube.com/api/timedtext?v=abc&ei=x&caps=asr&lang=';
const pr = {
  captions: { playerCaptionsTracklistRenderer: {
    captionTracks: [
      { baseUrl: `${TT}en`, name: { simpleText: 'English' }, languageCode: 'en', isTranslatable: true },
      { baseUrl: `${TT}en&kind=asr`, name: { runs: [{ text: 'English (auto-generated)' }] }, languageCode: 'en', kind: 'asr', isTranslatable: true },
      { baseUrl: 'https://evil.example/timedtext?lang=en', name: { simpleText: 'bad' }, languageCode: 'en' },
    ],
    translationLanguages: [{ languageCode: 'ru', languageName: { simpleText: 'Russian' } }, { languageCode: 'de', languageName: { simpleText: 'German' } }],
  } },
};

test('caption tracks: only youtube.com timedtext addresses, names, auto flag, translations', () => {
  const c = captionTracks(pr);
  assert.equal(c.tracks.length, 2);
  assert.deepEqual(c.tracks.map((x) => [x.lang, x.name, x.auto]), [['en', 'English', false], ['en', 'English (auto-generated)', true]]);
  assert.equal(c.translations.length, 2);
  assert.deepEqual(validateTracks(c), c);
  assert.deepEqual(validateTracks({ tracks: [{ url: 'javascript:alert(1)', lang: 'en' }] }).tracks, []);
  assert.deepEqual(validateTracks(undefined), { tracks: [], translations: [] });
});

test('json3 address and translation parameter', () => {
  const u = new URL(subsUrl({ url: `${TT}en` }, 'ru'));
  assert.equal(u.searchParams.get('fmt'), 'json3');
  assert.equal(u.searchParams.get('tlang'), 'ru');
  assert.equal(new URL(subsUrl({ url: `${TT}en&tlang=de` })).searchParams.get('tlang'), null);
});

test('json3 -> cues: empty/newline events dropped, rolling auto captions do not overlap; SRT format', () => {
  const cues = json3ToCues({ events: [
    { tStartMs: 0, dDurationMs: 5000, wWinId: 1 }, // window definition, no text
    { tStartMs: 100, dDurationMs: 3000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
    { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: '\n' }] },
    { tStartMs: 2500, dDurationMs: 3000, segs: [{ utf8: 'second line' }] },
    { tStartMs: 3661001, dDurationMs: 1500, segs: [{ utf8: 'late' }] },
  ] });
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[100, 2500, 'Hello world'], [2500, 5500, 'second line'], [3661001, 3662501, 'late']]);
  const srt = cuesToSrt(cues);
  assert.match(srt, /^1\n00:00:00,100 --> 00:00:02,500\nHello world\n/);
  assert.match(srt, /3\n01:01:01,001 --> 01:01:02,501\nlate\n$/);
});

test('choices: tracks as they are, plus a translation into the interface language when there is none in it', () => {
  const list = captionTracks(pr);
  const ru = subsChoices(list, 'ru-RU');
  assert.deepEqual(ru.map((c) => c.id), ['t0', 't1', 'x0:ru']);
  assert.equal(ru[2].label, 'English → Russian');
  assert.equal(ru[2].tlang, 'ru');
  assert.deepEqual(subsChoices(list, 'en').map((c) => c.id), ['t0', 't1']); // English exists: no translation offered
  assert.equal(iso639b('pt-BR'), 'por');
  assert.equal(iso639b('xx'), 'und');
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasEnc = (n) => hasFfmpeg && String(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout).includes(n);

test('VP9 + Opus joined into .webm with a switchable subtitle track (off by default)', { skip: !hasEnc('libvpx-vp9') || !hasEnc('libopus') }, async () => {
  const ctx = { module: { exports: {} }, Blob, TextEncoder };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../lib/mux.js', import.meta.url), 'utf8'), ctx);
  const { mergeBlobs } = ctx.module.exports;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-subs-'));
  const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); assert.equal(r.status, 0, String(r.stderr)); };
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '12', '-c:v', 'libvpx-vp9', '-g', '50', '-f', 'webm', path.join(dir, 'v.webm'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:a', 'libopus', '-f', 'webm', path.join(dir, 'a.webm'));
  const sub = { lang: 'ru', iso3: 'rus', name: 'Русский', cues: [{ start: 500, end: 2500, text: 'Привет' }, { start: 6000, end: 8000, text: 'Вторая строка\nи ещё' }] };
  const out = await mergeBlobs(new Blob([fs.readFileSync(path.join(dir, 'v.webm'))]), new Blob([fs.readFileSync(path.join(dir, 'a.webm'))]), 'webm', { subs: [sub] });
  assert.ok(out && out.vdlSubs, 'subtitles embedded');
  const f = path.join(dir, 'm.webm');
  fs.writeFileSync(f, Buffer.from(await out.arrayBuffer()));
  const streams = String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:stream_tags=language:stream_disposition=default', '-of', 'compact', f]).stdout);
  assert.match(streams, /codec_name=webvtt\|codec_type=subtitle\|disposition:default=0\|tag:language=rus/);
  const srt = path.join(dir, 'out.srt');
  ff('-i', f, '-map', '0:s:0', srt);
  const text = fs.readFileSync(srt, 'utf8');
  assert.match(text, /-->.*\s+Привет\s/);
  assert.match(text, /-->.*\s+Вторая строка\s+и ещё/);
  // times as written in the file (ffmpeg's .srt output may shift them by the Opus pre-skip)
  const pk = String(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 's', '-show_entries', 'packet=pts,duration', '-of', 'csv=p=0', f]).stdout).trim().split(/\s+/);
  assert.deepEqual(pk, ['500,2000', '6000,2000']);
  ff('-i', f, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'); // video and sound still decode
});

test('defaultSubs: the interface language (manual before automatic), then its translation, then the first track', () => {
  const c = [
    { id: 't0', lang: 'de', label: 'Deutsch', tlang: '' },
    { id: 't1', lang: 'en', label: 'English (auto-generated)', tlang: '' },
    { id: 't2', lang: 'en', label: 'English', tlang: '' },
  ];
  assert.equal(defaultSubs(c, 'en-US').id, 't2');
  assert.equal(defaultSubs(c.slice(0, 2), 'en').id, 't1');
  assert.equal(defaultSubs([...c, { id: 'x0:ru', lang: 'ru', label: 'Deutsch → Russian', tlang: 'ru' }], 'ru').id, 'x0:ru');
  assert.equal(defaultSubs(c, 'ja').id, 't0');
  assert.equal(defaultSubs([], 'en'), null);
});
