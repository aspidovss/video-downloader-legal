// Site-specific resolvers that use PUBLIC endpoints only (the same ones the
// sites' own embedded players call for unlisted-but-public videos).
// Everything is best-effort: if a site changes or refuses, we return [] and the
// generic network sniffer keeps working.

import { hashId } from './util.js';
import { md5 } from './md5.js';

function item(base) {
  return { id: hashId(`${base.kind}:${base.url}`), ts: Date.now(), ...base };
}

// ---- Vimeo ------------------------------------------------------------------

export function vimeoIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)vimeo\.com$/.test(u.hostname)) return null;
    const m = /\/(?:video\/)?(\d{5,})(?:\/([0-9a-f]{8,}))?/.exec(u.pathname);
    if (!m) return null;
    return { id: m[1], hash: u.searchParams.get('h') || m[2] || null };
  } catch {
    return null;
  }
}

export async function resolveVimeo(pageUrl, fetchFn = fetch) {
  const v = vimeoIdFromUrl(pageUrl);
  if (!v) return [];
  const cfgUrl = `https://player.vimeo.com/video/${v.id}/config${v.hash ? `?h=${v.hash}` : ''}`;
  const res = await fetchFn(cfgUrl, { credentials: 'include' });
  if (!res.ok) return [];
  const cfg = await res.json();
  const title = cfg.video?.title || null;
  const thumb = cfg.video?.thumbs?.base ? `${cfg.video.thumbs.base}` : null;
  const duration = cfg.video?.duration || null;
  const out = [];

  for (const p of cfg.request?.files?.progressive || []) {
    out.push(item({
      kind: 'file', url: p.url, title, thumbnail: thumb, duration, source: 'vimeo',
      mime: p.mime || 'video/mp4', quality: p.height ? `${p.height}p` : '',
    }));
  }
  const hls = cfg.request?.files?.hls;
  if (hls?.cdns) {
    const cdn = hls.cdns[hls.default_cdn] || Object.values(hls.cdns)[0];
    if (cdn?.url) out.push(item({ kind: 'hls', url: cdn.url, title, thumbnail: thumb, duration, source: 'vimeo' }));
  }
  const dash = cfg.request?.files?.dash;
  if (dash?.cdns && !out.some((o) => o.kind === 'hls')) {
    const cdn = dash.cdns[dash.default_cdn] || Object.values(dash.cdns)[0];
    if (cdn?.url) out.push(item({ kind: 'dash', url: cdn.url, title, thumbnail: thumb, duration, source: 'vimeo' }));
  }
  return out;
}

// ---- Dailymotion ------------------------------------------------------------

export function dailymotionIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'dai.ly') return u.pathname.slice(1) || null;
    if (!/(^|\.)dailymotion\.com$/.test(u.hostname)) return null;
    const m = /\/(?:embed\/)?video\/([a-z0-9]+)/i.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function resolveDailymotion(pageUrl, fetchFn = fetch) {
  const id = dailymotionIdFromUrl(pageUrl);
  if (!id) return [];
  const res = await fetchFn(`https://www.dailymotion.com/player/metadata/video/${id}`, { credentials: 'include' });
  if (!res.ok) return [];
  const meta = await res.json();
  if (meta.error) return [];
  const title = meta.title || null;
  const posters = meta.posters || {};
  const thumb = posters['720'] || posters['480'] || Object.values(posters).pop() || null;
  const out = [];
  for (const [q, list] of Object.entries(meta.qualities || {})) {
    for (const s of list) {
      if (!s.url) continue;
      if (/mpegurl/i.test(s.type || '')) {
        if (q === 'auto') out.push(item({ kind: 'hls', url: s.url, title, thumbnail: thumb, duration: meta.duration, source: 'dailymotion' }));
      } else if (/video\/mp4/i.test(s.type || '')) {
        out.push(item({ kind: 'file', url: s.url, title, thumbnail: thumb, duration: meta.duration, source: 'dailymotion', mime: 'video/mp4', quality: /^\d+$/.test(q) ? `${q}p` : q }));
      }
    }
  }
  return out;
}


// ---- Bilibili ---------------------------------------------------------------
// bilibili.com: public web API (view -> cid, then the signed "wbi" playurl the site's own player calls).
// bilibili.tv: the international site's playurl. Both return plain DASH files (one file per quality / audio).

const WBI_ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

export function biliComId(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)bilibili\.com$/.test(u.hostname)) return null;
    const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(u.pathname);
    if (!m) return null;
    return { bvid: m[1], page: Math.max(1, Number(u.searchParams.get('p')) || 1) };
  } catch { return null; }
}

export function biliTvId(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)bilibili\.tv$/.test(u.hostname)) return null;
    let m = /\/play\/\d+\/(\d+)/.exec(u.pathname);
    if (m) return { ep: m[1] };
    m = /\/video\/(\d+)/.exec(u.pathname);
    return m ? { aid: m[1] } : null;
  } catch { return null; }
}

