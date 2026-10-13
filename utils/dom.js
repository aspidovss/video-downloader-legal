// Tiny DOM helpers. Everything goes through textContent, never innerHTML,
// so page titles / URLs can't inject markup into extension pages.

import { tr, uiLangCode, uiDir } from './i18n.js';

export const t = tr;

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function translatePage() {
  markPlatform();
  try {
    document.documentElement.lang = uiLangCode();
    const dir = uiDir();
    if (dir === 'rtl' || dir === 'ltr') document.documentElement.dir = dir; // Arabic: right-to-left pages
  } catch { /* ignore */ }
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}

// Footer of the extension pages: copyright, build version, browser, link to the repository (icon).
const REPO_URL = 'https://github.com/aspidovss/video-downloader-legal';
// Firefox for Android: no toolbar popup size, no context menu / hotkeys / notifications / sidebar API, no file manager.
export function isAndroid(ua = (globalThis.navigator && navigator.userAgent) || '') {
  return /\bAndroid\b/i.test(ua);
}
// Marks the page for the touch layout (styles/ui.css) and hides what a phone cannot do (elements with data-desktop-only).
export function markPlatform() {
  if (!isAndroid()) return;
  document.documentElement.classList.add('android');
  for (const el of document.querySelectorAll('[data-desktop-only]')) el.hidden = true;
}
export function browserName(ua = (globalThis.navigator && navigator.userAgent) || '') {
  if (/Firefox\//.test(ua)) return isAndroid(ua) ? 'Firefox Android' : 'Firefox';
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  return 'Chrome';
}
export function renderFooter() {
  let el = document.getElementById('site-footer');
  if (!el) { el = document.createElement('footer'); el.id = 'site-footer'; el.className = 'site-footer'; document.body.appendChild(el); }
  let version = '';
  try { const mf = browser.runtime.getManifest(); version = mf.version_name || mf.version || ''; } catch { /* ignore */ }
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z');
  svg.appendChild(path);
  const a = document.createElement('a');
  a.href = REPO_URL; a.target = '_blank'; a.rel = 'noopener'; a.title = 'GitHub'; a.setAttribute('aria-label', 'GitHub');
  a.appendChild(svg);
  const span = (txt) => { const s = document.createElement('span'); s.textContent = txt; return s; };
  const mit = document.createElement('a');
  mit.href = `${REPO_URL}/blob/main/LICENSE`; mit.target = '_blank'; mit.rel = 'noopener'; mit.textContent = 'MIT';
  el.replaceChildren(span('AspidovSS 2026'), mit, span(`VDL ${version}`), span(browserName()), a);
}

// Collapsible blocks: a click (or Enter / Space) on the legend of a fieldset folds it. The state is kept in
// localStorage under storageKey; folded = legend keys that start folded when nothing is stored yet.
export function initFoldable(fieldsets, storageKey, startFolded = []) {
  let state = {};
  try { state = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { state = {}; }
  if (typeof state !== 'object') state = {};
  for (const fs of fieldsets) {
    const lg = fs.querySelector(':scope > legend');
    const key = lg && (fs.dataset.fold || lg.getAttribute('data-i18n'));
    if (!lg || !key) continue;
    fs.classList.add('foldable');
    lg.tabIndex = 0;
    lg.setAttribute('role', 'button');
    const set = (f) => { fs.classList.toggle('folded', f); lg.setAttribute('aria-expanded', String(!f)); };
    set(key in state ? !!state[key] : startFolded.includes(key));
    const toggle = () => {
      const f = !fs.classList.contains('folded');
      set(f);
      state[key] = f;
      try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* ignore */ }
    };
    lg.addEventListener('click', toggle);
    lg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }
}
