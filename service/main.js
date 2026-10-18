// Background (event page). Detects media via webRequest + page reports, parses
// HLS/DASH manifests, runs downloads. No external services, no native helper.

import { makeRate } from '../lib/rate.js';
import { jrParse, jrTitle, jrGifCandidates, isJoyreactorPage } from '../lib/joyreactor.js';
import { videoToGif, GIF_MAX_SECONDS } from '../lib/gifvideo.js';
import {
  FILE_EXTS, SKIP_EXTS, urlExt, mediaExt, normalizeUrl, hashId, mimeToExt, hostOf, buildFilename, stripLlHls, refDomain,
} from '../lib/util.js';
import { buildSynthGroups, trackInfo, playlistDir } from '../lib/hlsgroup.js';
import { fileStem, playlistStems, matchFeed, humanStem } from '../lib/feed.js';
import { parsePlaylist } from '../lib/hls.js';
import { parseMPD } from '../lib/dash.js';
import {
  downloadParts, hlsParts, dashParts, fetchText, joinBlobs, StreamError,
} from '../lib/downloader.js';
import { RESOLVERS } from '../lib/sites.js';
import { IS_CHROME } from '../lib/env.js';
import { hdr as ytHdr, installChromeRules } from './headers.js';
import { isAccepted } from '../lib/consent.js';
import { loadUiLang, tr, uiLangCode } from '../utils/i18n.js';
import { isAndroid } from '../utils/dom.js';
import { subsChoices, defaultSubs, subsUrl, json3ToCues, cuesToSrt, iso639b } from '../lib/subs.js';
import { chromeBlobUrl, chromeRevoke, chromeMp3, chromeGif } from './offscreen-client.js';
import { recordLive } from '../lib/liverec.js';
import { rebaseTimestamps } from '../lib/rebase.js';
import { tsToMp4, tsToMkv } from '../lib/ts2mp4.js';
import { describeInit } from '../lib/mp4info.js';
import { maskUrl, repType, estimateSize, probeInfo } from '../lib/sitediag.js';
import {
  MP3_KBPS, groupAudio, pickAudioQuality, parseGooglevideoUrl, validateSummary, buildVariants, rangedParts, trackExt, newDiag, recordRequest, buildDiagnostics,
} from '../lib/youtube.js';
import { mp3Bitrate, mp3EstimateBytes, encodeMp3, decodeToPcm, MP3_MAX_SECONDS } from '../lib/mp3.js';
import { resolveClients, buildPlayerRequest, parsePlayerResponse, urlParamNames, parseSwData, buildSessionPlayerRequest, makeCpn, withCpn, MIB } from '../lib/ytapi.js';
import '../lib/mux.js'; // publishes globalThis.__vdlMux (shared with the page-world recorder)
import { getSettings, saveSettings, addHistory, DEFAULTS } from '../utils/settings.js';
import { COMMAND_OF, isValidShortcut } from '../lib/shortcuts.js';
import { dlog, configureLog, flushLog, logEnabled } from '../utils/debuglog.js';
import { diagLines } from '../lib/debuglog.js';
import { classifyYt } from '../lib/ytverdict.js';

const MAX_ITEMS_PER_TAB = 60;
const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl', 'application/mpegurl'];
const SKIP_HOSTS = /(^|\.)googlevideo\.com$/; // YouTube chunks are useless as standalone files

const tabs = new Map(); // tabId -> { items: Map, hidden: Set, resolved: Set, pageTitle, thumbnail }
const jobs = new Map(); // jobId -> job
const tracked = new Map(); // downloadId -> { resolve, blobUrl }
let jobSeq = 0;
let settings = { ...DEFAULTS };
let consent = null; // accepted terms of use (utils/consent.js); downloads are refused without it
let keepAlive = null;

// ---------------------------------------------------------------- state ----

function getTab(tabId) {
  let t = tabs.get(tabId);
  if (!t) {
    t = { items: new Map(), hidden: new Set(), resolved: new Set(), pageTitle: '', thumbnail: '', yt: null };
    tabs.set(tabId, t);
  }
  return t;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const dump = {};
      for (const [id, t] of tabs) {
        dump[id] = { items: [...t.items.values()], hidden: [...t.hidden], pageTitle: t.pageTitle, thumbnail: t.thumbnail, yt: t.yt || null };
      }
      await browser.storage.session.set({ tabs: dump });
    } catch { /* storage.session unavailable: in-memory only */ }
  }, 400);
}

const ready = (async () => {
  // 1.5.5dev4: "Creative Commons only" is now on by default; applied once to existing installs (the popup lets the user turn it off)
  try {
    if (!(await browser.storage.local.get('ccDefaultMigrated')).ccDefaultMigrated) {
      await saveSettings({ ytCcOnly: true });
      await browser.storage.local.set({ ccDefaultMigrated: true });
    }
  } catch { /* storage unavailable */ }
  // 1.6.0dev6: the minimum size of a listed file is 150 KB again; installs that kept the old default 10 KB move to it once
  try {
    if (!(await browser.storage.local.get('minSizeMigrated')).minSizeMigrated) {
      const cur = (await browser.storage.local.get('settings')).settings;
      if (cur && Number(cur.minSizeKB) === 10) await saveSettings({ minSizeKB: 150 });
      await browser.storage.local.set({ minSizeMigrated: true });
    }
  } catch { /* storage unavailable */ }
  settings = await getSettings();
  configureLog(settings);
  if (settings.debugLog) {
    const m = browser.runtime.getManifest();
    dlog('start', `VDL ${m.version_name || m.version} ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`);
    dlog('settings', 'loaded', { ...settings, ytClientOverrides: settings.ytClientOverrides ? `(${settings.ytClientOverrides.length} chars)` : '' });
  }
  await loadUiLang(settings.uiLang);
  try { consent = (await browser.storage.local.get('consent')).consent || null; } catch { consent = null; }
  try {
    const { tabs: dump } = await browser.storage.session.get('tabs');
    for (const [id, d] of Object.entries(dump || {})) {
      const t = getTab(Number(id));
      d.items.forEach((it) => t.items.set(it.id, it));
      d.hidden.forEach((h) => t.hidden.add(h));
      t.pageTitle = d.pageTitle || '';
      t.thumbnail = d.thumbnail || '';
      t.yt = d.yt || null;
    }
  } catch { /* ignore */ }
  // the page Referers of servers that want them (1.6.4): back after the background slept
  try {
    const { refs } = await browser.storage.session.get('refs');
    if (ytHdr.restoreRefs(refs)) dlog('headers', 'page Referers restored', { domains: (refs || []).map((r) => r[0]) });
  } catch { /* ignore */ }
})();
ytHdr.onRefsChange = () => { browser.storage.session.set({ refs: ytHdr.refEntries() }).catch(() => {}); };
ytHdr.onRulesError = (e) => dlog('headers', 'header rules were not applied', { error: String(e?.message || e) });

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.consent) {
    consent = changes.consent.newValue || null;
    dlog('consent', isAccepted(consent) ? 'terms accepted' : 'terms not accepted / withdrawn');
  }
  if (area === 'local' && changes.settings) {
    const before = { ...DEFAULTS, ...(changes.settings.oldValue || {}) };
    settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
    if (before.debugLog && !settings.debugLog) { dlog('settings', 'debug log switched off'); flushLog(); }
    configureLog(settings);
    if (settings.debugLog) {
      const diff = {};
      for (const k of Object.keys(settings)) if (JSON.stringify(settings[k]) !== JSON.stringify(before[k])) diff[k] = k === 'ytClientOverrides' ? '(changed)' : settings[k];
      dlog('settings', before.debugLog ? 'changed' : 'debug log switched on', diff);
    }
    // the date the user switched "Creative Commons only" off (shown in the terms); removed when it is switched on again
    const wasOn = (changes.settings.oldValue || {}).ytCcOnly !== false;
    if (settings.ytCcOnly === false && wasOn) browser.storage.local.set({ ccOffAt: Date.now() }).catch(() => {});
    else if (settings.ytCcOnly !== false) browser.storage.local.remove('ccOffAt').catch(() => {});
    if (['hotkeys', 'hkExecute', 'hkVideo', 'hkAudio'].some((k) => settings[k] !== before[k])) applyHotkeys();
    loadUiLang(settings.uiLang).catch(() => {});
    for (const [tabId, t] of tabs) if (t.yt?.summary) refreshYoutube(tabId); // e.g. CC-only toggled
  }
});

let notifyTimer = null;
function notifyUI(tabId) {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    browser.runtime.sendMessage({ type: 'state_changed', tabId }).catch(() => {});
  }, 120);
}

function downloadable(it) {
  return !it.protected && (!it.live || it.kind === 'hls') && it.status !== 'error' && !it.noteKey;
}

function updateBadge(tabId) {
  const t = tabs.get(tabId);
  const n = t ? shownItems(t).filter((it) => downloadable(it) && !it.secondary && !feedExtras(tabId, it).secondary).length : 0;
  browser.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  if (n) browser.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
}

// ------------------------------------------------------------ detection ----

// JoyReactor's own interface clips (…/images/videowithsound.mp4 — the "video with sound" badge) are not media of a post
const JR_UI = /^https?:\/\/(?:[^/]+\.)?(?:joyreactor\.(?:com|cc)|reactor\.cc)(?::\d+)?\/images\//i;

function addItem(tabId, data) {
  if (JR_UI.test(data.url || '')) return null;
  if (!data.jr) {
    const jp = jrParse(data.url);
    if (jp) return addJoyreactor(tabId, data, jp);
  }
  const t = getTab(tabId);
  const key = normalizeUrl(data.url);
  if (t.hidden.has(key)) return null;
  // a site's page data gives its own id (the addresses are signed and change on every load); a playlist the player
  // fetched with the same address stays a separate entry
  const id = data.siteList && data.id ? data.id : hashId(`${data.kind}:${key}`);
  let it = t.items.get(id);
  if (it) {
    for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null && v !== '' && k !== 'id') it[k] ??= v;
    return it;
  }
  if (t.items.size >= MAX_ITEMS_PER_TAB) t.items.delete(t.items.keys().next().value);
  it = { status: 'ready', ts: Date.now(), ...data, id };
  t.items.set(id, it);
  if (it.referer) ytHdr.setRef(refDomain(it.url), it.referer); // the media server wants the page as Referer / Origin
  if (it.kind === 'file' && (it.variants || []).length) fileVariantSizes(tabId, it);
  dlog('detect', `${it.kind} via ${it.source || 'network'}`, { tab: tabId, url: it.url });
  if (it.kind === 'hls' && !it.siteList) enrichHls(tabId, it);
  else if (it.kind === 'dash') enrichDash(tabId, it);
  updateBadge(tabId);
  scheduleSave();
  notifyUI(tabId);
  return it;
}

// ---- JoyReactor (1.6.4): one card per post with MP4, WEBM and the original GIF -----------------
const JR_ORDER = { mp4: 0, webm: 1, gif: 2 };
function jrVariant(fmt, url, size) {
  return fmt === 'gif'
    ? { url, ext: 'gif', type: 'gif', typeLabel: 'GIF', label: 'GIF', labelKey: 'gifOriginal', height: 9999, codec: '', size: size || 0, sizeEstimated: false } // first in the GIF list
    : { url, ext: fmt, type: fmt, typeLabel: fmt.toUpperCase(), label: fmt.toUpperCase(), height: 0, codec: fmt === 'webm' ? 'VP8/VP9' : 'H.264', size: size || 0, sizeEstimated: false };
}
function jrAddVariant(tabId, it, fmt, url, size, seen = false) {
  const had = it.variants.find((v) => v.ext === fmt);
  if (had) { if (seen) { had.seen = true; had.missing = false; } return false; }
  it.variants.push({ ...jrVariant(fmt, url, size), ...(seen ? { seen: true } : {}) }); // seen: the page itself loaded it
  it.variants.sort((a, b) => JR_ORDER[a.ext] - JR_ORDER[b.ext]);
  it.url = it.variants[0].url; // the default download
  it.ext = it.variants[0].ext;
  it.mime = it.ext === 'gif' ? 'image/gif' : `video/${it.ext}`;
  it.size = it.variants[0].size || it.size || 0;
  return true;
}
// the pictures server answers 404 without the site as Referer: the extension's requests get the page's address,
// like the page's own player sends it (only the extension's requests)
function jrRef(tabId, url) {
  const page = tabs.get(tabId)?.pageUrl || '';
  return ytHdr.setRef(refDomain(url), isJoyreactorPage(page) ? page : `https://${refDomain(url)}/`);
}
function addJoyreactor(tabId, data, p) {
  const t = getTab(tabId);
  if (t.hidden.has(normalizeUrl(data.url))) return null;
  const id = hashId(`jr:${p.host.replace(/^img\d*\./, '')}:${p.id}`);
  let it = t.items.get(id);
  if (!it) {
    it = addItem(tabId, {
      kind: 'file', url: data.url, ext: p.fmt, mime: p.fmt === 'gif' ? 'image/gif' : `video/${p.fmt}`, title: jrTitle(p.slug) || `joyreactor ${p.id}`,
      site: 'joyreactor', source: data.source || 'network', siteList: true, id, jr: { host: p.host, slug: p.slug, post: p.id }, variants: [],
      thumbnail: data.thumbnail || undefined, duration: data.duration || 0,
    });
    if (!it) return null;
    jrRef(tabId, data.url);
    jrAddVariant(tabId, it, p.fmt, data.url, data.size, data.source !== 'page');
    if (p.fmt !== 'gif') jrFindGif(tabId, it, p);
  } else {
    if (data.thumbnail && !it.thumbnail) it.thumbnail = data.thumbnail;
    if (data.duration && !it.duration) it.duration = data.duration;
    const v = it.variants.find((x) => x.ext === p.fmt);
    if (v && data.size && !v.size) v.size = data.size;
    if (!jrAddVariant(tabId, it, p.fmt, data.url, data.size, data.source !== 'page') && !data.thumbnail && !data.duration) return it;
  }
  fileVariantSizes(tabId, it);
  scheduleSave();
  notifyUI(tabId);
  return it;
}
// the post's original GIF: the first candidate address the server answers with a GIF
async function jrFindGif(tabId, it, p) {
  for (const url of jrGifCandidates(p)) {
    try {
      const r = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-0' } });
      const ct = (r.headers?.get?.('content-type') || '').toLowerCase();
      const total = Number((/\/(\d+)\s*$/.exec(r.headers?.get?.('content-range') || '') || [])[1]) || Number(r.headers?.get?.('content-length')) || 0;
      r.body?.cancel?.().catch(() => {});
      if ((r.status === 200 || r.status === 206) && ct.startsWith('image/gif')) {
        dlog('detect', 'joyreactor: original GIF found', { tab: tabId, url });
        if (jrAddVariant(tabId, it, 'gif', url, r.status === 206 ? total : 0)) { scheduleSave(); notifyUI(tabId); }
        return;
      }
    } catch { /* try the next address */ }
  }
  dlog('detect', 'joyreactor: no original GIF', { tab: tabId, post: p.id });
}

