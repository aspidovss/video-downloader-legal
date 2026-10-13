// UI language: follows the browser by default, or the language chosen in the options (setting `uiLang`).
// An explicit choice loads _locales/<lang>/messages.json by hand (browser.i18n always uses the browser's
// language). Works in extension pages and in the background. The extension name/description in the
// browser's own add-on lists still follow the browser language.
export const UI_LANGS = ['en', 'ru', 'zh_CN', 'es', 'hi', 'fr', 'ar', 'pt_BR', 'de', 'ja'];
export const LANG_NAMES = {
  en: 'English', ru: 'Русский', zh_CN: '中文（简体）', es: 'Español', hi: 'हिन्दी', fr: 'Français', ar: 'العربية', pt_BR: 'Português (Brasil)', de: 'Deutsch', ja: '日本語',
};

let messages = null; // null = browser language
let code = '';

export async function loadUiLang(lang) {
  if (lang === undefined) {
    try { lang = (await browser.storage.local.get('settings')).settings?.uiLang; } catch { lang = 'auto'; }
  }
  messages = null;
  code = '';
  if (!UI_LANGS.includes(lang)) return;
  try {
    const res = await fetch(browser.runtime.getURL(`_locales/${lang}/messages.json`));
    if (res.ok) { messages = await res.json(); code = lang; }
  } catch { /* keep the browser language */ }
}

export function tr(key, subs) {
  const m = messages && messages[key];
  if (m && typeof m.message === 'string') return m.message;
  return browser.i18n.getMessage(key, subs) || key;
}

export const uiLangCode = () => code || browser.i18n.getUILanguage();
export const uiDir = () => (code ? (code === 'ar' ? 'rtl' : 'ltr') : browser.i18n.getMessage('@@bidi_dir'));