export function wbiSign(params, imgUrl, subUrl, nowSec) {
  const name = (x) => String(x).slice(String(x).lastIndexOf('/') + 1, String(x).lastIndexOf('.'));
  const raw = name(imgUrl) + name(subUrl);
  const key = WBI_ORDER.map((i) => raw.charAt(i)).join('').slice(0, 32);
  const all = { ...params, wts: String(nowSec) };
  const q = Object.keys(all).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${q}&w_rid=${md5(q + key)}`;
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// DASH description with one whole file per representation (BaseURL + SegmentBase), the shape parseMPD reads.
export function buildMpd({ duration = 0, videos = [], audios = [] }) {
  const rep = (r, i, kind) => `<Representation id="${kind}${i}" bandwidth="${Math.round(r.bandwidth) || 0}" mimeType="${xmlEsc(r.mime || (kind === 'v' ? 'video/mp4' : 'audio/mp4'))}"${r.codecs ? ` codecs="${xmlEsc(r.codecs)}"` : ''}${r.width ? ` width="${r.width}"` : ''}${r.height ? ` height="${r.height}"` : ''}><BaseURL>${xmlEsc(r.url)}</BaseURL><SegmentBase indexRange="0-0"/></Representation>`;
  const set = (list, kind, type) => (list.length ? `<AdaptationSet contentType="${type}">${list.map((r, i) => rep(r, i, kind)).join('')}</AdaptationSet>` : '');
  const dur = duration > 0 ? ` mediaPresentationDuration="PT${duration.toFixed(3)}S"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"${dur}><Period>${set(videos, 'v', 'video')}${set(audios, 'a', 'audio')}</Period></MPD>`;
}

const mpdItem = (xml, extra) => item({ kind: 'dash', url: `data:text/plain;charset=UTF-8,${encodeURIComponent(xml)}`, source: 'bilibili', ...extra });
const httpsUrl = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u.replace(/^http:/, 'https:') : '');

export function biliComFromPlayurl(data) {
  const d = data?.dash;
  if (!d) return null;
  const map = (list) => (list || []).map((x) => ({
    url: httpsUrl(x.baseUrl || x.base_url) || httpsUrl((x.backupUrl || x.backup_url || [])[0]),
    bandwidth: x.bandwidth || 0, mime: x.mimeType || x.mime_type || '', codecs: x.codecs || '', width: x.width || 0, height: x.height || 0,
  })).filter((x) => x.url);
  const videos = map(d.video);
  const audios = map(d.audio);
  if (!videos.length) return null;
  return { videos, audios, duration: (Number(d.duration) || Number(data.timelength) / 1000 || 0) };
}

export function biliTvFromPlayurl(data) {
  const p = data?.playurl;
  if (!p) return null;
  const pick = (x) => {
    const r = x.video_resource || x.audio_resource || x;
    return { url: httpsUrl(r.url) || httpsUrl((r.backup_url || [])[0]), bandwidth: r.bandwidth || r.bitrate || 0, mime: r.mime_type || '', codecs: r.codecs || '', width: r.width || 0, height: r.height || 0 };
  };
  const videos = (p.video || []).map(pick).filter((x) => x.url);
  const audios = (Array.isArray(p.audio_resource) ? p.audio_resource : []).map(pick).filter((x) => x.url);
  if (!videos.length) return null;
  return { videos, audios, duration: Number(p.duration) / 1000 || 0 };
}

export async function resolveBilibili(pageUrl, fetchFn = fetch, nowSec = Math.floor(Date.now() / 1000)) {
  const com = biliComId(pageUrl);
  const tv = !com && biliTvId(pageUrl);
  if (!com && !tv) return [];
  let found = null;
  let title = null;
  let thumb = null;
  if (com) {
    const view = await (await fetchFn(`https://api.bilibili.com/x/web-interface/view?bvid=${com.bvid}`, { credentials: 'include' })).json();
    const vd = view?.data;
    if (!vd) return [];
    const pages = vd.pages || [];
    const cid = (pages[com.page - 1] || pages[0] || {}).cid || vd.cid;
    title = vd.title || null;
    thumb = vd.pic || null;
    const nav = await (await fetchFn('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })).json();
    const img = nav?.data?.wbi_img;
    if (!img?.img_url || !img?.sub_url || !cid) return [];
    const q = wbiSign({ bvid: com.bvid, cid, fnval: 4048, try_look: 1 }, img.img_url, img.sub_url, nowSec);
    const res = await (await fetchFn(`https://api.bilibili.com/x/player/wbi/playurl?${q}`, { credentials: 'include' })).json();
    found = biliComFromPlayurl(res?.data);
  } else {
    const base = 'https://api.bilibili.tv/intl/gateway/web/playurl?s_locale=en_US&platform=web&qn=64&type=0&device=wap&tf=0';
    const res = await (await fetchFn(`${base}&${tv.ep ? `ep_id=${tv.ep}` : `aid=${tv.aid}`}`, { credentials: 'include' })).json();
    found = biliTvFromPlayurl(res?.data);
  }
  if (!found) return [];
  return [mpdItem(buildMpd(found), { title, thumbnail: thumb, duration: found.duration || null, site: 'bilibili' })];
}

// ---- PornHub ------------------------------------------------------------------
// The watch page carries the player's settings (flashvars_<n>: title, cover, length, mediaDefinitions). The "mp4" entry
// points to the site's own /video/get_media list with the progressive MP4 files of every quality. The video servers
// (*.phncdn.com) want the page as Referer / Origin: the items carry it (referer), the background sets the header.

export function pornhubViewKey(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)(pornhub\.com|pornhubpremium\.com)$/.test(u.hostname)) return null;
    if (!/^\/view_video\.php$/.test(u.pathname)) return null;
    return u.searchParams.get('viewkey') || null;
  } catch {
    return null;
  }
}