// ---- GIF made from the video in the browser (1.6.4; Firefox: needs the background page's document) --------
// settings.gifMake: 'joyreactor' (default) | 'all' | 'off'
function gifMode() { return ['off', 'joyreactor', 'all'].includes(settings.gifMake) ? settings.gifMake : 'joyreactor'; }
// the files the server really has (a variant answered 404 is left out while another one is there)
function availableVariants(it) {
  const vs = it.variants || [];
  const ok = vs.filter((v) => !v.missing);
  return ok.length ? ok : vs;
}
// the videos a GIF can be made from: every available video file (WEBM first: Firefox always decodes it)
function gifSources(it) {
  const vs = it.variants?.length ? availableVariants(it) : [{ url: it.url, ext: pickExt(it) }];
  const video = vs.filter((v) => ['webm', 'mp4', 'm4v', 'mov'].includes(v.ext));
  return video.sort((a, b) => Number(b.ext === 'webm') - Number(a.ext === 'webm'));
}
const gifSource = (it) => gifSources(it)[0] || null;
function gifAllowed(tabId, it) {
  // Firefox: the background page has a document; Chrome / Edge: the offscreen document (1.6.4)
  if (it.kind !== 'file' || (!IS_CHROME && typeof document === 'undefined')) return false;
  const mode = gifMode();
  if (mode === 'off') return false;
  if (mode === 'joyreactor' && !it.jr && !isJoyreactorPage(tabs.get(tabId)?.pageUrl || '')) return false;
  if (/^audio\//.test(it.mime || '') || it.duration > GIF_MAX_SECONDS + 0.5) return false;
  return !!gifSource(it);
}
// What a file card offers: the site's variants (or the file itself) + GIFs made from the video. null: just the file.
function fileOffer(tabId, it) {
  const base = it.variants?.length ? availableVariants(it) : null;
  if (!gifAllowed(tabId, it)) return base;
  const ext = pickExt(it);
  const list = base ? base.slice() : [{ url: it.url, ext, type: ext, typeLabel: ext.toUpperCase(), label: ext.toUpperCase(), height: 0, codec: '', size: it.size || 0, sizeEstimated: false }];
  // from every available video: "480px · from WEBM", "320px · from WEBM", "480px · from MP4" ...
  const sources = gifSources(it);
  for (const src of sources) {
    for (const w of [480, 320]) {
      list.push({ url: src.url, ext: 'gif', type: 'gif', typeLabel: 'GIF', label: `${w}px`, labelKey: sources.length > 1 ? `gifFrom${src.ext === 'webm' ? 'Webm' : 'Mp4'}` : 'gifMade', height: w - (src.ext === 'webm' ? 0 : 1), codec: '', size: 0, sizeEstimated: false, makeGif: w, srcExt: src.ext });
    }
  }
  return list;
}

function header(details, name) {
  const h = (details.responseHeaders || []).find((x) => x.name.toLowerCase() === name);
  return h ? (h.value || '') : '';
}

function onHeaders(details) {
  if (details.tabId < 0 || (details.statusCode !== 200 && details.statusCode !== 206)) return;
  let url;
  try { url = new URL(details.url); } catch { return; }
  if (SKIP_HOSTS.test(url.hostname)) return;

  // Instagram feeds the player in small byte-range pieces; its real media comes from the page data (injected/instagram.js).
  const docHost = hostOf(details.documentUrl || details.originUrl || '');
  if (/(^|\.)instagram\.com$/.test(docHost) || url.searchParams.has('bytestart')) return;

  const ext = urlExt(details.url);
  if (SKIP_EXTS.includes(ext)) return;
  const ct = header(details, 'content-type').split(';')[0].trim().toLowerCase();

  let kind = null;
  if (ext === 'm3u8' || HLS_TYPES.includes(ct)) kind = 'hls';
  else if (ext === 'mpd' || ct === 'application/dash+xml') kind = 'dash';
  else if (ct === 'video/mp2t' || ct === 'audio/mp2t') return;
  else if (ct.startsWith('video/') || ct.startsWith('audio/')) kind = 'file';
  else if (FILE_EXTS.includes(ext) && (ct === 'application/octet-stream' || ct === 'binary/octet-stream' || !ct)) kind = 'file';
  if (!kind) return;

  let size = 0;
  const range = /\/(\d+)\s*$/.exec(header(details, 'content-range'));
  if (range) size = Number(range[1]);
  else if (details.statusCode === 200) size = Number(header(details, 'content-length')) || 0;

  if (kind === 'file' && size && size < settings.minSizeKB * 1024) return;

  // the page that asked for it (the player's document): its address is the Referer for a server that refuses the extension
  const docUrl = /^https?:\/\//.test(details.documentUrl || '') ? details.documentUrl : (/^https?:\/\//.test(details.initiator || '') ? `${details.initiator}/` : '');
  ready.then(() => addItem(details.tabId, {
    docUrl: docUrl || undefined,
    kind, url: kind === 'hls' ? stripLlHls(details.url) : details.url, size, mime: ct, ext: FILE_EXTS.includes(ext) ? ext : '', source: 'network',
  }));
}

browser.webRequest.onHeadersReceived.addListener(
  onHeaders,
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object', 'main_frame'] },
  ['responseHeaders'],
);

async function enrichHls(tabId, it) {
  it.status = 'parsing';
  try {
    const pl = parsePlaylist(await fetchTextFor(tabId, it, it.url), it.url);
    if (pl.type === 'master') {
      it.master = true;
      // The same quality is often listed twice (primary + backup CDN): keep the first of each resolution/bitrate.
      const seenQ = new Set();
      it.variants = pl.variants.map((v) => ({
        // 50/60 fps streams (Twitch "1080p60") are labelled so they differ from the 30 fps variant of the same height
        url: v.url, label: v.frameRate > 30 ? `${v.label}${Math.round(v.frameRate)}` : v.label, codecs: v.codecs || '', bandwidth: v.bandwidth, width: v.width, height: v.height, audioUrl: v.audio?.url || null,
      })).filter((v) => { const k = `${v.height}|${v.bandwidth}|${v.codecs}|${v.audioUrl || ''}`; if (seenQ.has(k)) return false; seenQ.add(k); return true; });
      const t = getTab(tabId);
      const children = [...pl.variants.map((v) => v.url), ...pl.audios.map((a) => a.url)].map(normalizeUrl);
      for (const c of children) {
        t.hidden.add(c);
        for (const [id, other] of t.items) if (normalizeUrl(other.url) === c) t.items.delete(id);
      }
      updateSynth(tabId); // the real master is there: an entry put together from its playlists is not needed
      // Is it a live stream? Look at the best variant's playlist (no #EXT-X-ENDLIST).
      try {
        const first = parsePlaylist(await fetchTextFor(tabId, it, pl.variants[0].url), pl.variants[0].url);
        if (first.type !== 'master') { it.live = first.live; it.fmt = first.hasMap ? 'mp4' : 'ts'; if (first.protected) it.protected = true; }
      } catch { /* the playlist is checked again when the download starts */ }
    } else {
      it.duration = pl.duration;
      it.fmt = pl.hasMap ? 'mp4' : 'ts';
      it.live = pl.live;
      it.protected = pl.protected;
      if (pl.hasMap && !pl.protected) await probeTrack(it, pl, it.via === 'page' ? pageFetchFn(tabId) : fetch);
      // names to find this playlist's <video> in a feed of short videos (cover picture, title)
      const media = [pl.segments[0]?.url, pl.segments.find((s) => s.map)?.map?.url].filter(Boolean);
      it.stems = playlistStems(it.url, media);
      it.mediaName = media.length ? fileStem(media[0], true) : '';
    }
    it.status = 'ready';
    if (it.track) updateSynth(tabId);
  } catch (e) {
    it.status = 'error';
    it.error = String(e.message || e);
    dlog('detect', `${it.kind} playlist failed`, { error: it.error, url: it.url });
  }
  updateBadge(tabId);
  scheduleSave();
  notifyUI(tabId);
}

// fMP4 media playlist: what its init segment holds (video / sound, size, codec). A playlist with only video or only
// sound also gets a bitrate from its last segment, to label and sort the qualities of an entry put together below.
async function probeTrack(it, pl, fetch = globalThis.fetch) {
  const map = pl.segments.find((s) => s.map)?.map;
  if (!map) return;
  try {
    const r = await fetch(map.url, { credentials: 'include', headers: map.range ? { Range: `bytes=${map.range.start}-${map.range.end}` } : {} });
    if (!r.ok) return;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 1024 * 1024) return;
    it.track = trackInfo(describeInit(buf));
  } catch (e) { dlog('detect', 'init segment not read', { error: String(e?.message || e) }); return; }
  if (it.track.video === it.track.audio) return; // muxed (or unknown): nothing to join
  const seg = pl.segments.filter((s) => s.duration > 0.5).pop();
  if (!seg) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(seg.url, { credentials: 'include', signal: ctl.signal, headers: seg.range ? { Range: `bytes=${seg.range.start}-${seg.range.end}` } : {} });
    if (r.ok) {
      const n = Number(r.headers?.get?.('content-length')) || (await r.arrayBuffer()).byteLength;
      if (n) it.bandwidth = Math.round((n * 8) / seg.duration);
      r.body?.cancel?.().catch(() => {});
    }
  } catch { /* no bitrate: sorted by size only */ } finally { clearTimeout(timer); }
}

// Video and sound published as separate media playlists and no readable master: one entry per folder with the
// qualities, each recorded together with the sound and joined into one file. The single playlists go under "More".
function updateSynth(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  const media = [...t.items.values()].filter((x) => x.kind === 'hls' && !x.master && x.track && x.status !== 'error');
  const keep = new Set();
  for (const g of buildSynthGroups(media)) {
    const id = hashId(`hls-synth:${g.dir}`);
    keep.add(id);
    let s = t.items.get(id);
    if (!s) {
      s = { id, kind: 'hls', source: 'network', synthetic: true, master: true, status: 'ready', ts: Date.now(), mime: 'application/vnd.apple.mpegurl', size: 0, ext: '' };
      t.items.set(id, s);
      dlog('detect', 'hls entry put together from separate video and audio playlists', { tab: tabId, url: g.dir, qualities: g.variants.length });
    }
    Object.assign(s, { url: g.variants[0].url, dir: g.dir, variants: g.variants, live: g.live, fmt: 'mp4' });
    for (const mid of g.members) { const mi = t.items.get(mid); if (mi) mi.synthOf = id; }
  }
  for (const [id, x] of t.items) {
    if (x.synthetic && !keep.has(id)) t.items.delete(id);
    else if (x.synthOf && !keep.has(x.synthOf)) x.synthOf = '';
  }
  updateBadge(tabId);
  scheduleSave();
  notifyUI(tabId);
}

async function enrichDash(tabId, it) {
  it.status = 'parsing';
  try {
    const mpd = parseMPD(await fetchText(it.url), it.url);
    it.duration = mpd.duration;
    it.live = mpd.live;
    it.protected = mpd.protected;
    const reps = mpd.videos.length ? mpd.videos : mpd.audios;
    it.variants = reps.map((r, i) => ({ index: i, label: r.label, bandwidth: r.bandwidth, width: r.width, height: r.height, codecs: r.codecs, mime: r.mime }));
    it.hasAudioTrack = mpd.videos.length > 0 && mpd.audios.length > 0;
    it.audioReps = mpd.videos.length && mpd.audios.length ? mpd.audios.map((r, i) => ({ rep: i, bandwidth: r.bandwidth, mime: r.mime, codecs: r.codecs, lang: r.lang })) : [];
    it.status = it.variants.length ? 'ready' : 'error';
    if (!it.variants.length) it.error = 'No downloadable representations';
  } catch (e) {
    it.status = 'error';
    it.error = String(e.message || e);
    dlog('detect', 'dash manifest failed', { error: it.error, url: it.url });
  }
  updateBadge(tabId);
  scheduleSave();
  notifyUI(tabId);
}

// --------------------------------------------------------------- UI API ----

// X / Twitter: media id inside the video address, to match it with the tweet it belongs to.
function xMediaId(url) {
  const m = String(url).match(/video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/(\d+)\//) || String(url).match(/video\.twimg\.com\/tweet_video\/([\w-]+)\./);
  return m ? m[1] : '';
}
// Items to show: on X only the videos that are on screen or playing (when the page told us), else everything.
const isTwitchPlaylist = (u) => /(^|\.)ttvnw\.net$/.test(hostOf(u));
// Amazon IVS (Kick and others): the master and the quality playlists the player fetches come from *.live-video.net
const isIvsPlaylist = (u) => /(^|\.)live-video\.net$/.test(hostOf(u));
const TIKTOK_HOST = /(^|\.)(tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|ibytedtos\.com)$/;
const isTikTokFile = (it) => it.kind === 'file' && TIKTOK_HOST.test(hostOf(it.url));
const ttKey = (u) => { try { return new URL(u).pathname.replace(/\/+$/, ''); } catch { return ''; } };
const ttInfo = (t, it) => t?.tiktok?.get(ttKey(it.url)) || (it.size ? t?.ttSizes?.get(it.size) : null) || null; // by file path, else by size
function shownItems(t) {
  let all = [...t.items.values()];
  // TikTok: the feed preloads the next videos. Show the file of the video on screen; the login-page promo clip is not a video of the user.
  if (all.some(isTikTokFile) || (t.pageUrl && /tiktok\.com/.test(t.pageUrl))) {
    all = all.filter((it) => !(it.kind === 'file' && /(^|\.)ttwstatic\.com$/.test(hostOf(it.url))));
    const tt = all.filter(isTikTokFile);
    const latest = new Map(); // one entry per file path (the address is reloaded with a new signature)
    for (const it of tt) latest.set(ttKey(it.url), it);
    // the video on screen last (the popup lists newest first, so it ends up on top), then at most 5 others, newest first
    const isVis = (it) => !!ttInfo(t, it)?.visible;
    const vis = [...latest.values()].filter(isVis);
    const others = [...latest.values()].filter((it) => !isVis(it)).sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-5);
    const keep = [...others, ...vis];
    all = [...all.filter((it) => !isTikTokFile(it)), ...keep];
  }
  // Twitch: the player also fetches the quality playlists; the master ("usher") item already offers them all.
  if (all.some((it) => it.kind === 'hls' && it.master && isTwitchPlaylist(it.url))) {
    all = all.filter((it) => !(it.kind === 'hls' && !it.master && isTwitchPlaylist(it.url)));
    // one card for the stream being watched: Twitch is a single-page app, so masters of channels visited earlier stay in the list
    const twMaster = (it) => it.kind === 'hls' && it.master && /^https:\/\/usher\.ttvnw\.net\//.test(it.url);
    const twChan = (u) => ((/channel\/hls\/([\w-]+)\.m3u8/.exec(u) || [])[1] || '').toLowerCase();
    const masters = all.filter(twMaster);
    const pageCh = ((/twitch\.tv\/([\w-]+)/i.exec(t.pageUrl || '') || [])[1] || '').toLowerCase();
    // A master of another channel is used only if it appeared after the page address changed (embedded/popout players);
    // right after an SPA switch the new channel's master is not there yet, so nothing is shown instead of the old channel.
    const cur = (pageCh && masters.filter((m) => twChan(m.url) === pageCh).pop())
      || masters.filter((m) => (m.ts || 0) >= (t.pageChangedAt || 0)).pop();
    all = all.filter((it) => !twMaster(it) || it === cur);
  }
  // Qualities from the site's page data (HLS list, MP4 list): the playlists the player fetched (one quality) go under "More"
  if (all.some((it) => it.siteList || (it.kind === 'file' && (it.variants || []).length > 1))) {
    all = all.map((it) => (it.kind === 'hls' && !it.siteList && (it.variants || []).length <= 1 ? { ...it, secondary: true } : it));
  }
  // Separate video / audio playlists put together into one entry: the single playlists (and a master of that folder
  // that could not be read) go under "More"
  const synthDirs = new Set(all.filter((it) => it.synthetic).map((it) => it.dir));
  if (synthDirs.size) {
    all = all.map((it) => (it.kind === 'hls' && !it.synthetic && ((it.synthOf && t.items.has(it.synthOf)) || (it.status === 'error' && synthDirs.has(playlistDir(it.url)))) ? { ...it, secondary: true } : it));
  }
  // Kick / Amazon IVS: when the master playlist (all qualities) is there, the single quality playlists the player
  // fetched go under "More" (they have no quality list of their own)
  if (all.some((it) => it.kind === 'hls' && it.master && (it.variants || []).length && isIvsPlaylist(it.url))) {
    all = all.map((it) => (it.kind === 'hls' && !it.master && isIvsPlaylist(it.url) ? { ...it, secondary: true } : it));
  }
  if (!t.xMedia || !t.xMedia.size) return all;
  const vis = all.filter((it) => { const x = t.xMedia.get(xMediaId(it.url)); return x && x.visible; });
  return vis.length ? vis : all;
}
async function handleTikTok(msg, sender) {
  await ready;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return;
  const t = getTab(tabId);
  t.tiktok = new Map();
  t.ttSizes = new Map();
  for (const x of (msg.list || []).slice(0, 30)) {
    if (!x || typeof x !== 'object') continue;
    const info = {
      id: String(x.id || '').replace(/\D/g, '').slice(0, 25), author: String(x.author || '').slice(0, 40), desc: String(x.desc || '').slice(0, 160),
      poster: /^https:\/\//.test(x.poster || '') ? String(x.poster).slice(0, 1500) : '', visible: !!x.visible,
    };
    for (const k of (Array.isArray(x.keys) ? x.keys : [x.key]).slice(0, 12)) if (typeof k === 'string' && k) { const old = t.tiktok.get(k); t.tiktok.set(k, old && old.visible && !info.visible ? old : info); }
    for (const n of (x.sizes || []).slice(0, 12)) if (Number(n) > 0) { const old = t.ttSizes.get(Number(n)); t.ttSizes.set(Number(n), old && old.visible && !info.visible ? old : info); }
  }
  const dbg = msg.dbg || {};
  t.ttScan = { keys: t.tiktok.size, sizes: t.ttSizes.size, at: new Date().toISOString(), videos: Number(dbg.videos) || 0, blob: Number(dbg.blob) || 0, http: Number(dbg.http) || 0, fiber: Number(dbg.fiber) || 0, link: Number(dbg.link) || 0, none: Number(dbg.none) || 0, shapes: String(dbg.shapes || '').slice(0, 300) };
  if (msg.url) { if (msg.url !== t.pageUrl) t.pageChangedAt = Date.now(); t.pageUrl = String(msg.url); }
  updateBadge(tabId);
  notifyUI(tabId);
}
async function handleX(msg, sender) {
  await ready;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return;
  const t = getTab(tabId);
  t.xMedia = new Map();
  for (const x of (msg.list || []).slice(0, 60)) {
    if (x && typeof x.id === 'string') t.xMedia.set(x.id, { author: String(x.author || '').replace(/[^\w]/g, '').slice(0, 30), tweetId: String(x.tweetId || '').replace(/\D/g, '').slice(0, 25), visible: !!x.visible });
  }
  updateBadge(tabId);
  notifyUI(tabId);
}

