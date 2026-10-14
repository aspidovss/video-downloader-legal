import { translatePage, renderFooter, initFoldable, browserName, t } from '../utils/dom.js';
import { loadUiLang, UI_LANGS, LANG_NAMES, uiLangCode } from '../utils/i18n.js';
import { getSettings, saveSettings, DEFAULTS } from '../utils/settings.js';
import { DEFAULT_SHORTCUTS, COMMAND_OF, isValidShortcut, shortcutFromEvent } from '../lib/shortcuts.js';
import { getConsent, revokeConsent } from '../utils/consent.js';
import { isAccepted } from '../lib/consent.js';
import { readLog, clearLog } from '../utils/debuglog.js';
import { LOG_KEY, formatLog } from '../lib/debuglog.js';

await loadUiLang();

const form = document.getElementById('form');
const $lang = document.getElementById('ui-lang');
let shownLang = 'auto';

const savedMsg = document.getElementById('saved');
const $bar = document.getElementById('savebar');
const $barText = document.getElementById('savebar-text');
const $barSave = document.getElementById('savebar-save');
const $barCancel = document.getElementById('savebar-cancel');

// Unsaved changes: the bar at the top appears when any field differs from the saved values
const formValues = () => {
  const o = {};
  for (const el of form.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return o;
};
let snapshot = {};
let dirty = false;
function updateDirty() {
  const now = formValues();
  const changed = new Set(Object.keys(now).filter((k) => String(now[k]) !== String(snapshot[k])));
  dirty = changed.size > 0;
  if (dirty) { $bar.hidden = false; $barText.hidden = false; $barSave.hidden = false; $barCancel.hidden = false; savedMsg.hidden = true; }
  else if (savedMsg.hidden) $bar.hidden = true;
  for (const fs of document.querySelectorAll('fieldset.prefs')) {
    fs.classList.toggle('dirty', [...fs.querySelectorAll('[name]')].some((el) => changed.has(el.name)));
  }
}
form.addEventListener('input', updateDirty);
form.addEventListener('change', updateDirty);
$barSave.addEventListener('click', () => form.requestSubmit());
$barCancel.addEventListener('click', () => load());
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

async function load() {
  const s = await getSettings();
  shownLang = UI_LANGS.includes(s.uiLang) ? s.uiLang : 'auto';
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!s[el.name];
    else el.value = el.name === 'template' && !String(s.template || '').includes('{title}') ? DEFAULTS.template : s[el.name];
  }
  await showActualShortcuts(s);
  snapshot = formValues();
  updateDirty();
}

// Keyboard shortcuts. Firefox: the fields show the shortcuts the browser really has (they can be changed in
// about:addons too) and are written with commands.update by the background. Chrome / Edge: an extension cannot
// change them, so the page only explains where to do it.
const canSetShortcuts = typeof browser.commands?.update === 'function';
async function showActualShortcuts(s) {
  if (!canSetShortcuts || !s.hotkeys) return;
  try {
    const all = await browser.commands.getAll();
    for (const [key, name] of Object.entries(COMMAND_OF)) {
      const c = all.find((x) => x.name === name);
      if (c && isValidShortcut(c.shortcut || '') && form.elements[key]) form.elements[key].value = c.shortcut || '';
    }
  } catch { /* keep the stored values */ }
}
const $hkError = document.getElementById('hk-error');
const isMac = /Mac/.test(navigator.platform || '');
for (const row of document.querySelectorAll('.hk-row')) {
  const input = row.querySelector('input');
  input.placeholder = t('hkNone');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') { input.value = ''; $hkError.hidden = true; form.dispatchEvent(new Event('input')); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const sc = shortcutFromEvent(e, isMac);
    $hkError.hidden = !!sc;
    if (sc) { input.value = sc; form.dispatchEvent(new Event('input')); }
  });
  row.querySelector('.hk-reset').addEventListener('click', () => { input.value = DEFAULT_SHORTCUTS[row.dataset.hk]; $hkError.hidden = true; form.dispatchEvent(new Event('input')); });
}
if (!canSetShortcuts) {
  for (const row of document.querySelectorAll('.hk-row')) row.hidden = true;
  const url = `${browserName() === 'Edge' ? 'edge' : 'chrome'}://extensions/shortcuts`;
  document.getElementById('hk-chrome').hidden = false;
  document.getElementById('hk-chrome-text').textContent = t('hkChromeHint');
  document.getElementById('hk-chrome-url').textContent = url;
  const copy = document.getElementById('hk-copy');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); copy.textContent = t('hkCopied'); } catch { /* ignore */ }
    setTimeout(() => { copy.textContent = t('hkCopy'); }, 1500);
  });
}