// The object literal that starts at text[start] ("{"), by counting braces outside strings; null when it does not close.
export function objectAt(text, start) {
  let depth = 0;
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function pornhubFlashvars(html) {
  const m = /\bflashvars_\d+\s*=\s*\{/.exec(String(html || ''));
  if (!m) return null;
  const obj = objectAt(html, m.index + m[0].length - 1);
  if (!obj) return null;
  try { return JSON.parse(obj); } catch { return null; }
}

export async function resolvePornhub(pageUrl, fetchFn = fetch) {
  if (!pornhubViewKey(pageUrl)) return [];
  const page = await fetchFn(pageUrl, { credentials: 'include' });
  if (!page.ok) return [];
  const fv = pornhubFlashvars(await page.text());
  const defs = Array.isArray(fv?.mediaDefinitions) ? fv.mediaDefinitions : [];
  if (!defs.length) return [];
  const title = typeof fv.video_title === 'string' ? fv.video_title : null;
  const thumbnail = /^https:\/\//.test(fv.image_url || '') ? fv.image_url : null;
  const duration = Number(fv.video_duration) || null;
  const site = new URL(pageUrl).hostname.replace(/^www\./, '');
  const files = [];
  const hls = [];
  const seen = new Set();
  const addFile = (d) => {
    const url = String(d.videoUrl || '');
    if (!/^https:\/\//.test(url) || seen.has(url) || /\.m3u8(\?|$)/.test(url)) return;
    seen.add(url);
    const q = parseInt(Array.isArray(d.quality) ? '' : d.quality, 10) || 0;
    files.push({ url, height: q, label: q ? `${q}p` : 'MP4' });
  };
  for (const d of defs) {
    const url = String(d?.videoUrl || '');
    if (!/^https:\/\//.test(url)) continue;
    if (d.format === 'mp4' && /\/video\/get_media/.test(url)) {
      try {
        const r = await fetchFn(url, { credentials: 'include' });
        const list = r.ok ? await r.json() : [];
        for (const x of Array.isArray(list) ? list : []) if (x && x.format !== 'hls') addFile(x);
      } catch { /* the list is optional: HLS still works */ }
    } else if (d.format === 'mp4') addFile(d);
    else if (d.format === 'hls' && /\.m3u8(\?|$)/.test(url) && !seen.has(url)) {
      seen.add(url);
      const q = parseInt(Array.isArray(d.quality) ? '' : d.quality, 10) || 0;
      hls.push({ url, height: q, label: q ? `${q}p` : 'HLS' });
    }
  }
  const key = pornhubViewKey(pageUrl);
  const out = [];
  // HLS of every quality (the default: many small pieces in parallel, fast): one entry, each quality is its own
  // one-variant master playlist (nested: read at download time)
  if (hls.length) {
    hls.sort((a, b) => b.height - a.height);
    const variants = hls.map((h) => ({ url: h.url, label: h.label, height: h.height, width: 0, bandwidth: 0, codecs: '', nested: true }));
    const it = item({ kind: 'hls', url: hls[0].url, title, thumbnail, duration, source: 'pornhub', site, referer: pageUrl, master: true, variants, live: false, fmt: 'mp4', status: 'ready', siteList: true });
    it.id = hashId(`hls:pornhub:${key}`); // the addresses are signed and change on every load
    out.push(it);
  }
  // the progressive MP4 files (one entry with the qualities; the site limits their speed, so they are the second choice)
  if (files.length) {
    files.sort((a, b) => b.height - a.height);
    const variants = files.map((f) => ({ url: f.url, label: f.label, height: f.height, width: 0, bandwidth: 0, type: 'mp4', typeLabel: 'MP4', codec: 'H.264', size: 0, sizeEstimated: false }));
    const it = item({ kind: 'file', url: files[0].url, title, thumbnail, duration, source: 'pornhub', site, referer: pageUrl, mime: 'video/mp4', ext: 'mp4', variants, siteList: true, secondary: hls.length > 0 });
    it.id = hashId(`file:pornhub:${key}`);
    out.push(it);
  }
  return out;
}

export const RESOLVERS = [
  { name: 'vimeo', match: (u) => !!vimeoIdFromUrl(u), resolve: resolveVimeo },
  { name: 'bilibili', match: (u) => !!(biliComId(u) || biliTvId(u)), resolve: resolveBilibili },
  { name: 'dailymotion', match: (u) => !!dailymotionIdFromUrl(u), resolve: resolveDailymotion },
  { name: 'pornhub', match: (u) => !!pornhubViewKey(u), resolve: resolvePornhub, needsRef: true },
];