function displayTitle(tabId, it) {
  const t = tabs.get(tabId);
  const xi = t?.xMedia?.get(xMediaId(it.url));
  if (xi && xi.author) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `x_${xi.author}_${xi.tweetId || xMediaId(it.url)}_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  }
  if (isTikTokFile(it)) {
    const ti = ttInfo(t, it);
    if (ti && (ti.id || ti.author)) {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const who = String(ti.author || '').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 40);
      return `tiktok_${who ? who + '_' : ''}${ti.id || ''}_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`.replace('__', '_');
    }
  }
  if (it.mediaName && feedVideo(t, it)) return humanStem(it.mediaName); // a video of a feed: its own name, not the page's
  if (it.source === 'youtube-live' && it.ytVideoId) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `youtube_${it.ytVideoId}_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  }
  const tw = /^https:\/\/usher\.ttvnw\.net\/api\/(?:v2\/)?channel\/hls\/([\w-]+)\.m3u8/.exec(it.url);
  if (tw) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `twitch_${tw[1]}_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  }
  if (it.source === 'instagram' && it.igAccount) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${(it.site || 'instagram.com').split('.')[0]}_${it.igAccount}_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  }
  return it.title || t?.pageTitle || hostOf(t?.pageUrl || '') || hostOf(it.url) || 'video'; // the page's site before the media server
}

function serialize(tabId, it) {
  const t = tabs.get(tabId);
  return {
    id: it.id, kind: it.kind, url: it.url, title: displayTitle(tabId, it), thumbnail: it.thumbnail || t?.thumbnail || '',
    duration: it.duration || 0, size: it.size || 0, quality: it.quality || '', mime: it.mime || '', ext: it.ext || '',
    license: it.kind === 'yt' ? (t?.yt?.summary?.license || '') : '', // 'cc' -> "CC BY" badge in the card
    subs: it.kind === 'yt' && settings.subs !== false ? subsChoices(ytSubsList(t?.yt), uiLangCode()).map((c) => ({ id: c.id, lang: c.lang, label: c.label, tlang: c.tlang })) : [],
    variants: it.kind === 'yt'
      ? (it.variants || []).map((v) => ({ label: v.label, atype: v.atype || '', kbps: v.kbps || 0, height: v.height || 0, muxed: !!v.muxed, type: v.type || '', typeLabel: v.typeLabel || '', codec: v.codec || '', size: v.size || 0, audio: !!v.audio, mp3: !!v.mp3, sizeEstimated: !!v.sizeEstimated, unavailable: !!v.unavailable, tooLong: !!v.tooLong }))
      : it.kind === 'file' ? fileOffer(tabId, it) : serializeStreamVariants(it),
    multi: it.kind === 'file' && (it.variants || []).length > 0, // the site's own list (a plain file with GIFs stays a small file)
    audioVariants: it.kind === 'dash' ? dashAudioVariants(it) : [],
    master: !!it.master, hasAudioTrack: !!it.hasAudioTrack,
    beta: !!it.beta, live: !!it.live, protected: !!it.protected, noteKey: it.noteKey || '', why: it.why || '', whyReason: it.whyReason || '', whyStart: it.whyStart || 0, whyRecord: it.whyRecord || '', whyBusy: !!it.whyBusy, rec: it.rec || null, limitMB: it.limitMB || 0, apiState: it.apiState || '', dlFailed: !!it.dlFailed,
    status: it.status, error: it.error || '', source: it.source || '',
    ...(it.secondary ? { secondary: true } : {}),
    ...tiktokExtras(tabId, it),
    ...feedExtras(tabId, it),
  };
}
// A file offered in several qualities (site page data): the size of each from its first byte (Content-Range), in turn.
async function fileVariantSizes(tabId, it) {
  for (const v of it.variants) {
    if (v.size || v.missing) continue;
    try {
      const r = await fetch(v.url, { credentials: 'include', headers: { Range: 'bytes=0-0' } });
      const total = Number((/\/(\d+)\s*$/.exec(r.headers?.get?.('content-range') || '') || [])[1]) || 0;
      r.body?.cancel?.().catch(() => {});
      // a file the page names but the server does not have (JoyReactor: the MP4 of some posts) is not offered (1.6.4)
      if ((r.status === 404 || r.status === 410) && !v.seen) { // a file the page loaded itself is there (the request may lack something)
        v.missing = true;
        dlog('detect', 'variant not on the server', { tab: tabId, status: r.status, url: v.url });
        const first = availableVariants(it)[0];
        if (it.jr && first && !first.missing) { it.url = first.url; it.ext = first.ext; it.mime = first.ext === 'gif' ? 'image/gif' : `video/${first.ext}`; }
        notifyUI(tabId);
        continue;
      }
      if (total) {
        v.size = total;
        // the HLS list of the same video (site page data) shows the same quality's size as an estimate
        for (const o of tabs.get(tabId)?.items.values() || []) {
          if (o.kind === 'hls' && o.siteList && o.source === it.source) for (const ov of o.variants || []) if (ov.height && ov.height === v.height && !ov.size) ov.size = total;
        }
        notifyUI(tabId);
      }
    } catch { /* no size: the list still works */ }
  }
}

// Feed of short videos: the <video> this playlist plays in (by file names), or null
function feedVideo(t, it) {
  return it.kind === 'hls' && !it.master && it.stems && t?.feed?.length ? matchFeed(it.stems, t.feed) : null;
}
// Its card gets the video's cover picture; playlists of videos that are not on screen go under "More"
// (like TikTok). Only when at least one playlist was matched to a video on screen.
function feedExtras(tabId, it) {
  const t = tabs.get(tabId);
  const v = feedVideo(t, it);
  if (!v) return {};
  const items = [...(t?.items?.values() || [])].map((x) => feedVideo(t, x)).filter(Boolean);
  const anyVisible = items.some((x) => x.visible);
  const anyPlaying = items.some((x) => x.playing);
  const onScreen = anyVisible ? v.visible : (anyPlaying ? v.playing : true);
  return { ...(v.poster ? { thumbnail: v.poster } : {}), ...(onScreen ? {} : { secondary: true }) };
}
// TikTok card: the video's own caption and cover picture; files of videos that are not on screen are marked secondary ("More").
function tiktokExtras(tabId, it) {
  if (!isTikTokFile(it)) return {};
  const t = tabs.get(tabId);
  const x = ttInfo(t, it);
  const anyVisible = [...(t?.tiktok?.values() || []), ...(t?.ttSizes?.values() || [])].some((v) => v.visible);
  return { caption: x?.desc || '', thumbnail: x?.poster || '', secondary: anyVisible && !x?.visible };
}

// How TS streams are saved by default (1.6.4): 'mp4' | 'mkv' | 'ts'. Before 1.6.4 there was only the tsToMp4 checkbox.
const TS_FORMATS = ['mp4', 'mkv', 'ts'];
function tsFormat() {
  if (TS_FORMATS.includes(settings.tsFormat)) return settings.tsFormat;
  return settings.tsToMp4 === false ? 'ts' : 'mp4';
}

// HLS in the TS format (H.264) is offered three times: MP4 and MKV (both without re-encoding) and TS (as it is).
// The default format of the settings comes first (a hotkey takes the first entry).
// The popup sends the position in this list; the plan maps it back to the real variant and the output format.
// WEBM is not offered: TS in HLS carries H.264 / HEVC with AAC / MP3 / AC-3, which WebM cannot hold without re-encoding.
function hlsVariantPlan(it) {
  const base = it.variants && it.variants.length ? it.variants : (it.kind === 'hls' && it.fmt === 'ts' ? [{ label: it.quality || 'TS', bandwidth: 0, synthetic: true }] : null);
  if (!base) return null;
  const tsOn = it.kind === 'hls' && it.fmt === 'ts' && !it.protected;
  const def = tsFormat();
  const order = [def, ...TS_FORMATS.filter((f) => f !== def)];
  const byFmt = { mp4: [], mkv: [], ts: [] };
  const other = [];
  base.forEach((v, src) => {
    if (tsOn && repType(v.mime || '', v.codecs || '').key === 'mp4') { for (const f of TS_FORMATS) byFmt[f].push({ v, src, raw: f === 'ts', as: f, out: f }); } else other.push({ v, src, raw: false, as: '', out: it.fmt === 'ts' ? def : '' });
  });
  return [...byFmt[order[0]], ...other, ...byFmt[order[1]], ...byFmt[order[2]]];
}

// DASH / HLS variants for the popup: index, label, resolution, codec type and an estimated size.
function serializeStreamVariants(it) {
  if (!it.variants && !(it.kind === 'hls' && it.fmt === 'ts')) return null;
  if (it.kind !== 'dash' && it.kind !== 'hls') return it.variants;  // files: fileOffer() in serialize
  const bestAudio = Math.max(0, ...(it.audioReps || []).map((a) => a.bandwidth || 0));
  const plan = it.kind === 'hls' ? hlsVariantPlan(it) : it.variants.map((v, src) => ({ v, src, raw: false, as: '' }));
  return plan.map(({ v, as }, index) => {
    const vt = repType(v.mime || '', v.codecs || '');
    const live = it.kind === 'hls' && !!it.live;
    // DASH/HLS file: bitrate x duration; a live stream has no length, so show the data rate per minute instead.
    const size = v.size ? v.size : it.kind === 'dash' ? estimateSize((v.bandwidth || 0) + bestAudio, it.duration)
      : live ? Math.round(((v.bandwidth || 0) / 8) * 60)
        : it.kind === 'hls' && it.duration > 0 ? estimateSize(v.bandwidth || 0, it.duration) : 0;
    const label = v.synthetic ? '' : v.label;
    if (as) return { index, label, height: v.height || 0, width: v.width || 0, bandwidth: v.bandwidth || 0, type: as === 'mp4' ? vt.key : as, typeLabel: as.toUpperCase(), codec: vt.codec, size, sizeEstimated: true, perMin: live, fmt: '', tsDefault: as === tsFormat() };
    return { index, label, height: v.height || 0, width: v.width || 0, bandwidth: v.bandwidth || 0, type: vt.key, typeLabel: it.kind === 'hls' && it.fmt === 'ts' ? vt.short.replace('MP4', 'TS') : vt.short, codec: vt.codec, size, sizeEstimated: true, perMin: live, fmt: it.kind === 'hls' ? (it.fmt || '') : '' };
  });
}

// Separate audio track of a DASH manifest: MP3 (converted) at fixed bitrates + the original tracks.
function dashAudioVariants(it) {
  const reps = it.audioReps || [];
  if (!reps.length) return [];
  const best = reps.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  const seconds = Number(it.duration) || 0;
  const out = [];
  for (const kbps of MP3_KBPS) {
    out.push({ label: `MP3 ${kbps}`, mp3: true, atype: 'mp3', kbps, rep: best.rep, size: seconds ? mp3EstimateBytes(seconds, kbps) : 0, sizeEstimated: true, unavailable: !globalThis.lamejs && lameState !== 'unknown', tooLong: seconds > MP3_MAX_SECONDS });
  }
  for (const a of reps) {
    const kbps = Math.round((a.bandwidth || 0) / 1000);
    const webm = /webm/.test(a.mime || '');
    out.push({ label: `${webm ? 'WEBM' : 'M4A'} ${kbps}`, mp3: false, atype: webm ? 'webm' : 'm4a', kbps, rep: a.rep, lang: a.lang || '', size: estimateSize(a.bandwidth, seconds), sizeEstimated: true });
  }
  return out.map((v, index) => ({ ...v, index, audio: true }));
}

function serializeJob(j) {
  return { id: j.id, itemId: j.itemId || '', title: j.title, state: j.state, fileIndex: j.fileIndex, fileCount: j.fileCount, done: j.done, total: j.total, phase: j.phase || '', error: j.error || '', errorKey: j.errorKey || '', downloadId: j.downloadIds?.[0] ?? null, recording: !!j.recording, seconds: Math.round(j.seconds || 0), bytes: j.bytes || 0, speed: Math.round(j.speed || 0), eta: j.eta || 0, segments: j.segments || 0, stopping: !!j.stopping };
}

async function getState(tabId) {
  await ready;
  const t = tabs.get(tabId);
  return {
    items: t ? shownItems(t).map((it) => serialize(tabId, it)).reverse() : [],
    jobs: [...jobs.values()].filter((j) => { if (j.finishedAt && Date.now() - j.finishedAt > 60000) { jobs.delete(j.id); return false; } return true; }).map(serializeJob),
    prefs: { tsFormat: tsFormat(), subs: settings.subs !== false, subsSrt: settings.subsSrt !== false, subsWithVideo: !!settings.subsWithVideo, defaultQuality: settings.defaultQuality || 'best', defaultType: settings.defaultType || 'auto', defaultAudioFormat: settings.defaultAudioFormat || 'mp3', defaultAudioQuality: settings.defaultAudioQuality || 'best', ytRecordUi: !!settings.ytRecordUi },
    yt: t?.yt ? { videoKnown: !!t.yt.summary } : null,
    bug: t?.bug && (t.bug.state === 'running' || bugPageKey(t.bug.page) === bugPageKey(t.pageUrl)) ? { ...t.bug, text: undefined } : null, // a result belongs to the page (video) it was made on
  };
}

// -------------------------------------------------------------- download ----

async function notify(message) {
  if (!settings.notifications) return;
  try {
    await browser.notifications?.create({
      type: 'basic', iconUrl: browser.runtime.getURL('icons/icon-128.png'), title: tr('appName'), message,
    });
  } catch { /* ignore */ }
}

// a script address (".php", ".aspx" …) is not the file type: the media extension in the address, else the server's type
function pickExt(it) {
  return it.ext || mediaExt(it.url) || mimeToExt(it.mime) || 'mp4';
}

// ---- YouTube mobile-client API (main way) ------------------------------------
// Requests we make from the background to YouTube hosts carry the mobile client's
// User-Agent (and Origin for the API call). Page requests are never touched.
// Header state (ytHdr.ua / ytHdr.live / ytHdr.on) lives in service/headers.js: Firefox reads it in the blocking listeners below,
// Chrome turns it into declarativeNetRequest rules. ytHdr.on = Origin/Referer/DNT on googlevideo requests (1.4.3).
if (IS_CHROME) installChromeRules();
if (!IS_CHROME) try {
  const own = browser.runtime.getURL('');
  browser.webRequest.onBeforeSendHeaders.addListener((d) => {
    if (d.tabId !== -1) return {};
    const from = d.originUrl || d.documentUrl || '';
    if (from && !from.startsWith(own)) return {};
    if (d.url.includes('/sw.js_data')) {
      // session bootstrap with our own browser UA, Referer https://www.youtube.com/sw.js
      const hs = (d.requestHeaders || []).filter((h) => !['referer', 'origin'].includes(h.name.toLowerCase()));
      hs.push({ name: 'Referer', value: 'https://www.youtube.com/sw.js' });
      return { requestHeaders: hs };
    }
    if (!ytHdr.ua) {
      // live HLS segments (no mobile-client session): look like the page's player
      if (ytHdr.live && d.url.includes('googlevideo.com')) return { requestHeaders: [...(d.requestHeaders || []).filter((h) => !['referer', 'origin'].includes(h.name.toLowerCase())), { name: 'Origin', value: 'https://www.youtube.com' }, { name: 'Referer', value: 'https://www.youtube.com/' }] };
      return {};
    }
    const headers = (d.requestHeaders || []).filter((h) => !['user-agent', 'origin'].includes(h.name.toLowerCase()));
    headers.push({ name: 'User-Agent', value: ytHdr.ua });
    if (d.url.includes('/youtubei/')) headers.push({ name: 'Origin', value: 'https://www.youtube.com' }, { name: 'Referer', value: 'https://www.youtube.com/' });
    else if (ytHdr.on) {
      const keep = headers.filter((h) => !['referer', 'dnt'].includes(h.name.toLowerCase()));
      headers.length = 0;
      headers.push(...keep, { name: 'Origin', value: 'https://www.youtube.com' }, { name: 'Referer', value: 'https://www.youtube.com/' }, { name: 'DNT', value: '1' });
    }
    return { requestHeaders: headers };
  }, { urls: ['https://*.googlevideo.com/*', 'https://www.youtube.com/youtubei/*', 'https://www.youtube.com/sw.js_data'] }, ['blocking', 'requestHeaders']);
} catch { /* header spoofing unavailable: API calls may be refused, recording still works */ }

// Bilibili: its video servers and API want the site as Referer (the player sends it). Only for requests made by this extension.
if (!IS_CHROME) try {
  const ownBili = browser.runtime.getURL('');
  browser.webRequest.onBeforeSendHeaders.addListener((d) => {
    if (d.tabId !== -1) return {};
    const from = d.originUrl || d.documentUrl || '';
    if (from && !from.startsWith(ownBili)) return {};
    const tv = /(^|\.)(bilibili\.tv|biliintl\.com|bstarstatic\.com)$/.test(new URL(d.url).hostname);
    const site = tv ? 'https://www.bilibili.tv' : 'https://www.bilibili.com';
    const hs = (d.requestHeaders || []).filter((h) => !['referer', 'origin'].includes(h.name.toLowerCase()));
    hs.push({ name: 'Referer', value: `${site}/` });
    if (/api\./.test(new URL(d.url).hostname)) hs.push({ name: 'Origin', value: site });
    return { requestHeaders: hs };
  }, { urls: ['https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*', 'https://*.akamaized.net/*', 'https://*.hdslb.com/*', 'https://api.bilibili.com/*', 'https://*.bilibili.tv/*', 'https://*.biliintl.com/*', 'https://*.bstarstatic.com/*'] }, ['blocking', 'requestHeaders']);
} catch { /* header rule unavailable */ }

// TikTok: the video servers refuse requests without the site as Referer (the player sends it). Only for requests made by this extension.
if (!IS_CHROME) try {
  const ownTt = browser.runtime.getURL('');
  browser.webRequest.onBeforeSendHeaders.addListener((d) => {
    if (d.tabId !== -1) return {};
    const from = d.originUrl || d.documentUrl || '';
    if (from && !from.startsWith(ownTt)) return {};
    const hs = (d.requestHeaders || []).filter((h) => !['referer', 'origin'].includes(h.name.toLowerCase()));
    hs.push({ name: 'Referer', value: 'https://www.tiktok.com/' });
    return { requestHeaders: hs };
  }, { urls: ['https://*.tiktok.com/*', 'https://*.tiktokcdn.com/*', 'https://*.tiktokcdn-us.com/*', 'https://*.tiktokcdn-eu.com/*', 'https://*.ibytedtos.com/*', 'https://*.ibyteimg.com/*', 'https://*.byteimg.com/*'] }, ['blocking', 'requestHeaders']);
} catch { /* header rule unavailable */ }

// Servers that refused the extension (403 / 412): the page's Referer and Origin on the extension's own requests (1.6.4).
if (!IS_CHROME) try {
  const ownRef = browser.runtime.getURL('');
  browser.webRequest.onBeforeSendHeaders.addListener((d) => {
    if (d.tabId !== -1) return {};
    const page = ytHdr.ref(refDomain(d.url));
    if (!page) return {};
    const from = d.originUrl || d.documentUrl || '';
    if (from && !from.startsWith(ownRef)) return {};
    let origin = '';
    try { origin = new URL(page).origin; } catch { return {}; }
    const hs = (d.requestHeaders || []).filter((h) => !['referer', 'origin'].includes(h.name.toLowerCase()));
    hs.push({ name: 'Referer', value: page }, { name: 'Origin', value: origin });
    return { requestHeaders: hs };
  }, { urls: ['http://*/*', 'https://*/*'] }, ['blocking', 'requestHeaders']);
} catch { /* header rule unavailable */ }

// Last resort for such servers: the page fetches the file itself (the site's own address and cookies), the bytes come back here.
function pageFetchFn(tabId) {
  return async (url, init = {}) => {
    const range = init.headers?.Range || init.headers?.range || '';
    let r = null;
    try { r = await browser.tabs.sendMessage(tabId, { type: 'vdl_fetch', url, range }, { frameId: 0 }); } catch (e) { r = { ok: false, status: 0, error: String(e?.message || e) }; }
    if (!r) r = { ok: false, status: 0, error: 'no page script' };
    const buf = r.buf instanceof ArrayBuffer ? r.buf : new ArrayBuffer(0);
    return {
      ok: !!r.ok, status: r.status || 0, statusText: r.error || '',
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? (r.ct || '') : String(n).toLowerCase() === 'content-length' ? String(buf.byteLength) : '') },
      arrayBuffer: async () => buf,
      text: async () => new TextDecoder().decode(buf),
      json: async () => JSON.parse(new TextDecoder().decode(buf)),
      blob: async () => new Blob([buf], { type: r.ct || '' }),
      body: null,
    };
  };
}
const refusedStatus = (e) => { const m = /HTTP (403|412)\b/.exec(String(e?.message || '')); return m ? Number(m[1]) : 0; };

// Text of a playlist / manifest for an item of a tab: a plain request, then with the page's Referer / Origin, then through
// the page. it.via records what worked ('ref' / 'page'), so the download uses the same way.
async function fetchTextFor(tabId, it, url, opts = {}) {
  if (it.via === 'page') return fetchText(url, { ...opts, fetchFn: pageFetchFn(tabId) });
  try {
    return await fetchText(url, opts);
  } catch (e) {
    const status = refusedStatus(e);
    const page = tabs.get(tabId)?.pageUrl || it.docUrl || it.referer || '';
    if (!status || !page) throw e;
    if (!ytHdr.ref(refDomain(url))) {
      ytHdr.setRef(refDomain(url), page);
      dlog('detect', `HTTP ${status}: trying again with the page's Referer / Origin`, { host: hostOf(url) });
      try { const text = await fetchText(url, opts); it.via = 'ref'; return text; } catch (e2) { if (!refusedStatus(e2)) throw e2; }
    }
    dlog('detect', `HTTP ${status}: trying through the page`, { host: hostOf(url) });
    const text = await fetchText(url, { ...opts, fetchFn: pageFetchFn(tabId) });
    it.via = 'page';
    return text;
  }
}

