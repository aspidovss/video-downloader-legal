// YouTube subtitles (1.6.0dev5): the list of tracks from a player response, the timedtext answer (json3) -> cues,
// cues -> SRT, and the Matroska subtitle track. Only the public timedtext addresses the player itself uses.

const TIMEDTEXT = /^https:\/\/(?:www\.)?youtube\.com\/api\/timedtext\?/;
const textOf = (n) => String(n?.simpleText || (n?.runs || []).map((r) => r.text || '').join('') || '');

// player response -> { tracks: [{ url, lang, name, auto, translatable }], translations: [{ lang, name }] }
export function captionTracks(pr) {
  const r = pr?.captions?.playerCaptionsTracklistRenderer || {};
  const tracks = (r.captionTracks || []).map((c) => ({
    url: String(c.baseUrl || ''),
    lang: String(c.languageCode || '').slice(0, 20),
    name: textOf(c.name).slice(0, 80) || String(c.languageCode || ''),
    auto: c.kind === 'asr',
    translatable: !!c.isTranslatable,
  })).filter((c) => TIMEDTEXT.test(c.url) && /^[\w-]{2,20}$/.test(c.lang)).slice(0, 60);
  const translations = (r.translationLanguages || []).map((l) => ({ lang: String(l.languageCode || '').slice(0, 20), name: textOf(l.languageName).slice(0, 80) }))
    .filter((l) => /^[\w-]{2,20}$/.test(l.lang)).slice(0, 200);
  return { tracks, translations };
}

// the same list, checked again where it crosses from the page into the background
export function validateTracks(list) {
  const tracks = (Array.isArray(list?.tracks) ? list.tracks : []).filter((c) => c && TIMEDTEXT.test(String(c.url || '')) && /^[\w-]{2,20}$/.test(String(c.lang || '')))
    .slice(0, 60).map((c) => ({ url: String(c.url).slice(0, 3000), lang: String(c.lang), name: String(c.name || c.lang).slice(0, 80), auto: !!c.auto, translatable: !!c.translatable }));
  const translations = (Array.isArray(list?.translations) ? list.translations : []).filter((l) => l && /^[\w-]{2,20}$/.test(String(l.lang || '')))
    .slice(0, 200).map((l) => ({ lang: String(l.lang), name: String(l.name || l.lang).slice(0, 80) }));
  return { tracks, translations };
}

// address of one track in the json3 format, optionally machine-translated by YouTube (tlang)
export function subsUrl(track, tlang = '') {
  const u = new URL(track.url);
  u.searchParams.set('fmt', 'json3');
  if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
  return u.href;
}

// timedtext json3 -> [{ start, end, text }] (ms). Automatic captions come as overlapping "rolling" events:
// empty and newline-only events are dropped and each cue ends where the next one starts.
export function json3ToCues(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const cues = [];
  for (const e of events) {
    if (!Array.isArray(e.segs)) continue;
    const text = e.segs.map((s) => String(s.utf8 || '')).join('').replace(/​/g, '').replace(/[ \t]+\n/g, '\n').trim();
    if (!text) continue;
    const start = Math.max(0, Number(e.tStartMs) || 0);
    const end = start + Math.max(1, Number(e.dDurationMs) || 2000);
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < cues.length; i++) if (cues[i].end > cues[i + 1].start) cues[i].end = Math.max(cues[i].start + 1, cues[i + 1].start);
  return cues.filter((c, i) => !(i && c.text === cues[i - 1].text && c.start === cues[i - 1].start));
}

const srtTime = (ms) => {
  const p = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
  return `${p(ms / 3600000)}:${p((ms / 60000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export function cuesToSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

// ISO 639-2/B code for Matroska's Language element (players that do not read LanguageBCP47 use this)
const ISO3 = { ar: 'ara', de: 'ger', en: 'eng', es: 'spa', fr: 'fre', hi: 'hin', it: 'ita', ja: 'jpn', ko: 'kor', pl: 'pol', pt: 'por', ru: 'rus', tr: 'tur', uk: 'ukr', zh: 'chi', nl: 'dut', sv: 'swe', cs: 'cze', be: 'bel', kk: 'kaz', id: 'ind', vi: 'vie', th: 'tha', he: 'heb', fa: 'per' };
export const iso639b = (lang) => ISO3[String(lang || '').toLowerCase().split(/[-_]/)[0]] || 'und';

// a label for the list: "English (auto-generated)" comes from YouTube; translations get "→ <language>"
// Default track: the interface language (manual first), then its translation, then the first track.
export function defaultSubs(choices, uiLang) {
  const list = choices || [];
  const ui = String(uiLang || 'en').toLowerCase().split(/[-_]/)[0];
  const base = (l) => String(l || '').toLowerCase().split(/[-_]/)[0];
  return list.find((s) => base(s.lang) === ui && !s.tlang && !/\(.*\)/.test(s.label)) || list.find((s) => base(s.lang) === ui) || list[0] || null;
}

export function subsChoices(list, uiLang) {
  const out = (list?.tracks || []).map((t, i) => ({ id: `t${i}`, track: i, tlang: '', lang: t.lang, label: t.name }));
  const ui = String(uiLang || '').toLowerCase().split(/[-_]/)[0];
  const src = (list?.tracks || []).findIndex((t) => t.translatable && !t.auto) >= 0 ? (list.tracks || []).findIndex((t) => t.translatable && !t.auto) : (list?.tracks || []).findIndex((t) => t.translatable);
  if (src >= 0 && ui && !(list.tracks || []).some((t) => t.lang.toLowerCase().split(/[-_]/)[0] === ui)) {
    const tl = (list.translations || []).find((l) => l.lang.toLowerCase().split(/[-_]/)[0] === ui);
    if (tl) out.push({ id: `x${src}:${tl.lang}`, track: src, tlang: tl.lang, lang: tl.lang, label: `${list.tracks[src].name} → ${tl.name}` });
  }
  return out;
}
