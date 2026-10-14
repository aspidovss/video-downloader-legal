import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_SHORTCUTS, COMMAND_OF, isValidShortcut, shortcutFromEvent } from '../lib/shortcuts.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('isValidShortcut: Firefox format', () => {
  for (const ok of ['', 'Alt+Up', 'Ctrl+Shift+Down', 'Alt+Shift+Down', 'Ctrl+Alt+F5', 'Command+Shift+K', 'MacCtrl+Comma', 'Ctrl+9']) assert.equal(isValidShortcut(ok), true, ok);
  for (const bad of ['Up', 'Shift+Up', 'Alt+', 'Alt+Alt+Up', 'Ctrl+Shift+Alt+Up', 'Alt+a', 'Alt+F13', 'Alt+Enter', 'alt+Up', null, 7]) assert.equal(isValidShortcut(bad), false, String(bad));
});

test('shortcutFromEvent: keys, modifiers, unusable combinations', () => {
  const ev = (o) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
  assert.equal(shortcutFromEvent(ev({ code: 'ArrowDown', altKey: true })), 'Alt+Down');
  assert.equal(shortcutFromEvent(ev({ code: 'KeyK', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+K');
  assert.equal(shortcutFromEvent(ev({ code: 'KeyK', ctrlKey: true }), true), 'MacCtrl+K', 'on a Mac the Control key is MacCtrl');
  assert.equal(shortcutFromEvent(ev({ code: 'KeyK', metaKey: true }), true), 'Command+K');
  assert.equal(shortcutFromEvent(ev({ code: 'KeyK', metaKey: true })), null, 'the Windows key is not usable');
  assert.equal(shortcutFromEvent(ev({ code: 'KeyK' })), null, 'a modifier is required');
  assert.equal(shortcutFromEvent(ev({ code: 'KeyK', shiftKey: true })), null, 'Shift alone is not enough');
  assert.equal(shortcutFromEvent(ev({ code: 'Enter', altKey: true })), null, 'unsupported key');
  assert.equal(shortcutFromEvent(ev({ code: 'F5', altKey: true })), 'Alt+F5');
  assert.equal(shortcutFromEvent(ev({ code: 'Digit3', altKey: true })), 'Alt+3');
});

test('shortcuts: defaults match manifest.json, every command exists, settings and locales know the new keys', () => {
  const m = JSON.parse(read('manifest.json'));
  for (const [key, name] of Object.entries(COMMAND_OF)) {
    assert.ok(m.commands[name], `${name} is declared in the manifest`);
    assert.equal(m.commands[name].suggested_key.default, DEFAULT_SHORTCUTS[key], `${key} default`);
    assert.ok(isValidShortcut(DEFAULT_SHORTCUTS[key]));
  }
  assert.ok(m.commands['download-audio'].description.startsWith('__MSG_'));
  const settings = read('utils/settings.js');
  for (const k of ['hotkeys', ...Object.keys(DEFAULT_SHORTCUTS)]) assert.ok(new RegExp(`\\b${k}:`).test(settings), `${k} is a setting`);
  const html = read('content/settings.html');
  for (const k of ['hotkeys', ...Object.keys(DEFAULT_SHORTCUTS)]) assert.ok(html.includes(`name="${k}"`), `${k} is on the settings page`);
  const en = JSON.parse(read('_locales/en/messages.json'));
  for (const k of ['cmdAudio', 'hkTitle', 'optHotkeys', 'sidebarOpen', 'sidebarClose', 'optSidebar', 'noAudioHere']) assert.ok(en[k]);
  assert.ok(fs.existsSync(new URL('../_locales/en/messages.json', import.meta.url)));
});

test('sidebar button: only where the browser has sidebarAction, in the popup and in the settings', () => {
  assert.match(read('content/popup.js'), /typeof browser\.sidebarAction\?\.open !== 'function'\) return/);
  assert.match(read('content/popup.html'), /id="btn-sidebar"[^>]*hidden/);
  assert.match(read('content/settings.js'), /typeof browser\.sidebarAction\?\.toggle === 'function'/);
  assert.match(read('content/settings.html'), /id="sidebar-row" hidden/);
});

test('manifest: no Ctrl+Alt shortcut (Chrome refuses to load the whole extension because of it)', () => {
  const m = JSON.parse(read('manifest.json'));
  for (const [name, c] of Object.entries(m.commands)) {
    for (const [os, key] of Object.entries(c.suggested_key || {})) assert.ok(!/(Ctrl\+Alt|Alt\+Ctrl)/.test(key), `${name} ${os}: ${key}`);
  }
});

test('hotkeys block is the last part of the General block', () => {
  const html = read('content/settings.html');
  const g = html.indexOf('optGeneralTitle');
  const end = html.indexOf('</fieldset>', html.indexOf('hkTitle'));
  assert.ok(html.indexOf('hkTitle') > g);
  assert.ok(html.indexOf('optDownloadTitle') > end);
  assert.ok(html.slice(end + 11, html.indexOf('optDownloadTitle')).includes('</fieldset>'));
});