async function fetchJsonTimeout(url, init, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(timer); }
}

// ---- MP3 encoder (vendor/lame.js, optional) ---------------------------------
let lameState = 'unknown'; // unknown | yes | no
let lamePromise = null;
function loadLame() {
  if (IS_CHROME) return Promise.resolve(null); // Chrome: the offscreen document owns the encoder
  if (globalThis.lamejs) { lameState = 'yes'; return Promise.resolve(globalThis.lamejs); }
  lamePromise ||= new Promise((resolve) => {
    try {
      if (typeof document === 'undefined') throw new Error('no document');
      const el = document.createElement('script');
      el.src = browser.runtime.getURL('vendor/lame.js');
      el.onload = () => { const l = globalThis.lamejs || null; lameState = l && l.Mp3Encoder ? 'yes' : 'no'; resolve(lameState === 'yes' ? l : null); };
      el.onerror = () => { lameState = 'no'; resolve(null); };
      (document.head || document.documentElement).appendChild(el);
    } catch { lameState = 'no'; resolve(null); }
  });
  return lamePromise;
}
loadLame();

// Variants for the API formats (1.4.3: the unreliable "last byte" limit logic was removed).
// 1.4.4: audio-only variants (M4A / WEBM, no re-encoding) plus an MP3 variant built from the best audio track.
function variantsFor(y) {
  const list = buildVariants(y?.summary, y?.captured || [], y?.api?.formats || []);
  const audios = list.filter((v) => v.audio);
  if (audios.length) {
    // MP3 is made from the best original track at a chosen bitrate.
    const best = audios.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    const seconds = Number(y.summary?.lengthSeconds) || 0;
    for (const kbps of MP3_KBPS) {
      list.push({
        label: `Audio · MP3 ${kbps} kbps`, height: 0, muxed: false, container: best.container, audio: true, mp3: true, atype: 'mp3', kbps,
        tracks: best.tracks, size: mp3EstimateBytes(seconds, kbps), sizeEstimated: true,
        unavailable: !globalThis.lamejs && lameState !== 'unknown', tooLong: seconds > MP3_MAX_SECONDS,
      });
    }
  }
  return list;
}

async function fetchYtApi(tabId, videoId) {
  const y = tabs.get(tabId)?.yt;
  if (!y?.summary || y.summary.videoId !== videoId || !y.api) return;
  const api = y.api;
  // VISIONOS, ANDROID_VR, IOS in that order.
  // Passes: "session" = sw.js_data bootstrap; "none" = bare request; "vdata" = with the page's visitorData.
  // IOS *formats* are not preferred (their links are cut off after ~1 minute without a PO token);
  // IOS is only a source of HLS. We keep IOS formats as the very last fallback.
  const modes = ['session', 'none'];
  if (y.summary.visitorData) modes.push('vdata');
  const clients = resolveClients(settings.ytClients, settings.ytClientOverrides);
  let iosFallback = null;
  let session = null;
  outer:
  for (const mode of modes) {
    const auth = mode === 'vdata' ? { include: true } : null;
    if (mode === 'session') {
      try {
        ytHdr.ua = '';
        const r = await fetchJsonTimeout('https://www.youtube.com/sw.js_data', { credentials: 'include', headers: { 'Accept-Language': 'en-US', Accept: '*/*' } }, 15000);
        session = r.ok ? parseSwData(await r.text()) : null;
        api.session = session ? 'ok' : `bad:${r.status}`;
      } catch (e) { api.session = `err:${String(e?.name || 'error')}`; }
      if (!session) continue;
    }
    for (const c of clients) {
      const entry = { client: c.key, version: c.version, mode, status: 0, playability: '', reason: '', formats: 0, withN: 0, hls: false, error: '', params: [] };
      api.log.push(entry);
      try {
        ytHdr.ua = c.ua;
        const req = mode === 'session' ? buildSessionPlayerRequest(c, videoId, session, -Math.floor(new Date().getTimezoneOffset())) : buildPlayerRequest(c, videoId, mode === 'vdata' ? y.summary.visitorData : '', auth);
        const res = await fetchJsonTimeout(req.url, req.init, 15000);
        entry.status = res.status;
        dlog('yt-api', `${c.key} (${mode}) answered ${res.status}`);
        if (!res.ok) continue;
        const p = parsePlayerResponse(await res.json(), c.name);
        entry.playability = p.status;
        entry.reason = p.reason;
        entry.formats = p.formats.length;
        entry.withN = p.formats.filter((f) => f.n).length;
        entry.hls = !!p.hlsUrl;
        entry.params = p.formats.length ? urlParamNames(p.formats[0].url) : [];
        dlog('yt-api', `${c.key} (${mode}) playability ${p.status}`, { formats: p.formats.length, withN: entry.withN, hls: entry.hls, reason: p.reason || '' });
        if (p.status !== 'OK') continue;
        if (p.captions?.tracks.length && !api.captions) api.captions = p.captions;
        if (p.hlsUrl && !api.hlsUrl) { api.hlsUrl = p.hlsUrl; api.hlsUa = c.ua; api.hlsClient = c.key; }
        if (p.formats.some((f) => f.mime.startsWith('video/'))) {
          const pack = { formats: p.formats, client: c.key, ua: c.ua, mode, limitBytes: Infinity };
          if (c.name === 'IOS') { iosFallback = iosFallback || pack; continue; }
          Object.assign(api, pack);
          break outer;
        }
      } catch (e) {
        entry.error = String(e?.name || 'error');
        dlog('yt-api', `${c.key} (${mode}) error`, { error: entry.error });
      }
    }
  }
  if (!api.formats.length && iosFallback && !api.hlsUrl) Object.assign(api, iosFallback, { iosOnly: true });
  api.done = true;
  dlog('yt-api', 'background method finished', { client: api.client || '', formats: api.formats.length, hls: !!api.hlsUrl, ios: !!api.iosOnly });
  if (!api.formats.length && api.hlsUrl) {
    ytHdr.ua = api.hlsUa;
    addItem(tabId, {
      kind: 'hls', url: api.hlsUrl, title: y.summary.title || undefined, thumbnail: y.summary.thumbnail, duration: y.summary.lengthSeconds,
      source: 'youtube-api', ua: api.hlsUa,
    });
  }
  if (tabs.get(tabId)?.yt === y) refreshYoutube(tabId);
}

// Method 1 = request from the background, method 2 = request from inside the YouTube page.
// ytMethod: 'auto' = page first, background as the reserve; 'page' = only page; 'background' = only background.
async function startYtApi(tabId, videoId) {
  const y = tabs.get(tabId)?.yt;
  if (!y?.summary || y.summary.videoId !== videoId || !y.api) return;
  const method = ['auto', 'page', 'background'].includes(settings.ytMethod) ? settings.ytMethod : 'auto';
  if (method === 'background') return fetchYtApi(tabId, videoId);
  let r = { ok: false };
  try { r = await fetchYtApiFromPage(tabId, { auto: true }); } catch { /* fall through */ }
  if (r.ok || tabs.get(tabId)?.yt !== y || y.summary.videoId !== videoId) return;
  if (method === 'auto') { y.api.fellBack = true; return fetchYtApi(tabId, videoId); }
  y.api.done = true;
  refreshYoutube(tabId);
}

// ---- Method 2 (1.4.5debug): the /player request is made from inside the YouTube page ----------------
// The page script (injected/youtube_api.js) does sw.js_data + /player same-origin, as the page does
// youtubei.js. We only parse the answer and reuse the normal chunked download pipeline.
async function fetchYtApiFromPage(tabId, opts = {}) {
  await ready;
  const y = tabs.get(tabId)?.yt;
  if (!y?.summary) return { ok: false, error: 'no_video' };
  const videoId = y.summary.videoId;
  const clients = resolveClients(settings.ytClients, settings.ytClientOverrides);
  const api = { videoId, formats: [], hlsUrl: '', client: '', ua: '', done: false, log: [], mode: 'page', session: '', page: true };
  y.apiPage = api;
  let res;
  try {
    res = await browser.tabs.sendMessage(tabId, { type: 'yt_page_api', videoId, clients }, { frameId: 0 });
  } catch (e) {
    api.session = `err:${String(e?.name || 'noscript')}`;
    api.done = true;
    dlog('yt-api', 'page method: no answer from the page script', { error: api.session });
    return { ok: false, error: 'no_page' };
  }
  if (tabs.get(tabId)?.yt !== y || y.summary.videoId !== videoId) return { ok: false, error: 'changed' };
  api.session = res?.session || '';
  let iosFallback = null;
  for (const r of res?.results || []) {
    const c = clients.find((k) => k.key === r.client);
    const entry = { client: r.client, version: c?.version || '', mode: 'page', status: r.status || 0, playability: '', reason: '', formats: 0, withN: 0, hls: false, error: r.error || '', params: [] };
    api.log.push(entry);
    if (!r.json || !c) continue;
    const p = parsePlayerResponse(r.json, c.name);
    entry.playability = p.status;
    entry.reason = p.reason;
    entry.formats = p.formats.length;
    entry.withN = p.formats.filter((f) => f.n).length;
    entry.hls = !!p.hlsUrl;
    entry.params = p.formats.length ? urlParamNames(p.formats[0].url) : [];
    dlog('yt-api', `page method: ${c.key} status ${entry.status}, playability ${p.status}`, { formats: p.formats.length, withN: entry.withN, hls: entry.hls, reason: p.reason || '' });
    if (p.status !== 'OK') continue;
    if (p.captions?.tracks.length && !api.captions) api.captions = p.captions;
    if (p.hlsUrl && !api.hlsUrl) { api.hlsUrl = p.hlsUrl; api.hlsUa = c.ua; api.hlsClient = c.key; }
    if (p.formats.some((f) => f.mime.startsWith('video/'))) {
      const pack = { formats: p.formats, client: c.key, ua: c.ua, mode: 'page', limitBytes: Infinity };
      if (c.name === 'IOS') { iosFallback = iosFallback || pack; continue; }
      Object.assign(api, pack);
      break;
    }
  }
  if (!api.formats.length && iosFallback && !api.hlsUrl) Object.assign(api, iosFallback, { iosOnly: true });
  api.done = true;
  dlog('yt-api', 'page method finished', { session: api.session, client: api.client || '', formats: api.formats.length, hls: !!api.hlsUrl, ios: !!api.iosOnly, tried: (res?.results || []).length });
  if (!api.formats.length && !api.hlsUrl) return { ok: false, error: 'none', session: api.session };
  // Replace the background result so the popup/download use the page-made formats.
  api.fromAuto = !!opts.auto;
  y.api = api;
  if (!api.formats.length && api.hlsUrl) {
    ytHdr.ua = api.hlsUa;
    addItem(tabId, {
      kind: 'hls', url: api.hlsUrl, title: y.summary.title || undefined, thumbnail: y.summary.thumbnail, duration: y.summary.lengthSeconds,
      source: 'youtube-api', ua: api.hlsUa,
    });
  }
  refreshYoutube(tabId);
  return { ok: true, client: api.client, formats: api.formats.length };
}

// ---- Bug button (1.4.5debug3): run the download test, then save the diagnostics as a file ------------
async function notifyAlways(message) {
  try {
    await browser.notifications?.create({ type: 'basic', iconUrl: browser.runtime.getURL('icons/icon-128.png'), title: tr('appName'), message });
  } catch { /* ignore */ }
}

// Probes the first bytes of a URL: status + a few headers, never the body.
async function probeUrl(url, range = 'bytes=0-1023') {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(url, { headers: { Range: range }, credentials: 'include', signal: ctl.signal });
    clearTimeout(timer);
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    return probeInfo(res);
  } catch (e) { return { status: `net:${String(e?.name || 'error')}` }; }
}

// Diagnostics for any non-YouTube site: what was detected and whether the first bytes can be fetched.
async function buildSiteDiagnostics(tabId) {
  const t = tabs.get(tabId);
  const full = !!settings.diagFullUrls;
  const mask = (u) => maskUrl(u, full);
  const manifest = browser.runtime.getManifest ? browser.runtime.getManifest() : {};
  const items = t ? [...t.items.values()].filter((it) => it.kind !== 'yt') : [];
  const report = {
    extension: manifest.version_name || manifest.version, userAgent: globalThis.navigator?.userAgent || '', time: new Date().toISOString(),
    page: mask(t?.pageUrl || ''), fullUrls: full, titleLength: (t?.pageTitle || '').length,
    settings: { concurrency: settings.concurrency, maxStreamMB: settings.maxStreamMB, minSizeKB: settings.minSizeKB },
    instagramScan: t?.igScan || undefined,
    tiktok: t?.tiktok ? [...t.tiktok.entries()].map(([k, x]) => ({ key: `…${k.slice(-6)}`, id: x.id ? `…${x.id.slice(-4)}` : '', author: !!x.author, visible: x.visible, matched: items.some((it) => isTikTokFile(it) && ttKey(it.url) === k) })) : undefined,
    tiktokScan: t?.ttScan || undefined,
    items: [],
    jobs: [...jobs.values()].map((j) => ({ state: j.state, error: j.error || '', errorKey: j.errorKey || '', files: j.fileCount, done: j.done, total: j.total, ...(j.liveLog ? { live: j.liveLog } : {}) })),
    ...(t?.feed ? { feed: { videos: t.feed.length, withPoster: t.feed.filter((v) => v.poster).length, withSrc: t.feed.filter((v) => v.src).length, visible: t.feed.filter((v) => v.visible).length, playing: t.feed.filter((v) => v.playing).length } } : {}),
  };
  const shownSet = t ? new Set(shownItems(t)) : new Set();
  for (const it of items.slice(0, 8)) {
    const e = {
      shown: shownSet.has(it), kind: it.kind, url: mask(it.url), size: it.size || 0, mime: it.mime || '', ext: it.ext || '', source: it.source || '', status: it.status,
      error: it.error || '', duration: it.duration || 0, live: !!it.live, protected: !!it.protected,
    };
    try {
      if (it.kind === 'file') {
        e.probe = await probeUrl(it.url);
      } else if (it.kind === 'hls') {
        e.master = !!it.master;
        if (it.synthetic) e.synthetic = true;
        if (it.stems) e.feedMatch = !!feedVideo(t, it);
        if (it.track) e.track = { ...it.track, bandwidth: it.bandwidth || 0 };
        e.variants = (it.variants || []).slice(0, 12).map((v) => ({ label: v.label, bandwidth: v.bandwidth, height: v.height, separateAudio: !!v.audioUrl, url: mask(v.url) }));
        const target = it.master ? it.variants?.[0]?.url : it.url;
        if (target && it.live) {
          // live: a short real recording (a few seconds) shows whether segments can be fetched and in what format
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 25000);
          try {
            const r = await recordLive(target, { signal: ctl.signal, maxSeconds: 6, concurrency: 2, maxBytes: 64 * 1024 * 1024 });
            e.liveTest = { reason: r.reason, seconds: Math.round(r.seconds), segments: r.segments, missed: r.missed, bytes: r.bytes, ext: r.ext, lastError: r.lastError };
          } catch (err) { e.liveTest = { error: String(err?.code || err?.message || err).slice(0, 80) }; } finally { clearTimeout(timer); }
        } else if (target) {
          const { parts, ext } = await hlsParts(target, {});
          e.segments = parts.length; e.segmentExt = ext;
          if (parts[0]) e.firstSegment = { url: mask(parts[0].url), ...(await probeUrl(parts[0].url)) };
          // Separate audio: describe both initialization segments (tracks, timescales, edit lists) - what the merge works from.
          const aurl = it.master ? it.variants?.[0]?.audioUrl : '';
          if (aurl && ext === 'mp4') {
            const ap = await hlsParts(aurl, {});
            e.audioSegments = ap.parts.length;
            const initOf = async (ps) => {
              const r = await fetch(ps[0].url, { credentials: 'include', headers: ps[0].range ? { Range: `bytes=${ps[0].range.start}-${ps[0].range.end}` } : {} });
              return describeInit(new Uint8Array(await r.arrayBuffer()));
            };
            try { e.videoInit = await initOf(parts); } catch (err) { e.videoInit = { error: String(err?.message || err).slice(0, 60) }; }
            try { e.audioInit = await initOf(ap.parts); } catch (err) { e.audioInit = { error: String(err?.message || err).slice(0, 60) }; }
          }
        }
      } else if (it.kind === 'dash') {
        const mpd = parseMPD(await fetchText(it.url), it.url);
        e.live = mpd.live; e.protected = mpd.protected;
        e.videos = mpd.videos.length; e.audios = mpd.audios.length;
        e.reps = [...mpd.videos.slice(0, 6), ...mpd.audios.slice(0, 3)].map((r) => ({ label: r.label, mime: r.mime, codecs: r.codecs, bandwidth: r.bandwidth, segments: r.segments.length, init: !!r.initUrl }));
        const v = mpd.videos[0] || mpd.audios[0];
        if (v) {
          const p = dashParts(v);
          if (p.parts[0]) e.firstVideoPart = { url: mask(p.parts[0].url), ...(await probeUrl(p.parts[0].url, p.parts[0].range ? `bytes=${p.parts[0].range}` : 'bytes=0-1023')) };
        }
        if (mpd.videos.length && mpd.audios[0]) {
          const p = dashParts(mpd.audios[0]);
          if (p.parts[0]) e.firstAudioPart = { url: mask(p.parts[0].url), ...(await probeUrl(p.parts[0].url, p.parts[0].range ? `bytes=${p.parts[0].range}` : 'bytes=0-1023')) };
        }
      }
    } catch (err) { e.testError = String(err?.code || err?.message || err).slice(0, 120); }
    report.items.push(e);
  }
  return JSON.stringify(report, null, 2);
}