// Sidebar (Firefox desktop): open / close from the settings too
const $sideRow = document.getElementById('sidebar-row');
const $sideBtn = document.getElementById('sidebar-toggle');
if (typeof browser.sidebarAction?.toggle === 'function') {
  $sideRow.hidden = false;
  const label = async () => { try { $sideBtn.textContent = t(await browser.sidebarAction.isOpen({}) ? 'sidebarClose' : 'sidebarOpen'); } catch { /* ignore */ } };
  $sideBtn.addEventListener('click', async () => { await browser.sidebarAction.toggle(); setTimeout(label, 300); });
  label();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  if (!UI_LANGS.includes(patch.uiLang)) patch.uiLang = 'auto';
  for (const k of Object.keys(DEFAULT_SHORTCUTS)) if (!isValidShortcut(String(patch[k] ?? ''))) patch[k] = DEFAULT_SHORTCUTS[k];
  patch.template = String(patch.template || '').trim();
  if (!patch.template.includes('{title}')) patch.template = DEFAULTS.template;
  patch.minSizeKB = Math.max(0, Math.floor(Number(patch.minSizeKB)) || 0);
  patch.concurrency = Math.min(12, Math.max(1, patch.concurrency || 4));
  if (!['auto', 'mp4', 'mp4-av1', 'webm'].includes(patch.defaultType)) patch.defaultType = 'auto';
  if (!['mp3', 'm4a', 'webm'].includes(patch.defaultAudioFormat)) patch.defaultAudioFormat = 'mp3';
  if (!['best', '192', '128'].includes(patch.defaultAudioQuality)) patch.defaultAudioQuality = 'best';
  if (!['best', '1080', '720', '480'].includes(patch.defaultQuality)) patch.defaultQuality = 'best';
  if (!['auto', 'page', 'background'].includes(patch.ytMethod)) patch.ytMethod = 'auto';
  patch.liveMaxMinutes = Math.min(720, Math.max(1, patch.liveMaxMinutes || 180));
  patch.ytRecordSpeed = Math.min(4, Math.max(1, patch.ytRecordSpeed || 2));
  patch.ytClients = String(patch.ytClients || '').toUpperCase().replace(/[^A-Z0-9_,\s]/g, '').trim() || 'VISIONOS,ANDROID_VR,IOS,IOS_VDL';
  try { if (patch.ytClientOverrides.trim()) JSON.parse(patch.ytClientOverrides); } catch { patch.ytClientOverrides = ''; }
  const langBefore = shownLang; // load() below overwrites shownLang, so the language change must be noted first
  await saveSettings(patch);
  await load(); // shows the values as saved (corrected ones included); the bar goes away
  $bar.hidden = false; $barText.hidden = true; $barSave.hidden = true; $barCancel.hidden = true; savedMsg.hidden = false;
  if (patch.uiLang !== langBefore) { setTimeout(() => location.reload(), 500); return; } // the page re-reads its language
  setTimeout(() => { savedMsg.hidden = true; if (!dirty) $bar.hidden = true; }, 1500);
});

// "?" next to an option: click shows / hides a short explanation
for (const btn of document.querySelectorAll('button.info')) {
  btn.addEventListener('click', () => {
    const hint = btn.parentElement.querySelector('.hint');
    hint.hidden = !hint.hidden;
    btn.setAttribute('aria-expanded', String(!hint.hidden));
  });
}

// Terms of use: status + withdrawing the consent (downloads stop until it is accepted again in the popup)
const $consentStatus = document.getElementById('consent-status');
const $consentRevoke = document.getElementById('consent-revoke');
async function showConsent() {
  const rec = await getConsent();
  const ok = isAccepted(rec);
  $consentStatus.textContent = ok ? t('consentAcceptedOn').replace('{date}', new Date(rec.acceptedAt).toLocaleString()) : t('consentMissing');
  $consentRevoke.hidden = !ok;
}
$consentRevoke.addEventListener('click', async () => { await revokeConsent(); showConsent(); });
browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.consent) showConsent(); });

// "Creative Commons only" switched off by the user: shown in the terms with the date (written by the background)
const $ccOff = document.getElementById('cc-off-status');
async function showCcOff() {
  const st = await getSettings();
  let at = 0;
  try { at = (await browser.storage.local.get('ccOffAt')).ccOffAt || 0; } catch { /* ignore */ }
  const off = st.ytCcOnly === false;
  $ccOff.hidden = !off;
  if (off) $ccOff.textContent = `${t('ccOffByUser')} ${at ? new Date(at).toLocaleString(uiLangCode()) : ''}`.trim();
}
showCcOff();
browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.settings || changes.ccOffAt)) showCcOff(); });

// Interface language: automatic (browser) or one of the shipped locales, shown by their own names
$lang.append(new Option(t('langAuto'), 'auto'));
for (const code of UI_LANGS) $lang.append(new Option(LANG_NAMES[code], code));

