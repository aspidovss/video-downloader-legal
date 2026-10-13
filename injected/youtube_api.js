// Runs in the PAGE world on youtube.com (manifest: world "MAIN", top frame only).
// "Method 2" (1.4.5debug): the Innertube /player request is made from INSIDE the YouTube page,
// exactly where a regular client makes it: same origin, the page's own cookies and headers.
// It runs only when the user presses the button. Nothing is forged, nothing is decrypted.
// Protocol: relay (injected/youtube.js) posts {__vdl:'api-cmd', id, videoId, clients[]};
// this script answers {__vdl:'api-res', payload: JSON}.
(() => {
  const isTest = typeof module !== 'undefined' && module.exports;
  if (!isTest && window.__vdlYtApi) return;
  if (!isTest) window.__vdlYtApi = true;

  // Mirrors lib/ytapi.js parseSwData (a unit test keeps both in sync).
  function parseSwData(text) {
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

  // Mirrors lib/ytapi.js buildSessionPlayerRequest; the page sets Origin/Referer/cookies/UA itself.
  function buildRequest(client, videoId, session, utcOffsetMinutes) {
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
    Object.assign(c, x, { platform: 'MOBILE' });
    delete c.browserName;
    delete c.browserVersion;
    if (client.name === 'ANDROID_VR') c.clientFormFactor = 'SMALL_FORM_FACTOR';
    for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
    const url = `/youtubei/v1/player?prettyPrint=false${session.apiKey ? `&key=${encodeURIComponent(session.apiKey)}` : ''}`;
    return {
      url,
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

  const hasVideo = (j) => !!(j?.streamingData?.adaptiveFormats || []).concat(j?.streamingData?.formats || []).some((f) => f && f.url && String(f.mimeType || '').startsWith('video/'));

  async function run(cmd) {
    const out = { id: cmd.id, session: '', results: [] };
    let session = null;
    try {
      const r = await fetch('/sw.js_data', { credentials: 'include', headers: { 'Accept-Language': 'en-US', Accept: '*/*' } });
      session = r.ok ? parseSwData(await r.text()) : null;
      out.session = session ? 'ok' : `bad:${r.status}`;
    } catch (e) { out.session = `err:${String((e && e.name) || 'error')}`; }
    if (!session) return out;
    const offset = -Math.floor(new Date().getTimezoneOffset());
    for (const c of cmd.clients || []) {
      const entry = { client: c.key, status: 0, error: '', json: null };
      out.results.push(entry);
      try {
        const req = buildRequest(c, cmd.videoId, session, offset);
        const res = await fetch(req.url, req.init);
        entry.status = res.status;
        if (!res.ok) continue;
        const j = await res.json();
        // Only what the background needs.
        entry.json = {
          playabilityStatus: { status: j?.playabilityStatus?.status || '', reason: String(j?.playabilityStatus?.reason || '').slice(0, 120) },
          videoDetails: { title: j?.videoDetails?.title || '', lengthSeconds: j?.videoDetails?.lengthSeconds || '', isLive: !!j?.videoDetails?.isLive },
          streamingData: j?.streamingData ? {
            formats: j.streamingData.formats || [], adaptiveFormats: j.streamingData.adaptiveFormats || [],
            hlsManifestUrl: j.streamingData.hlsManifestUrl || '',
          } : null,
        };
        // Stop rule: first non-IOS client that gives video formats.
        if (c.name !== 'IOS' && j?.playabilityStatus?.status === 'OK' && hasVideo(j)) break;
      } catch (e) { entry.error = String((e && e.name) || 'error'); }
    }
    return out;
  }

  if (isTest) { module.exports = { parseSwData, buildRequest, run }; return; }

  // Live HLS test (1.5.1debug11): fetch the media playlist and its first segment from INSIDE the page (youtube.com origin).
  async function liveTest(cmd) {
    const out = { id: cmd.id, steps: [] };
    const st = (name, p) => p.then(async (r) => { out.steps.push(`${name}:${r.status}`); try { r.body && r.body.cancel(); } catch { /* ignore */ } return r; }).catch((e) => { out.steps.push(`${name}:${String((e && e.name) || 'err')}`); return null; });
    const pl = await fetch(cmd.url).then(async (r) => { out.steps.push(`playlist:${r.status}`); return r.ok ? r.text() : ''; }).catch((e) => { out.steps.push(`playlist:${String((e && e.name) || 'err')}`); return ''; });
    const line = pl.split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    if (!line) return out;
    let seg;
    try { seg = new URL(line, cmd.url).href; } catch { return out; }
    await st('seg-cors-omit', fetch(seg, { credentials: 'omit' }));
    await st('seg-cors-include', fetch(seg, { credentials: 'include' }));
    await st('seg-range', fetch(seg, { credentials: 'omit', headers: { Range: 'bytes=0-1023' } }));
    await st('seg-noreferrer', fetch(seg, { credentials: 'omit', referrerPolicy: 'no-referrer' }));
    return out;
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__vdl === 'live-cmd' && window.top === window) {
      liveTest(e.data).then((res) => window.postMessage({ __vdl: 'live-res', payload: JSON.stringify(res) }, window.location.origin))
        .catch(() => window.postMessage({ __vdl: 'live-res', payload: JSON.stringify({ id: e.data.id, steps: ['err'] }) }, window.location.origin));
      return;
    }
    if (e.source !== window || !e.data || e.data.__vdl !== 'api-cmd' || window.top !== window) return;
    const cmd = e.data;
    run(cmd).then((res) => {
      window.postMessage({ __vdl: 'api-res', payload: JSON.stringify(res) }, window.location.origin);
    }).catch(() => {
      window.postMessage({ __vdl: 'api-res', payload: JSON.stringify({ id: cmd.id, session: 'err:run', results: [] }) }, window.location.origin);
    });
  });
})();