// The page a diagnostics result belongs to: the address without #fragment and the playback position (t=, start=).
export function bugPageKey(url) {
  try {
    const u = new URL(url || '');
    u.hash = '';
    for (const k of ['t', 'start', 'pp', 'si']) u.searchParams.delete(k);
    return u.href;
  } catch { return String(url || ''); }
}

async function runBugReport(tabId) {
  await ready;
  const t = tabs.get(tabId);
  const y = t?.yt;
  const isYt = !!y?.summary;
  if (!t) return { ok: false, error: 'no_tab' };
  if (t.bug?.state === 'running') return { ok: false, error: 'running' };
  let host = isYt ? 'YouTube' : hostOf(t.pageUrl || [...t.items.values()][0]?.url || '') || 'site';
  dlog('bug', 'auto-diagnostics started', { site: host, youtube: isYt });
  const page = t.pageUrl || '';
  t.bug = { state: 'running', startedAt: Date.now(), file: '', site: host, yt: isYt, page };
  notifyUI(tabId);
  notifyAlways(tr('bugNotifStart'));
  try {
    let text;
    let name;
    if (isYt) {
      try { await runYtTest(tabId); } catch { /* the report is still useful */ }
      text = (await getYtDiagnostics(tabId)).text;
      name = y.summary.videoId;
    } else {
      text = await buildSiteDiagnostics(tabId);
      name = host.replace(/[^a-z0-9.-]/gi, '_').slice(0, 40);
    }
    // debug log on: the result of the diagnostics goes into the log as well
    if (logEnabled()) {
      dlog('test', `=== auto-diagnostics result (${isYt ? 'YouTube' : host}) ===`);
      for (const [g, m] of diagLines(text)) dlog(g, m);
      dlog('test', '=== end of auto-diagnostics result ===');
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const file = `vdl-diagnostics-${name}-${stamp}.json`;
    if (onAndroid()) await saveViaPage(tabId, new Blob([text], { type: 'application/json' }), file);
    else {
      const url = IS_CHROME ? await chromeBlobUrl(new Blob([text], { type: 'application/json' })) : URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      await browser.downloads.download({ url, filename: file, saveAs: false, conflictAction: 'uniquify' });
      setTimeout(() => (IS_CHROME ? chromeRevoke(url) : URL.revokeObjectURL(url)), 60000);
    }
    t.bug = { state: 'done', file, site: host, yt: isYt, page, startedAt: t.bug.startedAt, finishedAt: Date.now(), text, size: text.length };
    dlog('bug', 'auto-diagnostics saved', { file });
    notifyAlways(`${tr('bugNotifDone')} ${file}`);
    return { ok: true, file };
  } catch (e) {
    dlog('bug', 'auto-diagnostics FAILED', { error: String(e?.message || e) });
    t.bug = { state: 'error', file: '', site: host, yt: isYt, page, startedAt: t.bug?.startedAt, error: String(e?.message || e) };
    notifyAlways(tr('bugNotifError'));
    return { ok: false, error: 'failed' };
  } finally {
    notifyUI(tabId);
  }
}

// ---- YouTube download debugging (1.3.3debug) --------------------------------
// Parameter NAMES only (never values), so a report shows e.g. whether "pot" or "n" are present.
function describeUrl(tr) {
  try {
    const u = new URL(tr.url);
    const p = u.searchParams;
    const expire = Number(p.get('expire')) || 0;
    return {
      itag: tr.itag, role: tr.role, verified: !!tr.verified, len: tr.len || 0, host: /^rr\d+---/.test(u.hostname) ? 'rrN---sn-*' : 'other',
      params: [...p.keys()].sort(), c: p.get('c') || '', ratebypass: p.get('ratebypass') || '',
      expiresInSec: expire ? expire - Math.floor(Date.now() / 1000) : null,
    };
  } catch { return { itag: tr.itag, role: tr.role, bad: true }; }
}

// Tries, in order: range as query param, Range header, Range header + cookies. Remembers what worked.
function makeYtFetch(dlog) {
  let preferred = 0;
  let n = 0;
  const cpn = settings.ytCpn ? makeCpn() : '';
  return async (url, init = {}) => {
    const part = n++;
    const u = new URL(cpn ? withCpn(url, cpn) : url);
    const rng = u.searchParams.get('range');
    const strategies = [{ name: 'query-range', url: u.href, init: { ...init, credentials: 'omit' } }];
    if (rng) {
      const h = new URL(u.href);
      h.searchParams.delete('range');
      const headers = { ...(init.headers || {}), Range: `bytes=${rng}` };
      strategies.push({ name: 'header-range', url: h.href, init: { ...init, headers, credentials: 'omit' } });
      strategies.push({ name: 'header-range+cookies', url: h.href, init: { ...init, headers, credentials: 'include' } });
    }
    const order = strategies.map((_, i) => (i + preferred) % strategies.length);
    let last = null;
    const statuses = [];
    for (const i of order) {
      const s = strategies[i];
      let status;
      let res = null;
      try {
        res = await fetch(s.url, s.init);
        status = res.status;
      } catch (e) {
        if (init.signal?.aborted || e.name === 'AbortError') throw e;
        status = `net:${String(e.name || 'error')}`;
      }
      if (dlog.attempts.length < 40) dlog.attempts.push({ part, strategy: s.name, status, ct: res?.headers?.get?.('content-type') || '', len: res?.headers?.get?.('content-length') || '' });
      statuses.push(`${s.name}:${status}`);
      if (res && res.ok) { preferred = i; return res; }
      last = status;
    }
    const err = new StreamError('http', `HTTP ${last} (part ${part}; ${statuses.join(', ')})`);
    err.status = typeof last === 'number' ? last : 0;
    throw err;
  };
}

async function startDownload({ tabId, itemId, variant, variantLabel, audio, subs }) {
  await ready;
  if (!isAccepted(consent)) { notifyAlways(tr('consentNeeded')); return { ok: false, error: 'consent' }; }
  const it = tabs.get(tabId)?.items.get(itemId);
  if (!it) return { ok: false, error: 'not_found' };
  if (it.protected) return { ok: false, error: 'drm' };
  if (it.live && it.kind !== 'hls') return { ok: false, error: 'live' };
  if (it.noteKey) return { ok: false, error: it.noteKey };
  const title = displayTitle(tabId, it);
  dlog('download', `start ${it.kind}`, { tab: tabId, variant: variant ?? null, label: variantLabel || '', audio: audio ? (audio.type || true) : false, url: it.url });

  if (it.jr) jrRef(tabId, it.url); // the Referer rule again (it may have been lost while the background slept)
  const offer = it.kind === 'file' ? fileOffer(tabId, it) : null;
  const fv = offer ? offer[variant ?? 0] || offer[0] : null;
  // Chrome: the browser's own download (downloads.download) gets no header rules, so a file whose server wants the
  // page as Referer is fetched by the extension instead (the rules apply there) and saved from memory (1.6.4)
  const chromeRef = IS_CHROME && it.kind === 'file' && !!ytHdr.ref(refDomain(fv?.url || it.url));
  if (it.kind === 'file' && !isTikTokFile(it) && !it.referer && !fv?.makeGif && !chromeRef) {
    const fileUrl = fv?.url || it.url;
    const filename = buildFilename(settings.template, {
      title, site: it.site || hostOf(tabs.get(tabId)?.pageUrl || '') || hostOf(fileUrl), quality: it.jr ? '' : it.quality, ext: fv?.ext || pickExt(it),
    });
    const record = { title, url: fileUrl, kind: 'file', filename };
    if (onAndroid()) {
      // no downloads API on the phone: fetch the file here and hand it to the page
      try {
        const res = await fetch(fileUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await saveViaPage(tabId, await res.blob(), filename);
        if (settings.history) await addHistory(record);
        return { ok: true };
      } catch (e) {
        dlog('download', 'direct download failed (Android)', { error: String(e.message || e) });
        return { ok: false, error: String(e.message || e) };
      }
    }
    try {
      const id = await browser.downloads.download({ url: fileUrl, filename, saveAs: settings.saveAs, conflictAction: 'uniquify' });
      track(id, { record, direct: true });
      return { ok: true };
    } catch (e) {
      dlog('download', 'direct download refused', { error: String(e.message || e) });
      return { ok: false, error: String(e.message || e) };
    }
  }

  let tsOut = tsFormat();
  if (it.kind === 'hls') {
    const plan = hlsVariantPlan(it);
    const pick = plan && plan[variant ?? 0];
    if (pick) { variant = pick.src; if (pick.out) tsOut = pick.out; }
  }
  // Subtitles go with the video only when they are on and "+ with the video" is ticked. The popup sends its choice;
  // a hotkey sends nothing, then the default track is taken.
  let subsChoice = '';
  if (it.kind === 'yt' && !audio && settings.subs !== false && settings.subsWithVideo) {
    if (typeof subs === 'string') subsChoice = subs;
    else subsChoice = defaultSubs(subsChoices(ytSubsList(tabs.get(tabId)?.yt), uiLangCode()), uiLangCode())?.id || '';
  }
  runStreamJob(tabId, it, title, variant, variantLabel, audio, tsOut, subsChoice);
  return { ok: true };
}

function startKeepAlive() {
  if (!keepAlive) keepAlive = setInterval(() => browser.runtime.getPlatformInfo().catch(() => {}), 20000);
}
function stopKeepAliveIfIdle() {
  if (keepAlive && ![...jobs.values()].some((j) => j.state === 'running')) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
}

// Registers a download for completion tracking. Also checks the current state,
// because a tiny file can finish before the listener entry exists.
async function track(id, entry) {
  tracked.set(id, entry);
  try {
    const [d] = await browser.downloads.search({ id });
    if (d && (d.state === 'complete' || d.state === 'interrupted')) handleDownloadEnd(id, d.state);
  } catch { /* ignore */ }
}

// The end of a browser download comes from downloads.onChanged; the state is also asked every 2 s, because the
// event can be missed (Firefox for Android). A download that is not even "in progress" for 2 minutes is reported.
function waitForBrowserDownload(downloadId, blobUrl) {
  return new Promise((resolve) => {
    track(downloadId, { resolve, blobUrl });
    const started = Date.now();
    let last = '';
    const poll = setInterval(async () => {
      if (!tracked.has(downloadId)) { clearInterval(poll); return; }
      let d = null;
      try { [d] = await browser.downloads.search({ id: downloadId }); } catch (e) { d = { state: `search failed: ${String(e?.message || e).slice(0, 60)}` }; }
      const state = d ? String(d.state || '') : 'not found';
      if (state !== last) { last = state; dlog('download', `browser download #${downloadId}: ${state}`, { bytes: d?.bytesReceived ?? null, error: d?.error || '' }); }
      if (state === 'complete' || state === 'interrupted') { clearInterval(poll); handleDownloadEnd(downloadId, state); return; }
      if (state !== 'in_progress' && Date.now() - started > 120000) { clearInterval(poll); handleDownloadEnd(downloadId, 'interrupted'); }
    }, 2000);
  });
}

// Firefox for Android: the downloads API is not connected to the browser's download manager (Mozilla bug 1793214),
// downloads.download() never answers. The file is handed to the page of the video instead: its content script
// saves it with an <a download> link, which the phone's download manager takes like any page download.
const onAndroid = () => !IS_CHROME && isAndroid(globalThis.navigator?.userAgent || '');
async function saveViaPage(tabId, blob, filename) {
  const name = String(filename).split(/[\\/]/).pop();
  dlog('download', 'handing the file to the page (Android)', { bytes: blob.size, type: blob.type, tab: tabId ?? null });
  let r = null;
  try { r = await browser.tabs.sendMessage(tabId, { type: 'vdl_save', blob, name }, { frameId: 0 }); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
  if (!r || !r.ok) {
    dlog('download', 'the page did not save the file', { error: r?.error || 'no answer' });
    throw new StreamError('http', `The page did not save the file (keep the tab of the video open): ${String(r?.error || 'no answer').slice(0, 100)}`);
  }
  dlog('download', r.waiting ? 'the page will save the file when it is on screen again' : 'saved through the page');
  if (r.waiting) notifyAlways(tr('androidSaveOnPage'));
  return 'complete';
}

async function saveBlob(blob, filename, saveAs, onId, tabId) {
  if (onAndroid()) return saveViaPage(tabId, blob, filename);
  const blobUrl = IS_CHROME ? await chromeBlobUrl(blob) : URL.createObjectURL(blob);
  dlog('download', 'handing the file to the browser', { bytes: blob.size, type: blob.type, name: filename.length });
  let id;
  try {
    // the browser must at least accept the download; on some systems (Firefox for Android) the call can hang
    id = await Promise.race([
      browser.downloads.download({ url: blobUrl, filename, saveAs, conflictAction: 'uniquify' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('downloads.download did not answer in 60 s')), 60000)),
    ]);
  } catch (e) {
    dlog('download', 'the browser refused the file', { error: String(e?.message || e) });
    throw new StreamError('http', `The browser did not save the file: ${String(e?.message || e).slice(0, 120)}`);
  }
  dlog('download', `browser download #${id} started`);
  if (onId) onId(id);
  return waitForBrowserDownload(id, blobUrl); // resolves with 'complete' | 'interrupted'
}

// Decode the downloaded audio with the browser and encode it as MP3 (progress goes to the job bar).
async function toMp3(blob, title, job, tabId, kbps) {
  if (IS_CHROME) return toMp3Chrome(blob, title, job, tabId, kbps);
  const lame = await loadLame();
  if (!lame) throw new StreamError('mp3Missing', 'MP3 encoder (vendor/lame.js) is not installed');
  job.fileIndex = 1;
  job.done = 0;
  job.total = 100;
  job.phase = 'mp3';
  notifyUI(tabId);
  let pcm;
  try { pcm = await decodeToPcm(await blob.arrayBuffer()); } catch { throw new StreamError('mp3Decode', 'The browser could not decode this audio'); }
  if (pcm.seconds > MP3_MAX_SECONDS) throw new StreamError('mp3TooLong', 'Audio is too long for in-browser MP3 conversion');
  const parts = await encodeMp3(pcm, {
    kbps: mp3Bitrate(kbps), lame, title, signal: job.abort.signal,
    onProgress: (p) => { job.done = Math.round(p * 100); notifyUI(tabId); },
  });
  return new Blob(parts, { type: 'audio/mpeg' });
}

async function toMp3Chrome(blob, title, job, tabId, kbps) {
  job.fileIndex = 1;
  job.done = 0;
  job.total = 100;
  job.phase = 'mp3';
  notifyUI(tabId);
  try {
    return await chromeMp3(blob, {
      kbps: mp3Bitrate(kbps), title, signal: job.abort.signal,
      onProgress: (p) => { job.done = Math.round(p * 100); notifyUI(tabId); },
    });
  } catch (e) {
    if (['mp3Missing', 'mp3Decode', 'mp3TooLong'].includes(e?.code)) throw new StreamError(e.code, e.message);
    throw e;
  }
}

async function runStreamJob(tabId, it, title, variantIdx, variantLabel, audioOpt = null, tsOut = tsFormat(), subsChoice = '') {
  if (!TS_FORMATS.includes(tsOut)) tsOut = tsFormat();
  const toMp4 = tsOut !== 'ts'; // TS is rewritten (MP4 or MKV) without re-encoding
  const job = {
    id: String(++jobSeq), itemId: it.id, title, state: 'running', fileIndex: 1, fileCount: 1, done: 0, total: 0, downloadIds: [],
    abort: new AbortController(),
  };
  jobs.set(job.id, job);
  job.startedAt = Date.now();
  job.rate = makeRate();
  dlog('job', `#${job.id} running`, { kind: it.kind, label: variantLabel || '', ts: tsOut });
  startKeepAlive();
  notifyUI(tabId);

  const dlOpts = {
    concurrency: it.kind === 'yt' && settings.ytSequential ? 1 : settings.concurrency,
    signal: job.abort.signal,
    maxBytes: settings.maxStreamMB * 1024 * 1024,
    credentials: it.kind === 'yt' ? 'omit' : 'include', // googlevideo URLs are self-authenticating
    onProgress: ({ done, total, bytes }) => {
      job.done = done;
      job.total = total;
      job.rate.add(bytes || 0, done);
      job.speed = job.rate.speed();
      job.eta = job.rate.eta(total);
      notifyUI(tabId);
    },
  };

  // a server that refused the extension and answered only to the page: the page fetches the pieces (1.6.4)
  if (it.via === 'page' && it.kind !== 'yt') dlOpts.fetchFn = pageFetchFn(tabId);
  // download the pieces; refused (403 / 412): again with the page's Referer / Origin, then through the page
  const getParts = async (parts) => {
    try {
      return await downloadParts(parts, dlOpts);
    } catch (e) {
      const status = refusedStatus(e);
      const page = tabs.get(tabId)?.pageUrl || it.docUrl || it.referer || '';
      if (!status || !page || it.kind === 'yt' || !parts[0]) throw e;
      const dom = refDomain(parts[0].url);
      if (!ytHdr.ref(dom) && dlOpts.fetchFn === undefined) {
        ytHdr.setRef(dom, page);
        dlog('job', `HTTP ${status}: pieces again with the page's Referer / Origin`, { host: hostOf(parts[0].url) });
        try { const out = await downloadParts(parts, dlOpts); it.via = 'ref'; return out; } catch (e2) { if (!refusedStatus(e2)) throw e2; }
      }
      if (it.via === 'page') throw e;
      dlog('job', `HTTP ${status}: pieces through the page`, { host: hostOf(parts[0].url) });
      dlOpts.fetchFn = pageFetchFn(tabId);
      const out = await downloadParts(parts, dlOpts);
      it.via = 'page';
      return out;
    }
  };

  try {
    if (it.ua) ytHdr.ua = it.ua;
    const site = it.site || hostOf(tabs.get(tabId)?.pageUrl || '') || hostOf(it.url); // the page's site, not the media server
    const files = []; // { parts, ext, type, suffix, quality }

    if (it.kind === 'hls') {
      let tracks = [{ url: it.url, suffix: '', quality: '' }];
      if (it.master) {
        const v = it.variants[variantIdx ?? 0] || it.variants[0];
        let url = v.url;
        let audioUrl = v.audioUrl || '';
        if (v.nested) {
          // a quality from the site's page data is a master playlist of its own: take its (best) stream
          const pl = parsePlaylist(await fetchTextFor(tabId, it, v.url, { signal: job.abort.signal }), v.url);
          if (pl.type === 'master' && pl.variants.length) {
            const best = pl.variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
            url = best.url;
            audioUrl = best.audio?.url || '';
          }
        }
        tracks = [{ url, suffix: '', quality: v.label }];
        if (audioUrl) tracks.push({ url: audioUrl, suffix: '.audio', quality: v.label });
      }
      if (it.live) {
        // LIVE: record every track until Stop / end of the stream / a limit; video and audio run side by side.
        job.recording = true;
        job.stopCtl = new AbortController();
        let liveCred = 'include';
        let liveStrategy = '';
        if (it.source === 'youtube-live') {
          // Which request style does the server accept for this stream's segments? (plain extension request first)
          liveStrategy = await pickLiveStrategy(tracks[0].url, job.abort.signal);
          if (!liveStrategy) {
            // the extension's own requests are refused: try the same fetch from inside the YouTube page (youtube.com origin)
            let pageTest = null;
            try { pageTest = await browser.tabs.sendMessage(tabId, { type: 'yt_live_test', url: tracks[0].url }, { frameId: 0 }); } catch { /* no page script */ }
            const steps = (pageTest && pageTest.steps) || ['no-page-script'];
            job.liveLog = [{ strategy: 'none', pageTest: steps }];
            throw new StreamError('empty', `Segments are refused for requests of the extension (all styles); page test: ${steps.join(' ')}`);
          }
          liveCred = liveStrategy.startsWith('plain-include') ? 'include' : 'omit';
        }
        const agg = tracks.map(() => ({ seconds: 0, bytes: 0, segments: 0 }));
        const maxBytes = (settings.maxStreamMB * 1024 * 1024) / tracks.length;
        const recs = await Promise.all(tracks.map((tr, i) => recordLive(tr.url, {
          signal: job.abort.signal, stopSignal: job.stopCtl.signal, maxBytes, credentials: liveCred, ...(it.via === 'page' ? { fetchFn: pageFetchFn(tabId) } : {}),
          maxSeconds: Math.max(1, Number(settings.liveMaxMinutes) || 180) * 60, concurrency: settings.concurrency,
          onProgress: (p) => {
            agg[i] = p;
            job.seconds = Math.max(...agg.map((a) => a.seconds));
            job.bytes = agg.reduce((n, a) => n + a.bytes, 0);
            job.segments = Math.max(...agg.map((a) => a.segments));
            notifyUI(tabId);
          },
        })));
        job.recording = false;
        ytHdr.live = false;
        job.liveLog = recs.map((r) => ({ strategy: liveStrategy, reason: r.reason, seconds: Math.round(r.seconds), segments: r.segments, missed: r.missed, gaps: r.gaps, bytes: r.bytes, lastError: r.lastError, polls: r.polls, plSegs: r.plSegs }));
        for (const [i, r] of recs.entries()) {
          if (r.blobs.length || !/403|410/.test(r.lastError) || !r.sample) continue;
          // find out which way the server accepts the segment (statuses only, no URLs are stored)
          const probe = [];
          for (const [name, init, hdr] of [['plain-include', { credentials: 'include' }, false], ['plain-omit', { credentials: 'omit' }, false], ['hdr-omit', { credentials: 'omit' }, true], ['hdr-range', { credentials: 'omit', headers: { Range: 'bytes=0-1023' } }, true]]) {
            ytHdr.live = hdr;
            try { const rr = await fetch(r.sample, init); probe.push(`${name}:${rr.status}`); rr.body?.cancel?.().catch(() => {}); } catch (e) { probe.push(`${name}:${String(e?.name || 'err')}`); }
          }
          ytHdr.live = false;
          job.liveLog[i].probe = probe;
          r.lastError += ` [${probe.join(' ')}]`;
          job.liveLog[i].lastError = r.lastError;
        }
        for (const r of recs) { if (tracks.length === 1 && r.blobs.length && !(toMp4 && r.ext === 'ts')) r.blobs = await rebaseTimestamps(r.blobs, r.ext); } // the file starts at 0:00 (not at the stream's clock)
        recs.forEach((r, i) => {
          if (!r.blobs.length) throw new StreamError('empty', `Nothing was recorded (${recs[i].reason || 'no data'}${recs[i].lastError ? ': ' + recs[i].lastError : ''}; polls ${recs[i].polls}, in playlist ${recs[i].plSegs})`);
          const tr = tracks[i];
          files.push({ recorded: r.blobs, parts: [], ext: r.ext, type: r.ext === 'mp4' ? 'video/mp4' : 'video/mp2t', suffix: tr.suffix, quality: tr.quality || 'live', role: tr.suffix ? 'audio' : 'video', container: r.ext === 'mp4' ? 'mp4' : r.ext });
        });
      } else {
        for (const tr of tracks) {
          const { parts, ext } = await hlsParts(tr.url, { signal: job.abort.signal, ...(it.via === 'page' ? { fetchFn: pageFetchFn(tabId) } : {}) });
          files.push({ parts, ext, type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t', suffix: tr.suffix, quality: tr.quality, role: tr.suffix ? 'audio' : 'video', container: ext === 'mp4' ? 'mp4' : ext });
        }
      }
    } else if (it.kind === 'file') {
      // TikTok video file, or a file whose server wants the page as Referer: fetched here (header rules above), saved as an mp4;
      // a file offered in several qualities: the chosen one
      const fv = (fileOffer(tabId, it) || [])[variantIdx ?? 0] || null;
      // size known from the server's Content-Range: pieces of 4 MB in parallel (progress, and faster where each connection is limited)
      const fileParts = fv?.size > 8 * 1048576
        ? Array.from({ length: Math.ceil(fv.size / 4194304) }, (_, i) => ({ url: fv.url, range: { start: i * 4194304, end: Math.min(fv.size, (i + 1) * 4194304) - 1 } }))
        : [{ url: fv?.url || it.url }];
      const fext = fv?.makeGif ? fv.srcExt || mediaExt(fv.url) || 'webm' : fv?.ext || pickExt(it);
      files.push({ parts: fileParts, ext: fext === 'mp4' || !FILE_EXTS.includes(fext) ? 'mp4' : fext, type: fext === 'webm' ? 'video/webm' : 'video/mp4', suffix: '', quality: fv?.makeGif || it.jr ? '' : fv?.label || it.quality || '', role: 'video', container: 'mp4', tiktok: isTikTokFile(it), makeGif: fv?.makeGif || 0 });
    } else if (it.kind === 'yt') {
      const y = tabs.get(tabId)?.yt;
      const dlog = { time: new Date().toISOString(), variant: '', urlShape: [], attempts: [], result: '' };
      if (y) y.dlog = dlog;
      dlOpts.fetchFn = makeYtFetch(dlog);
      const variants = variantsFor(y);
      const v = variants.find((x) => x.label === variantLabel) || variants[variantIdx ?? 0] || variants[0];
      if (!v) throw new StreamError('empty', 'No downloadable YouTube formats');
      dlog.variant = v.label;
      ytHdr.on = !!settings.ytHeaders;
      dlog.flags = { sequential: !!settings.ytSequential, cpn: !!settings.ytCpn, headers: !!settings.ytHeaders, apiMode: y?.api?.mode || '' };
      ytHdr.ua = v.tracks.some((tr) => tr.client) ? (y?.api?.ua || '') : '';
      dlog.urlShape = v.tracks.map((tr) => describeUrl(tr));
      for (const tr of v.tracks) {
        files.push({
          parts: rangedParts(tr), ext: trackExt(tr.mime), type: tr.mime,
          suffix: v.tracks.length > 1 && tr.role === 'audio' ? '.audio' : '', quality: v.label.split(' · ')[0],
          role: tr.role, container: tr.mime.endsWith('/webm') ? 'webm' : 'mp4', mp3: !!v.mp3, kbps: v.kbps || 0,
        });
      }
    } else {
      const mpd = parseMPD(await fetchText(it.url, { signal: job.abort.signal }), it.url);
      if (mpd.protected) throw new StreamError('drm');
      if (mpd.live) throw new StreamError('live');
      const reps = mpd.videos.length ? mpd.videos : mpd.audios;
      const vrep = reps[variantIdx ?? 0] || reps[0];
      if (audioOpt && mpd.audios.length) {
        // audio only: one track, original container or converted to MP3
        const arep = mpd.audios[audioOpt.rep] || mpd.audios[0];
        files.push({ ...dashParts(arep), type: arep.mime, suffix: '', quality: 'audio', mp3: !!audioOpt.mp3, kbps: Number(audioOpt.kbps) || 0 });
      } else {
      const v = dashParts(vrep);
      const cont = (r) => (/webm/.test(r.mime) ? 'webm' : 'mp4');
      files.push({ ...v, type: vrep.mime, suffix: '', quality: vrep.label, role: mpd.videos.length ? 'video' : 'audio', container: cont(vrep) });
      if (mpd.videos.length && mpd.audios.length) {
        // best audio track, so the video always comes WITH sound
        const arep = mpd.audios.slice().sort((x, y) => (y.bandwidth || 0) - (x.bandwidth || 0))[0];
        const a = dashParts(arep);
        files.push({ ...a, type: arep.mime, suffix: '.audio', quality: vrep.label, role: 'audio', container: cont(arep) });
      }
      }
    }

    job.fileCount = files.length;
    const savedNames = [];
    // subtitles with the video (YouTube): embedded into a .webm, otherwise a .srt next to the video
    let subs = null;
    if (subsChoice) { try { subs = await fetchSubs(tabId, subsChoice); } catch (e) { dlog('subs', 'not fetched', { error: String(e?.message || e) }); notify(tr('subsFailed')); } }
    let subsEmbedded = false;
    const mergeGroup = files.length === 2 && files[0].role === 'video' && files[1].role === 'audio' && files[0].container === files[1].container;
    let heldVideo = null;
    const saveOne = async (blob, f, i, ext = f.ext, suffix = f.suffix) => {
      const filename = buildFilename(settings.template, { title, site, quality: f.quality, ext, suffix });
      const result = await saveBlob(blob, filename, settings.saveAs && savedNames.length === 0 && i === 0, (id) => job.downloadIds.push(id), tabId);
      if (result !== 'complete') throw new StreamError('http', 'Browser download was interrupted');
      savedNames.push(filename);
    };
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      job.fileIndex = i + 1;
      job.done = 0;
      job.total = f.recorded ? 1 : f.parts.length;
      if (f.recorded) job.done = 1;
      job.rate.reset();
      job.speed = 0;
      job.eta = 0;
      notifyUI(tabId);
      let blobs;
      if (f.recorded) blobs = f.recorded;
      else if (f.tiktok) {
        try { blobs = await downloadParts(f.parts, dlOpts); } catch (e) {
          if (!(e instanceof StreamError) || e.code !== 'http') throw e;
          // refused for the extension: ask the TikTok page itself (its cookies and Referer)
          let res = null;
          try { res = await browser.tabs.sendMessage(tabId, { type: 'tt_fetch', url: f.parts[0].url }, { frameId: 0 }); } catch { /* no page script */ }
          if (!res || !res.ok || !res.blob) throw e;
          blobs = [res.blob];
        }
      } else blobs = await getParts(f.parts);
      const blob = joinBlobs(blobs, f.type);
      if (mergeGroup && i === 0) { heldVideo = blob; continue; }
      if (mergeGroup && i === 1) {
        // Join video + audio into ONE file without re-encoding; fall back to two files.
        const merged = await globalThis.__vdlMux.mergeBlobs(heldVideo, blob, files[0].container, subs ? { subs: [subs] } : undefined);
        if (merged) {
          subsEmbedded = !!merged.vdlSubs;
          await saveOne(merged, files[0], 0, files[0].container, '');
        } else {
          await saveOne(heldVideo, files[0], 0);
          await saveOne(blob, f, 1);
          notify(tr('mergeFailedTwoFiles'));
        }
        heldVideo = null;
        continue;
      }
      if (f.makeGif) {
        // video -> GIF in the background page (no sound)
        job.phase = 'gif';
        job.done = 0;
        job.total = 100;
        notifyUI(tabId);
        let gif;
        try {
          const gifOpts = { maxWidth: f.makeGif, signal: job.abort.signal, onProgress: (x) => { job.done = Math.round(x * 100); notifyUI(tabId); } };
          gif = IS_CHROME ? await chromeGif(blob, gifOpts) : await videoToGif(blob, gifOpts);
        } catch (e) {
          if (e?.code === 'aborted') throw new StreamError('aborted');
          throw new StreamError(e?.code === 'gifTooLong' ? 'gifTooLong' : 'gifDecode', String(e?.message || e));
        }
        job.phase = '';
        dlog('job', 'GIF made from the video', { width: f.makeGif, bytes: gif.size, from: blob.size });
        await saveOne(gif, f, i, 'gif', '');
        continue;
      }
      if (f.mp3) {
        const out = await toMp3(blob, title, job, tabId, f.kbps);
        await saveOne(out, f, i, 'mp3', '');
        continue;
      }
      let outBlob = blob;
      let outExt = f.ext;
      if (it.kind === 'hls' && f.ext === 'ts' && toMp4 && !mergeGroup) {
        // MPEG-TS -> MP4 / MKV without re-encoding; when the stream is not convertible the TS file is saved as it is
        job.phase = tsOut === 'mkv' ? 'mkv' : 'convert';
        notifyUI(tabId);
        const conv = tsOut === 'mkv' ? await tsToMkv(blob, globalThis.__vdlMux) : await tsToMp4(blob);
        job.phase = '';
        if (conv) { outBlob = conv; outExt = tsOut; } else {
          dlog('job', 'TS kept as it is', { wanted: tsOut });
          if (f.recorded) outBlob = joinBlobs(await rebaseTimestamps([blob], 'ts'), f.type);
        }
      } else if ((it.kind === 'hls' || it.kind === 'dash') && f.ext === 'mp4' && !mergeGroup) {
        // fragmented MP4 pieces as they came (no index, bad seeking) -> an ordinary MP4 with the index first
        job.phase = 'convert';
        notifyUI(tabId);
        let flat = null;
        try { flat = await globalThis.__vdlMux.defragMp4(blob); } catch (e) { dlog('job', 'fragmented mp4 left as it is', { error: String(e?.message || e) }); }
        job.phase = '';
        if (flat) { outBlob = flat; dlog('job', 'fragmented mp4 written with an index', { bytes: flat.size }); }
      }
      await saveOne(outBlob, f, i, outExt);
    }
    if (subs && !subsEmbedded && savedNames.length) {
      const srtName = `${savedNames[0].replace(/\.[^./\\]+$/, '')}.${subs.lang}.srt`;
      await saveBlob(new Blob([cuesToSrt(subs.cues)], { type: 'text/plain' }), srtName, false, (id) => job.downloadIds.push(id), tabId);
      savedNames.push(srtName);
    }
    job.state = 'done';
    dlog('job', `#${job.id} done`, { files: savedNames.length, ms: Date.now() - job.startedAt });
    if (it.kind === 'yt') { const yy = tabs.get(tabId)?.yt; if (yy) { yy.dlFailed = false; yy.dlLimited = false; yy.dl429 = false; } }
    if (settings.history) await addHistory({ title, url: it.url, kind: it.kind, filename: savedNames.join(' + ') });
    notify(`${tr('done')}: ${title}`);
  } catch (e) {
    if (e instanceof StreamError && e.code === 'aborted') {
      job.state = 'canceled';
      dlog('job', `#${job.id} canceled`, { ms: Date.now() - job.startedAt });
    } else {
      job.state = 'error';
      if (it.kind === 'yt') { const yy = tabs.get(tabId)?.yt; if (yy) yy.dlFailed = true; }
      job.error = e instanceof StreamError ? (['http', 'empty'].includes(e.code) && e.message ? e.message : e.code) : String(e.message || e);
      const yl = tabs.get(tabId)?.yt?.dlog;
      if (yl && it.kind === 'yt') yl.result = job.error;
      if (e instanceof StreamError && ['mp3Missing', 'mp3Decode', 'mp3TooLong', 'gifTooLong', 'gifDecode'].includes(e.code)) job.errorKey = e.code;
      if (it.kind === 'yt' && e instanceof StreamError && e.code === 'http' && [403, 410].includes(e.status)) job.errorKey = e.limited ? 'ytLimited' : 'ytDirectBlocked';
      if (it.kind === 'yt' && e instanceof StreamError && e.code === 'http') { const yy = tabs.get(tabId)?.yt; if (yy) { if ([403, 410].includes(e.status)) yy.dlLimited = true; if (e.status === 429) yy.dl429 = true; } }
      dlog('job', `#${job.id} FAILED`, { error: job.error, key: job.errorKey || '', status: e?.status, code: e?.code, ms: Date.now() - job.startedAt });
      notify(`${tr('failed')}: ${title} (${job.error})`);
    }
  } finally {
    job.finishedAt = Date.now();
    stopKeepAliveIfIdle();
    if (it.kind === 'yt' && tabs.get(tabId)?.yt) refreshYoutube(tabId);
    notifyUI(tabId);
    setTimeout(() => { jobs.delete(job.id); notifyUI(tabId); }, 60000);
  }
}

async function handleDownloadEnd(id, state) {
  const t = tracked.get(id);
  if (!t) return;
  tracked.delete(id);
  dlog('download', `browser download ${state}`, { id });
  if (t.blobUrl) setTimeout(() => (IS_CHROME ? chromeRevoke(t.blobUrl) : URL.revokeObjectURL(t.blobUrl)), 5000);
  if (t.resolve) {
    t.resolve(state);
  } else if (t.direct) {
    if (state === 'complete') {
      if (settings.history) await addHistory(t.record);
      notify(`${tr('done')}: ${t.record.title}`);
    } else {
      notify(`${tr('failed')}: ${t.record.title}`);
    }
  }
}

browser.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') handleDownloadEnd(delta.id, state);
});

// ---------------------------------------------------------- page reports ----

function classifyPageUrl(url) {
  const ext = urlExt(url);
  if (ext === 'm3u8') return 'hls';
  if (ext === 'mpd') return 'dash';
  return 'file';
}

async function handlePageInfo(msg, sender) {
  await ready;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return;
  const t = getTab(tabId);
  if (msg.top) {
    if (Array.isArray(msg.feed)) {
      const ok = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u.slice(0, 1500) : '');
      t.feed = msg.feed.slice(0, 40).map((v) => ({ poster: ok(v?.poster), src: ok(v?.src), visible: !!v?.visible, playing: !!v?.playing }));
    }
    if (msg.title) t.pageTitle = msg.title;
    if (msg.url && msg.url !== t.pageUrl) t.pageChangedAt = Date.now();
    if (msg.url) t.pageUrl = msg.url;
    if (msg.thumbnail) t.thumbnail = msg.thumbnail;
  }
  for (const v of msg.videos || []) {
    if (!/^https?:/i.test(v.url)) continue;
    if (msg.url && String(v.url).split('#')[0] === String(msg.url).split('#')[0]) continue; // the page itself (empty <source src="">)
    if (SKIP_HOSTS.test(hostOf(v.url))) continue;
    addItem(tabId, {
      kind: classifyPageUrl(v.url), url: v.url, thumbnail: v.poster || '', duration: v.duration || 0,
      source: 'page', ext: urlExt(v.url) && FILE_EXTS.includes(urlExt(v.url)) ? urlExt(v.url) : '',
    });
  }
  for (const r of RESOLVERS) {
    if (!r.match(msg.url)) continue;
    const key = `${r.name}:${msg.url}`;
    if (t.resolved.has(key)) continue;
    t.resolved.add(key);
    if (r.needsRef) ytHdr.setRef(refDomain(msg.url), msg.url); // the site's own API wants the page as Referer
    r.resolve(msg.url).then((items) => items.forEach((x) => addItem(tabId, { ...x }))).catch(() => {});
  }
  updateBadge(tabId);
  notifyUI(tabId);
}