// Restore the default settings (history and the accepted terms are not touched)
const $resetBtn = document.getElementById('reset-btn');
const $resetConfirm = document.getElementById('reset-confirm');
const $resetDone = document.getElementById('reset-done');
$resetBtn.addEventListener('click', () => { $resetBtn.hidden = true; $resetConfirm.hidden = false; $resetDone.hidden = true; });
document.getElementById('reset-no').addEventListener('click', () => { $resetConfirm.hidden = true; $resetBtn.hidden = false; });
document.getElementById('reset-yes').addEventListener('click', async () => {
  const before = shownLang;
  await browser.storage.local.remove('settings');
  $resetConfirm.hidden = true;
  $resetBtn.hidden = false;
  if (before !== 'auto') { dirty = false; setTimeout(() => location.reload(), 500); $resetDone.hidden = false; return; }
  await load();
  $resetDone.hidden = false;
  setTimeout(() => { $resetDone.hidden = true; }, 2000);
});

// Debug log (Diagnostics): view, copy, save as a file, send (GitHub issue / e-mail), clear.
// The log is written by the background into storage.local only while the option is on; nothing is sent automatically.
const REPO = 'https://github.com/aspidovss/video-downloader-legal';
const MAIL = 'vdl@aspidov.ru';
const $logTools = document.getElementById('log-tools');
const $logCount = document.getElementById('log-count');
const $logPanel = document.getElementById('log-panel');
const $logText = document.getElementById('log-text');
const $logView = document.getElementById('log-view');
const $logCopy = document.getElementById('log-copy');
const $logSave = document.getElementById('log-save');
const $logClear = document.getElementById('log-clear');
const $logGh = document.getElementById('log-gh');
const $logMail = document.getElementById('log-mail');
let logEntries = [];

function logHeader() {
  const m = browser.runtime.getManifest();
  return [`VDL ${m.version_name || m.version}`, navigator.userAgent, `${t('logEntries')}: ${logEntries.length}`, new Date().toISOString()];
}
const logFullText = () => formatLog(logEntries, logHeader());

async function showLog() {
  logEntries = await readLog();
  const saved = (await getSettings()).debugLog;
  $logTools.hidden = !saved && !logEntries.length;
  const chars = logEntries.reduce((n, e) => n + e.m.length + 40, 0);
  $logCount.textContent = logEntries.length
    ? t('logCount').replace('{count}', String(logEntries.length)).replace('{kb}', String(Math.max(1, Math.round(chars / 1024))))
    : t('logEmpty');
  for (const b of [$logView, $logCopy, $logSave, $logClear]) b.disabled = !logEntries.length;
  $logGh.classList.toggle('disabled', !logEntries.length);
  $logMail.classList.toggle('disabled', !logEntries.length);
  const head = encodeURIComponent(`${logHeader().join('\n')}\n\n${logEntries.slice(-12).map((e) => `[${e.g}] ${e.m}`).join('\n').slice(0, 1200)}`);
  const title = encodeURIComponent(`VDL ${browser.runtime.getManifest().version_name || ''}: ${t('logTitle')}`);
  $logGh.href = `${REPO}/issues/new?title=${title}&body=${head}`;
  $logMail.href = `mailto:${MAIL}?subject=${title}&body=${head}`;
  if (!$logPanel.hidden) {
    const atEnd = $logText.scrollTop + $logText.clientHeight >= $logText.scrollHeight - 20;
    $logText.value = logFullText();
    if (atEnd) $logText.scrollTop = $logText.scrollHeight;
  }
}
$logView.addEventListener('click', async () => {
  $logPanel.hidden = !$logPanel.hidden;
  $logView.textContent = t($logPanel.hidden ? 'logView' : 'logHide');
  if (!$logPanel.hidden) { await showLog(); $logText.scrollTop = $logText.scrollHeight; }
});
$logCopy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(logFullText()); $logCopy.textContent = t('bugCopied'); } catch { $logCopy.textContent = t('bugCopyFail'); }
  setTimeout(() => { $logCopy.textContent = t('bugCopy'); }, 1500);
});
$logSave.addEventListener('click', () => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const url = URL.createObjectURL(new Blob([logFullText()], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = `vdl-log-${stamp}.txt`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});
$logClear.addEventListener('click', async () => { await clearLog(); await showLog(); });
browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes[LOG_KEY] || changes.settings)) showLog(); });
showLog();

// Collapsible blocks (state remembered in this browser); rarely needed ones start folded
initFoldable(document.querySelectorAll('fieldset.prefs:not(.consent-box)'), 'vdlFolded', ['optDiagTitle', 'optResetTitle']);

translatePage();
renderFooter();
load();
showConsent();
