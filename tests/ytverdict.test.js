// Why YouTube gave nothing: codes from status + reason (lib/ytverdict.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyYt } from '../lib/ytverdict.js';

const log = (playability, reason, status = 200) => ({ status, playability, reason, error: '' });

test('age restriction (real diagnostics of 15.10.2026: ru and en reasons from all clients) -> age, recording helps', () => {
  const v = classifyYt({
    summary: { status: 'LOGIN_REQUIRED', reason: '' },
    logs: [log('LOGIN_REQUIRED', 'Войдите в свой аккаунт'), log('LOGIN_REQUIRED', 'Это видео может оказаться неприемлемым для некоторых пользователей.'), log('LOGIN_REQUIRED', 'Sign in to confirm your age'), log('LOGIN_REQUIRED', 'This video may be inappropriate for some users.')],
    session: 'ok', apiDone: true, noLinks: true,
  });
  assert.equal(v.code, 'age');
  assert.equal(v.record, 'yes');
  assert.equal(v.busy, false); // no "too many downloads" hint for this one
});

test('age also from isFamilySafe=false when only "sign in" is said', () => {
  assert.equal(classifyYt({ summary: { status: 'LOGIN_REQUIRED', reason: 'Sign in', familySafe: false }, logs: [] }).code, 'age');
});

for (const [code, reason, status, record] of [
  ['bot', 'Sign in to confirm you’re not a bot', 'LOGIN_REQUIRED', 'maybe'],
  ['private', 'This video is private', 'LOGIN_REQUIRED', 'no'],
  ['private', 'Это частное видео', 'LOGIN_REQUIRED', 'no'],
  ['members', 'Join this channel to get access to members-only content like this video', 'UNPLAYABLE', 'maybe'],
  ['region', 'The uploader has not made this video available in your country', 'UNPLAYABLE', 'no'],
  ['region', 'Видео недоступно в вашей стране', 'UNPLAYABLE', 'no'],
  ['removed', 'This video has been removed by the uploader', 'ERROR', 'no'],
  ['removed', 'Video unavailable', 'ERROR', 'no'],
  ['paid', 'This video requires payment to watch', 'UNPLAYABLE', 'no'],
]) {
  test(`${code}: "${reason}"`, () => {
    const v = classifyYt({ summary: { status, reason }, logs: [log(status, reason)] });
    assert.equal(v.code, code);
    assert.equal(v.record, record);
  });
}

test('status codes win over text: upcoming, content check, DRM-only formats, purchase screen', () => {
  assert.equal(classifyYt({ summary: { status: 'LIVE_STREAM_OFFLINE', upcoming: true, startAt: 1760000000 } }).code, 'upcoming');
  assert.equal(classifyYt({ summary: { status: 'LIVE_STREAM_OFFLINE', upcoming: true, startAt: 1760000000 } }).startAt, 1760000000);
  assert.equal(classifyYt({ summary: { status: 'CONTENT_CHECK_REQUIRED', reason: 'whatever' } }).code, 'contentCheck');
  assert.equal(classifyYt({ summary: { status: 'OK', formats: [{ drm: true }, { drm: true }] } }).code, 'paid');
  assert.equal(classifyYt({ summary: { status: 'UNPLAYABLE', paid: true } }).code, 'paid');
});

test('playable on the page but no links: 429, cut off, network, SABR only, unknown', () => {
  const ok = { status: 'OK' };
  assert.equal(classifyYt({ summary: ok, logs: [log('', '', 429)], apiDone: true, noLinks: true }).code, 'rate');
  assert.equal(classifyYt({ summary: ok, testCut: true, apiDone: true }).code, 'cut');
  assert.equal(classifyYt({ summary: ok, dlLimited: true, apiDone: true }).code, 'cut');
  assert.equal(classifyYt({ summary: ok, logs: [{ status: 0, error: 'TypeError' }], session: 'err:TypeError', apiDone: true, noLinks: true }).code, 'network');
  assert.equal(classifyYt({ summary: { ...ok, sabr: true }, logs: [log('OK', '')], session: 'ok', apiDone: true, noLinks: true }).code, 'sabr');
  const u = classifyYt({ summary: ok, logs: [log('OK', '')], session: 'ok', apiDone: true, noLinks: true });
  assert.equal(u.code, 'unknown');
  assert.equal(u.busy, true);
  assert.equal(classifyYt({ summary: ok, apiDone: false, noLinks: true }).code, ''); // still loading
});

test('unknown refusal keeps YouTube\'s own words for the message', () => {
  const v = classifyYt({ summary: { status: 'UNPLAYABLE', reason: 'Something new from YouTube' } });
  assert.equal(v.code, 'unknown');
  assert.equal(v.reason, 'Something new from YouTube');
});

test('every code has a message in all 10 languages, and the popup knows them all', async () => {
  const fs = await import('node:fs');
  const popup = fs.readFileSync(new URL('../content/popup.js', import.meta.url), 'utf8');
  const keys = [...popup.matchAll(/'(ytWhy\w+)'/g)].map((m) => m[1]);
  for (const k of ['ytWhyUpcomingAt', 'ytWhyUnknownReason']) keys.push(k);
  for (const l of ['ar', 'de', 'en', 'es', 'fr', 'hi', 'ja', 'pt_BR', 'ru', 'zh_CN']) {
    const m = JSON.parse(fs.readFileSync(new URL(`../_locales/${l}/messages.json`, import.meta.url), 'utf8'));
    for (const k of keys) assert.ok(m[k]?.message, `${l}: ${k}`);
    assert.ok(m.ytWhyUpcomingAt.message.includes('{time}') && m.ytWhyUnknownReason.message.includes('{reason}'), l);
  }
});