// Generic: a content script found a streaming address in the page data (Canva ...).
async function handlePageMedia(msg, sender) {
  await ready;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return;
  const t = getTab(tabId);
  if (msg.title) t.pageTitle = String(msg.title).slice(0, 200);
  if (msg.url) t.pageUrl = String(msg.url);
  for (const m of (msg.items || []).slice(0, 5)) {
    if (!m || !/^https:\/\//.test(m.url) || !['hls', 'dash', 'file'].includes(m.kind)) continue;
    addItem(tabId, { kind: m.kind, url: m.url, source: 'page', site: String(msg.site || '').slice(0, 40) || undefined });
  }
  updateBadge(tabId);
  notifyUI(tabId);
}

// ------------------------------------------------------------- Instagram ----
// The content script sends the DASH manifest text and the plain mp4 list found in the page data of the current post.
async function handleInstagram(msg, sender) {
  await ready;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return;
  const t = getTab(tabId);
  // Only the current post: drop what an earlier post of this tab (SPA navigation) produced.
  for (const [id, it] of t.items) if (it.source === 'instagram' && it.igPage !== msg.url) t.items.delete(id);
  t.pageUrl = msg.url;
  t.igScan = { at: new Date().toISOString(), manifests: (msg.manifests || []).length, versions: (msg.versions || []).length, ...(msg.scan || {}) };
  if (msg.title) t.pageTitle = String(msg.title).slice(0, 200);
  const base = { source: 'instagram', igAccount: String(msg.account || '').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 40), igPage: msg.url, site: msg.site === 'facebook.com' ? 'facebook.com' : 'instagram.com' };
  let found = false;
  for (const xml of (msg.manifests || []).slice(0, 1)) {
    if (typeof xml !== 'string' || xml.length > 2_000_000) continue;
    addItem(tabId, { ...base, kind: 'dash', url: `data:text/plain;charset=UTF-8,${encodeURIComponent(xml)}` });
    found = true;
  }
  if (!found) {
    // no DASH manifest: offer the plain mp4 files (best first)
    const seen = new Set();
    for (const v of (msg.versions || []).slice().sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 4)) {
      if (!/^https:\/\//.test(v.url) || seen.has(v.url)) continue;
      seen.add(v.url);
      addItem(tabId, { ...base, kind: 'file', url: v.url, ext: 'mp4', mime: 'video/mp4', quality: v.height ? `${v.height}p` : '' });
    }
  }
  updateBadge(tabId);
  notifyUI(tabId);
}

