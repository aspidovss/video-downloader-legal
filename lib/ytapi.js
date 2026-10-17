import { captionTracks } from './subs.js';
// YouTube: ask the Innertube /player endpoint the way the mobile apps do (ANDROID_VR, IOS).
// Those clients return plain stream URLs (no SABR) and, for IOS, an HLS manifest.
// Client versions go stale, so they can be edited in settings (JSON overrides).
// No player code is executed and no tokens are forged: if YouTube refuses, we report it
// and the user falls back to "record while playing".

export const CLIENTS = {
  // Public client identifiers of the YouTube mobile apps. They go stale, so every
  // field can be overridden (or a whole client added) in settings -> "client overrides".
  VISIONOS: {
    name: 'VISIONOS', id: 101, version: '1.02',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    extra: { deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471' },
  },
  ANDROID_VR: {
    name: 'ANDROID_VR', id: 28, version: '1.65.10',
    ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    extra: { deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' },
  },
  // 20.10.4 is the iOS version that still returned plain https formats in testing; newer ones
  // (21.x) answer with SABR only and no usable URLs.
  IOS: {
    name: 'IOS', id: 5, version: '20.10.4',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    extra: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
  },
  // An additional iOS profile (an older iPhone on iOS 16): public client identifiers, as sent by the official YouTube iOS app.
  IOS_VDL: {
    name: 'IOS', id: 5, version: '20.11.6',
    ua: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)',
    extra: { deviceMake: 'Apple', deviceModel: 'iPhone10,4', osName: 'iOS', osVersion: '16.7.7.20H330' },
  },
};

// Default order: VISIONOS, ANDROID_VR, IOS plus our extra IOS build (IOS_VDL).
export const DEFAULT_CLIENTS = 'VISIONOS,ANDROID_VR,IOS,IOS_VDL';
const OLD_DEFAULTS = ['ANDROID_VR,IOS', 'ANDROID_VR, IOS', 'VISIONOS,ANDROID_VR,IOS', 'IOS,IOS_VDL,VISIONOS,ANDROID_VR'];

// "VISIONOS, IOS" + optional JSON -> ordered client list.
// JSON: {"IOS":{"version":"..","ua":".."}} edits a built-in client;
//       {"MYCLIENT":{"id":9,"version":"1.0","ua":"..","clientName":"X","extra":{..}}} defines a new one.
export function resolveClients(list = DEFAULT_CLIENTS, overridesJson = '') {
  let raw = {};
  try { raw = overridesJson && overridesJson.trim() ? JSON.parse(overridesJson) : {}; } catch { raw = {}; }
  const overrides = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (v && typeof v === 'object') overrides[k.toUpperCase()] = v;
  const names = OLD_DEFAULTS.includes(String(list).trim()) ? DEFAULT_CLIENTS : String(list);
  const out = [];
  for (const rawName of names.split(',')) {
    const key = rawName.trim().toUpperCase();
    if (!key || out.some((c) => c.key === key)) continue;
    const o = overrides[key] || {};
    const base = CLIENTS[key] || (Number(o.id) > 0 && typeof o.version === 'string' && typeof o.ua === 'string'
      ? { name: key, id: Number(o.id), version: o.version, ua: o.ua, extra: {} } : null);
    if (!base) continue;
    out.push({
      key,
      ...base,
      name: typeof o.clientName === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(o.clientName) ? o.clientName : base.name,
      id: Number(o.id) > 0 ? Number(o.id) : base.id,
      version: typeof o.version === 'string' && o.version ? o.version : base.version,
      ua: typeof o.ua === 'string' && o.ua ? o.ua : base.ua,
      extra: { ...base.extra, ...(o.extra && typeof o.extra === 'object' ? o.extra : {}) },
    });
  }
  return out;
}

const CPN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function makeCpn() {
  const r = crypto.getRandomValues(new Uint8Array(16));
  return [...r].map((b) => CPN_ALPHABET[b & 63]).join('');
}
export function withCpn(url, cpn) {
  const u = new URL(url);
  if (cpn && !u.searchParams.has('cpn')) u.searchParams.set('cpn', cpn);
  return u.href;
}

// auth = { include: true } sends the browser's own YouTube cookies (credentials: 'include').
export function buildPlayerRequest(client, videoId, visitorData = '', auth = null) {
  const ctxClient = { clientName: client.name, clientVersion: client.version, hl: 'en', gl: 'US', utcOffsetMinutes: 0, ...client.extra };
  if (visitorData) ctxClient.visitorData = visitorData;
  const headers = {
    'Content-Type': 'application/json',
    'X-YouTube-Client-Name': String(client.id),
    'X-YouTube-Client-Version': client.version,
  };
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
  return {
    url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    init: {
      method: 'POST',
      credentials: auth ? 'include' : 'omit', 
      headers,
      body: JSON.stringify({
        context: { client: ctxClient },
        videoId,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    },
  };
}

// ---- web session (what a regular YouTube client does) ----------------------
// First fetch https://www.youtube.com/sw.js_data and builds the request context from it
// (YouTube-issued visitorData, remoteHost, install data...), then overrides the client fields.
// Returns null when the response is not the expected JSPB.
export function parseSwData(text) {
  try {
    const t = String(text);
    if (!t.startsWith(")]}'")) return null;
    const d = JSON.parse(t.replace(/^\)\]\}'/, ''))[0][2];
    const m = d[0][0];
    const f = m[61];
    const str = (v) => (typeof v === 'string' ? v : '');
    const out = {
      apiKey: str(d[1]), hl: str(m[0]), gl: str(m[1]), remoteHost: str(m[3]), visitorData: str(m[13]),
      timeZone: str(m[79]), browserName: str(m[86]), browserVersion: str(m[87]), deviceMake: str(m[11]), deviceModel: str(m[12]),
      osName: str(m[17]), osVersion: str(m[18]), rolloutToken: str(m[107]), deviceExperimentId: str(m[103]),
      appInstallData: Array.isArray(f) ? str(f[f.length - 1]) : '',
    };
    return out.visitorData ? out : null;
  } catch { return null; }
}

// Player request in the shape youtubei.js produces: full web context + the client's overrides.
export function buildSessionPlayerRequest(client, videoId, session, utcOffsetMinutes = 0) {
  const x = client.extra || {};
  const c = {
    hl: session.hl || 'en', gl: session.gl || 'US', remoteHost: session.remoteHost || undefined,
    screenDensityFloat: 1, screenHeightPoints: 1440, screenPixelDensity: 1, screenWidthPoints: 2560,
    visitorData: session.visitorData, clientName: client.name, clientVersion: client.version,
    osName: session.osName || undefined, osVersion: session.osVersion || undefined, userAgent: client.ua,
    platform: 'DESKTOP', clientFormFactor: 'UNKNOWN_FORM_FACTOR', userInterfaceTheme: 'USER_INTERFACE_THEME_LIGHT',
    timeZone: session.timeZone || 'UTC', originalUrl: 'https://www.youtube.com',
    deviceMake: session.deviceMake || undefined, deviceModel: session.deviceModel || undefined,
    browserName: session.browserName || undefined, browserVersion: session.browserVersion || undefined,
    utcOffsetMinutes, memoryTotalKbytes: '8000000',
    rolloutToken: session.rolloutToken || undefined, deviceExperimentId: session.deviceExperimentId || undefined,
    mainAppWebInfo: { graftUrl: 'https://www.youtube.com', pwaInstallabilityStatus: 'PWA_INSTALLABILITY_STATUS_UNKNOWN', webDisplayMode: 'WEB_DISPLAY_MODE_BROWSER', isWebNativeShareAvailable: true },
  };
  // mobile-client overrides, as a regular client does
  Object.assign(c, x, { platform: 'MOBILE' });
  delete c.browserName;
  delete c.browserVersion;
  if (client.name === 'ANDROID_VR') c.clientFormFactor = 'SMALL_FORM_FACTOR';
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  const url = new URL('https://www.youtube.com/youtubei/v1/player');
  url.searchParams.set('prettyPrint', 'false');
  if (session.apiKey) url.searchParams.set('key', session.apiKey);
  return {
    url: url.href,
    init: {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json', Accept: '*/*', 'Accept-Language': '*',
        'X-Goog-Visitor-Id': session.visitorData,
        'X-Youtube-Client-Version': client.version, 'X-Youtube-Client-Name': String(client.id),
      },
      body: JSON.stringify({
        videoId, racyCheckOk: true, contentCheckOk: true,
        playbackContext: { contentPlaybackContext: { vis: 0, splay: false, lactMilliseconds: '-1' } },
        context: { client: c, user: { lockedSafetyMode: false }, request: { useSsl: true, internalExperimentFlags: [] } },
      }),
    },
  };
}

const isGoogleVideo = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)googlevideo\.com$/.test(x.hostname); } catch { return false; }
};

function mapFormat(f, adaptive, client) {
  const mime = String(f.mimeType || '');
  const url = typeof f.url === 'string' && isGoogleVideo(f.url) ? f.url : '';
  return {
    itag: Number(f.itag) || 0,
    mime,
    label: f.qualityLabel || '',
    w: Number(f.width) || 0,
    h: Number(f.height) || 0,
    fps: Number(f.fps) || 0,
    bitrate: Number(f.bitrate) || 0,
    clen: Number(f.contentLength) || 0,
    audio: mime.startsWith('audio/'),
    adaptive,
    mode: url ? 'direct' : (f.signatureCipher || f.cipher) ? 'cipher' : 'none',
    drm: !!(f.drmFamilies && f.drmFamilies.length) || !!f.drmTrackType,
    n: /[?&]n=/.test(url),
    url,
    client,
    dub: !!(f.audioTrack && f.audioTrack.audioIsDefault === false),
  };
}

// -> { status, reason, title, lengthSeconds, live, hlsUrl, formats }
export function parsePlayerResponse(json, clientName = '') {
  const pr = json && typeof json === 'object' ? json : {};
  const sd = pr.streamingData || {};
  const vd = pr.videoDetails || {};
  const formats = [
    ...(sd.formats || []).map((f) => mapFormat(f, false, clientName)),
    ...(sd.adaptiveFormats || []).map((f) => mapFormat(f, true, clientName)),
  ].filter((f) => f.itag && f.mode === 'direct' && !f.drm && !f.dub);
  const hls = typeof sd.hlsManifestUrl === 'string' && isGoogleVideo(sd.hlsManifestUrl) ? sd.hlsManifestUrl : '';
  return {
    status: pr.playabilityStatus?.status || '',
    reason: String(pr.playabilityStatus?.reason || '').slice(0, 120),
    title: String(vd.title || ''),
    lengthSeconds: Number(vd.lengthSeconds) || 0,
    live: !!(vd.isLive || vd.isLiveContent && vd.isUpcoming),
    hlsUrl: hls,
    formats,
    captions: captionTracks(pr),
  };
}

// Parameter NAMES only (never values) for diagnostics.
export function urlParamNames(url) {
  try { return [...new URL(url).searchParams.keys()].sort(); } catch { return []; }
}

export const MIB = 1024 * 1024;

// Pre-flight check: can this client's URLs really be read beyond the first megabytes?
// Requests ONE byte at a few offsets (start, every 5 MiB up to 30, 40 MiB, end) of the largest video.
// Result: { ok, offsets:[{off,status}], limitBytes } - limitBytes is the first refused offset
// (0 = nothing works, Infinity = no limit seen).
export function pickProbeFormat(formats) {
  const video = formats.filter((f) => f.mime.startsWith('video/') && f.clen > 0);
  const pool = video.length ? video : formats.filter((f) => f.clen > 0);
  return pool.slice().sort((a, b) => b.clen - a.clen)[0] || null;
}

export async function probeFormats(formats, fetchFn) {
  const f = pickProbeFormat(formats);
  if (!f) return { ok: true, offsets: [], limitBytes: Infinity, skipped: true };
  const wanted = [0, 5 * MIB, 10 * MIB, 15 * MIB, 20 * MIB, 25 * MIB, 30 * MIB, 40 * MIB, f.clen - 1].filter((o) => o >= 0 && o < f.clen);
  const offsets = [...new Set(wanted)].sort((a, b) => a - b);
  const results = await Promise.all(offsets.map(async (off) => {
    const u = new URL(f.url);
    u.searchParams.set('range', `${off}-${off}`);
    let status;
    try {
      const res = await fetchFn(u.href, { credentials: 'omit' });
      status = res.status;
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
    } catch (e) { status = `net:${String(e?.name || 'error')}`; }
    return { off, status };
  }));
  const bad = results.find((r) => !(r.status >= 200 && r.status < 300));
  return { ok: !bad, offsets: results, limitBytes: bad ? bad.off : Infinity, itag: f.itag };
}