// --------------------------------------------------------------- YouTube ----

const LIVE_STRATEGIES = [
  ['plain-include', { credentials: 'include' }, false],
  ['plain-omit', { credentials: 'omit' }, false],
  ['hdr-omit', { credentials: 'omit' }, true],
  ['hdr-include', { credentials: 'include' }, true],
];

// Picks the first request style for which the first segment of the live playlist answers 2xx; leaves ytHdr.live set for it.
async function pickLiveStrategy(playlistUrl, signal) {
  let sample = '';
  try { sample = parsePlaylist(await (await fetch(playlistUrl, { signal })).text(), playlistUrl).segments?.[0]?.url || ''; } catch { /* use the default below */ }
  if (sample) {
    for (const [name, init, hdr] of LIVE_STRATEGIES) {
      ytHdr.live = hdr;
      try {
        const rr = await fetch(sample, { ...init, headers: { Range: 'bytes=0-1023' }, signal });
        rr.body?.cancel?.().catch(() => {});
        if (rr.ok) return name;
      } catch { /* try the next one */ }
    }
  }
  ytHdr.live = false;
  return '';
}

// ---- Subtitles (1.6.0dev5) -------------------------------------------------------------------------
// Tracks: from the API clients first (their timedtext addresses work without the player's token), else from the
// page's own player data. The player's own timedtext requests (seen below) are a last resort for the same language.
function ytSubsList(y) {
  const api = y?.api?.captions?.tracks?.length ? y.api.captions : (y?.apiPage?.captions?.tracks?.length ? y.apiPage.captions : null);
  return api || y?.summary?.captions || { tracks: [], translations: [] };
}

async function fetchSubs(tabId, choiceId) {
  const y = tabs.get(tabId)?.yt;
  if (!y?.summary) throw new Error('no video');
  const list = ytSubsList(y);
  const choice = subsChoices(list, uiLangCode()).find((c) => c.id === choiceId);
  if (!choice) throw new Error('no such subtitles');
  const track = list.tracks[choice.track];
  const urls = [subsUrl(track, choice.tlang)];
  for (const other of [y.summary.captions, y.api?.captions, y.apiPage?.captions]) {
    const same = other?.tracks?.find((x) => x.lang === track.lang && x.auto === track.auto);
    if (same) urls.push(subsUrl(same, choice.tlang));
  }
  const seen = y.subsSeen?.get(`${track.lang}:${track.auto ? 'asr' : ''}`);
  if (seen) urls.push(subsUrl({ url: seen }, choice.tlang));
  for (const url of [...new Set(urls)]) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) { dlog('subs', `timedtext ${r.status}`); continue; }
      const text = await r.text();
      if (!text.trim()) { dlog('subs', 'timedtext empty'); continue; }
      const cues = json3ToCues(JSON.parse(text));
      if (cues.length) return { lang: choice.lang, iso3: iso639b(choice.lang), name: choice.label, cues };
    } catch (e) { dlog('subs', 'timedtext failed', { error: String(e?.name || e) }); }
  }
  throw new Error('empty');
}

async function saveSubsOnly(tabId, itemId, choiceId) {
  await ready;
  if (!isAccepted(consent)) { notifyAlways(tr('consentNeeded')); return { ok: false, error: 'consent' }; }
  const it = tabs.get(tabId)?.items.get(itemId);
  if (!it || it.kind !== 'yt') return { ok: false, error: 'not_found' };
  if (settings.subs === false) return { ok: false, error: 'subsOff' };
  let subs;
  try { subs = await fetchSubs(tabId, choiceId); } catch { notify(tr('subsFailed')); return { ok: false, error: 'subsFailed' }; }
  const title = displayTitle(tabId, it);
  const filename = buildFilename(settings.template, { title, site: 'YouTube', ext: `${subs.lang}.srt` });
  const r = await saveBlob(new Blob([cuesToSrt(subs.cues)], { type: 'text/plain' }), filename, settings.saveAs, () => {}, tabId);
  if (r === 'complete' && settings.history) await addHistory({ title, url: it.url, kind: 'yt', filename });
  dlog('subs', 'saved', { lang: subs.lang, cues: subs.cues.length });
  return { ok: r === 'complete' };
}

// Why YouTube gave nothing (1.6.0dev5): see lib/ytverdict.js
function ytVerdict(y, noLinks) {
  if (!y?.summary) return { code: '', record: 'maybe', busy: false, reason: '' };
  const logs = [...(y.api?.log || []), ...(y.apiPage?.log || [])];
  const test = y.testLog?.results || [];
  return classifyYt({
    summary: y.summary, logs, session: y.api?.session || y.apiPage?.session || '',
    dlFailed: !!y.dlFailed, dlLimited: !!y.dlLimited, http429: !!y.dl429, iosOnly: !!y.api?.iosOnly,
    testCut: test.some((r) => r.firstFailMiB !== null && r.firstFailMiB > 0),
    apiDone: !y.api || !!y.api.done, noLinks,
  });
}

function refreshYoutube(tabId) {
  const t = tabs.get(tabId);
  const y = t?.yt;
  if (!y?.summary) return;
  const s = y.summary;
  for (const [id, other] of t.items) if (other.kind === 'yt' && other.videoId !== s.videoId) t.items.delete(id);

  const variants = variantsFor(y);
  const apiPending = !!y.api && !y.api.done;
  let noteKey = '';
  if (s.status && s.status !== 'OK') noteKey = 'ytUnavailable';
  else if (s.isLive) noteKey = ''; // live: recorded from the player (BETA), no direct links expected
  else if (settings.ytCcOnly && s.license !== 'cc') noteKey = 'ytCcBlocked';
  else if (!variants.length && !apiPending) noteKey = 'ytNone';
  const why = noteKey === 'ytUnavailable' || noteKey === 'ytNone' || y.dlFailed ? ytVerdict(y, !variants.length) : null;

  const id = `yt-${s.videoId}`;
  t.items.set(id, {
    id, kind: 'yt', videoId: s.videoId, url: `https://www.youtube.com/watch?v=${s.videoId}`, title: s.title || undefined,
    thumbnail: s.thumbnail, duration: s.lengthSeconds, variants, live: s.isLive && !noteKey.startsWith('yt'), beta: s.isLive && !noteKey.startsWith('yt'), noteKey,
    why: why?.code || '', whyReason: why?.code === 'unknown' ? why.reason : '', whyStart: why?.startAt || 0, whyRecord: why?.record || '', whyBusy: !!why?.busy,
    rec: y.rec || null, limitMB: y.api?.limitBytes && isFinite(y.api.limitBytes) && y.api.formats.length ? Math.round(y.api.limitBytes / MIB) : 0, status: !variants.length && apiPending ? 'parsing' : 'ready', apiState: variants.length ? 'ok' : apiPending ? 'loading' : 'failed', dlFailed: !!y.dlFailed, source: 'youtube', ts: t.items.get(id)?.ts || Date.now(),
  });
  updateBadge(tabId);
  scheduleSave();
  notifyUI(tabId);
}

async function handleYtPlayer(msg, sender) {
  await ready;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return;
  const s = validateSummary(msg.data);
  if (!s) return;
  // Home, search, feeds, channels: hover previews also emit player responses; do not query the API for them.
  if (!['watch', 'shorts', 'live', 'embed', 'clip'].includes(s.pageType)) return;
  const t = getTab(tabId);
  const prev = t.yt;
  if (prev?.summary && prev.summary.videoId === s.videoId) {
    prev.summary = s;
  } else {
    // New video. Keep streams captured before the summary arrived (the duration check filters strangers).
    const early = prev && !prev.summary ? prev : null;
    t.yt = { summary: s, captured: early ? early.captured : [], diag: early ? early.diag : newDiag(), rec: early?.rec, recNames: early?.recNames };
  }
  const yy = t.yt;
  if (settings.ytApi && !s.isLive && (!yy.api || yy.api.videoId !== s.videoId)) {
    dlog('yt', `video page (${s.pageType})`, { live: !!s.isLive, license: s.license || '', formats: (s.formats || []).length });
    yy.api = { videoId: s.videoId, formats: [], hlsUrl: '', client: '', ua: '', done: false, log: [] };
    startYtApi(tabId, s.videoId);
  }
  refreshYoutube(tabId);
}

function onGooglevideo(details) {
  if (details.tabId < 0) return;
  const parsed = parseGooglevideoUrl(details.url, details.method);
  if (!parsed) return;
  ready.then(() => {
    const t = getTab(details.tabId);
    t.yt ??= { summary: null, captured: [], diag: newDiag() };
    recordRequest(t.yt.diag, parsed, details.method);
    if (parsed.sabr || !parsed.kind || !parsed.itag) return;
    const entry = { ...parsed, ts: Date.now() };
    const i = t.yt.captured.findIndex((c) => c.itag === parsed.itag);
    if (i >= 0) {
      t.yt.captured[i] = entry; // fresher URL, same itag: no UI change needed
      return;
    }
    t.yt.captured.push(entry);
    if (t.yt.captured.length > 30) t.yt.captured.shift();
    refreshYoutube(details.tabId);
    scheduleSave();
  });
}

browser.webRequest.onBeforeRequest.addListener(
  onGooglevideo,
  { urls: ['*://*.googlevideo.com/videoplayback*'], types: ['media', 'xmlhttprequest', 'other'] },
);

// the player's own subtitle requests (they carry its token): remembered per language as a fallback
browser.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  const y = tabs.get(d.tabId)?.yt;
  if (!y) return;
  try {
    const u = new URL(d.url);
    const lang = u.searchParams.get('lang');
    if (!lang || u.searchParams.get('tlang')) return;
    y.subsSeen ??= new Map();
    y.subsSeen.set(`${lang}:${u.searchParams.get('kind') === 'asr' ? 'asr' : ''}`, d.url);
  } catch { /* ignore */ }
}, { urls: ['*://www.youtube.com/api/timedtext*', '*://youtube.com/api/timedtext*'], types: ['xmlhttprequest', 'other'] });


async function getYtDiagnostics(tabId) {
  await ready;
  const y = tabs.get(tabId)?.yt;
  const manifest = browser.runtime.getManifest ? browser.runtime.getManifest() : {};
  const report = buildDiagnostics(y?.summary || null, y?.diag || null, {
    version: manifest.version_name || manifest.version, userAgent: globalThis.navigator?.userAgent || '',
    download: y?.dlog || null,
    test: y?.testLog || null,
    api: y?.api ? { fellBack: !!y.api.fellBack, done: y.api.done, client: y.api.client, formats: y.api.formats.length, hls: !!y.api.hlsUrl, mode: y.api.mode || '', iosOnly: !!y.api.iosOnly, session: y.api.session || '', log: y.api.log } : null,
    apiPage: y?.apiPage ? { done: y.apiPage.done, client: y.apiPage.client, formats: y.apiPage.formats.length, hls: !!y.apiPage.hlsUrl, session: y.apiPage.session, log: y.apiPage.log } : null,
    apiFormats: y?.api?.formats || [],
    rec: y?.rec ? { state: y.rec.state, error: y.rec.error, bytes: y.rec.bytes, live: y.rec.live, seconds: y.rec.seconds, tracks: y.rec.tracks, dbg: y.rec.dbg } : null,
    liveJobs: [...jobs.values()].filter((j) => j.liveLog).map((j) => ({ state: j.state, error: j.error || '', live: j.liveLog })),
    liveItem: (() => {
      const li = [...(tabs.get(tabId)?.items.values() || [])].find((i) => i.source === 'youtube-live');
      return li ? { status: li.status, error: li.error || '', variants: (li.variants || []).length, live: !!li.live, protected: !!li.protected } : null;
    })(),
  }, y?.captured || []);
  if (y?.summary) { const v = ytVerdict(y, !variantsFor(y).length); report.verdict = { code: v.code || 'none', record: v.record }; }
  return { text: JSON.stringify(report, null, 2) };
}

// ---- "Download test" (1.4.3debug3) -------------------------------------------
// Walks several real tracks of this video chunk by chunk and reports where (if anywhere) YouTube starts refusing.
// Nothing is kept. Each plan: which itag, chunk size, pause between chunks, how far to go.
function testPlans(formats) {
  const by = (pred) => formats.filter(pred).sort((a, b) => b.len - a.len);
  const vid = by((f) => f.mime.startsWith('video/') && f.len);
  const aud = by((f) => f.mime.startsWith('audio/') && f.len);
  const pick = (list, itag) => list.find((f) => f.itag === itag);
  const webm = vid.find((f) => f.mime.includes('webm'));
  const avc = vid.find((f) => /avc1/.test(f.mime));
  const big = vid[0];
  const plans = [];
  const add = (name, tr, chunkMiB, maxMiB, pauseMs = 0, newCpn = false) => { if (tr) plans.push({ name, tr, chunkMiB, maxMiB, pauseMs, newCpn }); };
  add('webm 5MiB seq', webm, 5, 60);
  add('avc 5MiB seq', avc, 5, 60);
  add('biggest 5MiB seq', big === webm || big === avc ? null : big, 5, 60);
  add('audio 1MiB seq', aud[0], 1, 4);
  add('webm 1MiB seq', webm, 1, 40);
  add('webm 1MiB pause250', webm, 1, 40, 250);
  add('webm 1MiB new-cpn', webm, 1, 40, 0, true);
  add('webm 256KiB seq', webm, 0.25, 40);
  return plans;
}

async function runYtTest(tabId) {
  await ready;
  const y = tabs.get(tabId)?.yt;
  const log = { time: new Date().toISOString(), state: 'running', results: [] };
  if (y) y.testLog = log;
  const formats = (y?.api?.formats || []).map((f) => ({ ...f, len: f.clen || f.len || 0 }));
  const plans = testPlans(formats);
  if (!plans.length) { log.state = 'no_formats'; return { ok: false, log }; }
  ytHdr.ua = y.api.ua || '';
  ytHdr.on = !!settings.ytHeaders;
  for (const plan of plans) {
    const { tr } = plan;
    const size = Math.round(plan.chunkMiB * MIB);
    const res = { plan: plan.name, itag: tr.itag, mime: tr.mime.split(';')[0], lenMiB: Math.round(tr.len / MIB), statuses: [], gotMiB: 0, firstFailMiB: null, ms: 0 };
    log.results.push(res);
    let cpn = settings.ytCpn ? makeCpn() : '';
    const t0 = Date.now();
    try {
      for (let start = 0, i = 0; start < tr.len && start < plan.maxMiB * MIB; start += size, i++) {
        if (plan.newCpn) cpn = makeCpn();
        const end = Math.min(start + size, tr.len) - 1;
        const u = new URL(cpn ? withCpn(tr.url, cpn) : tr.url);
        u.searchParams.set('range', `${start}-${end}`);
        let status;
        try {
          const r = await fetch(u.href, { credentials: 'omit' });
          status = r.status;
          if (r.ok) res.gotMiB += (await r.arrayBuffer()).byteLength / MIB;
        } catch (e) { status = `net:${String(e?.name || 'error')}`; }
        res.statuses.push(status);
        if (status !== 200 && status !== 206) { res.firstFailMiB = Math.round(start / MIB * 100) / 100; break; }
        if (plan.pauseMs) await new Promise((r) => setTimeout(r, plan.pauseMs));
      }
    } catch (e) { res.error = String(e?.name || 'error'); }
    res.ms = Date.now() - t0;
    res.gotMiB = Math.round(res.gotMiB * 10) / 10;
    if (res.statuses.length > 12) { // keep the report short: ok-count + the tail
      const ok = res.statuses.filter((x) => x === 200 || x === 206).length;
      res.statuses = [`ok x${ok}`, ...res.statuses.filter((x) => x !== 200 && x !== 206)];
    }
  }
  log.state = 'done';
  return { ok: true, log };
}

// ---- YouTube "record while playing" -----------------------------------------

const REC_STATES = ['idle', 'recording', 'done', 'saved', 'error'];

function sanitizeRec(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    state: REC_STATES.includes(r.state) ? r.state : 'idle',
    error: String(r.error || '').slice(0, 40),
    bytes: Number(r.bytes) || 0,
    progress: Math.min(1, Math.max(0, Number(r.progress) || 0)),
    duration: Number(r.duration) || 0,
    merged: !!r.merged,
    dbg: (Array.isArray(r.dbg) ? r.dbg : []).slice(0, 4).map((x) => ({ kind: x.kind === 'audio' ? 'audio' : 'video', mime: String(x.mime || '').slice(0, 70), appends: Number(x.appends) || 0, appendBytes: Number(x.appendBytes) || 0, reps: Number(x.reps) || 0, frags: (Array.isArray(x.frags) ? x.frags : []).slice(0, 6).map((n) => Number(n) || 0), dropping: !!x.dropping, first: String(x.first || '').replace(/[^0-9a-f]/g, '').slice(0, 40), pend: Number(x.pend) || 0 })),
    live: !!r.live,
    draining: !!r.draining,
    seconds: Math.round(Number(r.seconds) || 0),
    interrupted: !!r.interrupted,
    tracks: (Array.isArray(r.tracks) ? r.tracks : []).slice(0, 4).map((x) => ({
      kind: x.kind === 'audio' ? 'audio' : 'video',
      ext: ['mp4', 'webm', 'm4a', 'weba'].includes(x.ext) ? x.ext : 'mp4',
      height: Number(x.height) || 0,
      fragments: Number(x.fragments) || 0,
      bytes: Number(x.bytes) || 0,
    })),
  };
}

async function handleRecStatus(msg, sender) {
  await ready;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0) return;
  const rec = sanitizeRec(msg.state);
  if (!rec) return;
  const t = getTab(tabId);
  t.yt ??= { summary: null, captured: [], diag: newDiag() };
  const was = t.yt.rec?.state;
  t.yt.rec = rec;
  if (was !== rec.state) dlog('rec', `${was || '-'} -> ${rec.state}`, { error: rec.error || '', bytes: rec.bytes, tracks: rec.tracks.map((x) => `${x.kind}:${x.fragments}`), live: !!rec.live });
  if (rec.state === 'recording' || rec.state === 'saved' || rec.state === 'error') t.yt.recSaving = false;
  // the recording reached its end by itself (not stopped by the user, not interrupted): the file is saved right away
  if (rec.state === 'done' && was === 'recording' && !rec.interrupted && !t.yt.recSaving && rec.tracks.length) {
    t.yt.recSaving = true;
    handleRecCommand({ tabId, cmd: 'save' }).catch(() => {});
  }
  if (rec.state === 'saved' && was !== 'saved' && settings.history && t.yt.summary) {
    await addHistory({
      title: t.yt.summary.title || 'YouTube',
      url: `https://www.youtube.com/watch?v=${t.yt.summary.videoId}`,
      kind: 'yt',
      filename: (canMergeTracks(rec.tracks) ? (t.yt.recNames || []).slice(0, 1) : (t.yt.recNames || [])).join(' + '),
    });
  }
  if (t.yt.summary) refreshYoutube(tabId); else notifyUI(tabId);
}

// Video + audio of the same container are joined into one file by the recorder (VP9 + AAC and AV1 + Opus: into MP4, or Matroska by the setting).
function canMergeTracks(list) {
  return list.length === 2 && list[0].kind === 'video' && list[1].kind === 'audio'
    && ((list[0].ext === 'webm' && list[1].ext === 'weba') || (list[0].ext === 'mp4' && list[1].ext === 'm4a') || (list[0].ext === 'webm' && list[1].ext === 'm4a') || (list[0].ext === 'mp4' && list[1].ext === 'weba'));
}

function recFilenames(tabId) {
  const y = tabs.get(tabId)?.yt;
  const list = y?.rec?.tracks || [];
  const stamp = (() => { const d = new Date(); const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`; })();
  return list.map((tr) => buildFilename(settings.template, {
    title: y?.summary?.isLive ? `youtube_${y.summary.videoId}_${stamp}` : (y?.summary?.title || 'youtube'),
    site: 'youtube.com',
    quality: tr.height ? `${tr.height}p` : '',
    ext: list.length === 2 && ((list[0].ext === 'webm' && list[1].ext === 'm4a') || (list[0].ext === 'mp4' && list[1].ext === 'weba')) && canMergeTracks(list) ? (tr.kind === 'video' ? (settings.joinFormat === 'mkv' ? 'mkv' : 'mp4') : tr.ext) : tr.ext, // VP9 + AAC and AV1 + Opus: MP4 (default) or Matroska
    suffix: list.length > 1 && tr.kind === 'audio' ? '.audio' : '',
  }));
}

async function handleRecCommand({ tabId, cmd }) {
  await ready;
  dlog('rec', `command ${cmd}`, { tab: tabId });
  const t = getTab(tabId);
  try {
    if (cmd === 'start') {
      // regular videos are recorded only when the option is on; live streams always can be
      if (!settings.ytRecordUi && !t.yt?.summary?.isLive) return { ok: false, error: 'rec_disabled' };
      t.yt ??= { summary: null, captured: [], diag: newDiag() };
      t.yt.rec = { state: 'recording', error: '', bytes: 0, progress: 0, duration: 0, tracks: [] };
      await browser.tabs.sendMessage(tabId, { type: 'yt_rec_cmd', cmd: 'start', speed: settings.ytRecordSpeed, maxMB: settings.maxStreamMB, live: !!t.yt?.summary?.isLive, maxMin: Number(settings.liveMaxMinutes) || 180 }, { frameId: 0 });
    } else if (cmd === 'save') {
      t.yt.recSaving = true;
      t.yt.recNames = recFilenames(tabId);
      await browser.tabs.sendMessage(tabId, { type: 'yt_rec_cmd', cmd: 'save', names: t.yt.recNames }, { frameId: 0 });
    } else if (cmd === 'stop_save') {
      t.yt.recSaving = true;
      t.yt.recNames = recFilenames(tabId);
      await browser.tabs.sendMessage(tabId, { type: 'yt_rec_cmd', cmd: 'stopsave', names: t.yt.recNames }, { frameId: 0 });
    } else if (cmd === 'save_audio') {
      const tr = (t.yt?.rec?.tracks || []).find((x) => x.kind === 'audio');
      if (!tr) return { ok: false, error: 'no audio' };
      const name = buildFilename(settings.template, { title: t.yt?.summary?.title || 'youtube', site: 'youtube.com', quality: '', ext: tr.ext, suffix: '' });
      await browser.tabs.sendMessage(tabId, { type: 'yt_rec_cmd', cmd: 'save', only: 'audio', names: [name] }, { frameId: 0 });
    } else if (cmd === 'cancel') {
      await browser.tabs.sendMessage(tabId, { type: 'yt_rec_cmd', cmd: 'cancel' }, { frameId: 0 });
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (t.yt?.summary) refreshYoutube(tabId); else notifyUI(tabId);
  return { ok: true };
}

// ------------------------------------------------------------- messaging ----

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg.type) {
    case 'get_state':
      return getState(msg.tabId);
    case 'download':
      return startDownload(msg);
    case 'yt_subs':
      return saveSubsOnly(msg.tabId, msg.itemId, String(msg.choice || ''));
    case 'dismiss_job': {
      const j = jobs.get(msg.jobId);
      if (j && j.state !== 'running') jobs.delete(msg.jobId);
      notifyUI(msg.tabId);
      return Promise.resolve({ ok: true });
    }
    case 'stop_job': {
      const j = jobs.get(msg.jobId);
      if (j?.stopCtl) { j.stopping = true; j.stopCtl.abort(); }
      return Promise.resolve({ ok: true });
    }
    case 'cancel_job': {
      jobs.get(msg.jobId)?.abort.abort();
      return Promise.resolve({ ok: true });
    }
    case 'page_info':
      return handlePageInfo(msg, sender).then(() => ({ ok: true }));
    case 'page_media':
      return handlePageMedia(msg, sender).then(() => ({ ok: true }));
    case 'tiktok_media':
      return handleTikTok(msg, sender).then(() => ({ ok: true }));
    case 'x_media':
      return handleX(msg, sender).then(() => ({ ok: true }));
    case 'ig_media':
      return handleInstagram(msg, sender).then(() => ({ ok: true }));
    case 'yt_player':
      return handleYtPlayer(msg, sender).then(() => ({ ok: true }));
    case 'yt_page_download':
      return fetchYtApiFromPage(msg.tabId);
    case 'bug_dismiss': {
      const tb = tabs.get(msg.tabId);
      if (tb?.bug && tb.bug.state !== 'running') tb.bug = null;
      return Promise.resolve({ ok: true });
    }
    case 'bug_text':
      return Promise.resolve({ text: tabs.get(msg.tabId)?.bug?.text || '' });
    case 'bug':
    case 'yt_bug':
      return runBugReport(msg.tabId);
    case 'yt_test':
      return runYtTest(msg.tabId).then((r) => ({ ok: r.ok, state: r.log.state }));
    case 'yt_diagnostics':
      return getYtDiagnostics(msg.tabId);
    case 'yt_rec_status':
      return handleRecStatus(msg, sender).then(() => ({ ok: true }));
    case 'yt_rec':
      return handleRecCommand(msg);
    case 'site_media':
      return ready.then(() => {
        const tabId = sender.tab?.id;
        if (tabId !== undefined && tabId >= 0) (msg.items || []).forEach((x) => addItem(tabId, { ...x, source: x.source || 'site' }));
        return { ok: true };
      });
    default:
      return undefined;
  }
});

// ------------------------------------------------------------ navigation ----

browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  const t = tabs.get(d.tabId);
  if (t) {
    for (const [id, it] of t.items) if (it.url !== d.url) t.items.delete(id);
    t.hidden.clear();
    t.xMedia = null;
    t.tiktok = null;
    t.ttSizes = null;
    t.ttScan = null;
    t.resolved.clear();
    t.pageTitle = '';
    t.thumbnail = '';
    t.yt = null;
    t.igScan = null;
  }
  updateBadge(d.tabId);
  scheduleSave();
  notifyUI(d.tabId);
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  scheduleSave();
});

// ------------------------------------------------------------------ hotkeys ----

// Firefox for Android has no commands (hotkeys) and notifications API: every use is guarded,
// so the background keeps working there (downloads are started from the popup).
// (The context-menu item was removed in 1.6.0dev5: the popup and the hotkeys do the same, more reliably.)

// Hotkeys: "download the first video" and "download the audio of the first media" act on the newest detected item of
// the active tab; "open the popup" is handled by the browser itself. The master switch is settings.hotkeys.
async function hotkeyItem() {
  await ready;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const items = tab && tabs.get(tab.id) ? shownItems(tabs.get(tab.id)).filter(downloadable).reverse() : [];
  return { tab, it: items[0] || null };
}

// The audio the popup would pick: the preferred format and quality of the settings.
function hotkeyAudioChoice(tabId, it) {
  const y = tabs.get(tabId)?.yt;
  const list = it.kind === 'yt' ? variantsFor(y).map((v, index) => ({ ...v, index })).filter((v) => v.audio) : (it.kind === 'dash' ? dashAudioVariants(it) : []);
  const groups = groupAudio(list.filter((v) => !v.unavailable && !v.tooLong));
  const group = groups.find((g) => g.type === settings.defaultAudioFormat) || groups[0];
  const chosen = group && pickAudioQuality(group.items, settings.defaultAudioQuality, group.type === 'mp3');
  if (!chosen) return null;
  return it.kind === 'yt'
    ? { tabId, itemId: it.id, variant: chosen.index, variantLabel: chosen.label }
    : { tabId, itemId: it.id, variant: 0, audio: { rep: chosen.rep ?? 0, mp3: !!chosen.mp3, kbps: chosen.kbps || 0 } };
}

browser.commands?.onCommand.addListener(async (command) => {
  if (command !== 'default-action' && command !== 'download-audio') return;
  await ready;
  if (!settings.hotkeys) return;
  const { tab, it } = await hotkeyItem();
  if (!it) return;
  if (command === 'default-action') { startDownload({ tabId: tab.id, itemId: it.id, variant: 0 }); return; }
  const msg = hotkeyAudioChoice(tab.id, it);
  if (msg) startDownload(msg);
  else notify(tr('noAudioHere'));
});

// Firefox only (commands.update): puts the shortcuts of the settings on the commands, or removes them when the
// switch is off. Called when these settings change, not at every start, so a shortcut set in
// about:addons stays until the user changes it here.
async function applyHotkeys() {
  if (typeof browser.commands?.update !== 'function') return;
  for (const [key, name] of Object.entries(COMMAND_OF)) {
    const want = settings.hotkeys && isValidShortcut(settings[key]) ? settings[key] : '';
    try { await browser.commands.update({ name, shortcut: want }); } catch (e) { dlog('settings', 'shortcut refused', { name, shortcut: want, error: String(e?.message || e) }); }
  }
}

// ---------------------------------------------------------- debug log ----
// Uncaught errors of the background go to the debug log (only when it is switched on).
globalThis.addEventListener?.('error', (ev) => dlog('error', String(ev?.message || ev?.error?.message || 'error'), { at: `${String(ev?.filename || '').split('/').pop()}:${ev?.lineno || ''}` }));
globalThis.addEventListener?.('unhandledrejection', (ev) => dlog('error', `unhandled: ${String(ev?.reason?.message || ev?.reason || '')}`));
