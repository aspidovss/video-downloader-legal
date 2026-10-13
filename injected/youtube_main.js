// Runs in the PAGE world on YouTube (manifest: world "MAIN"). It only READS what the
// page already received: the player response (formats, details) and the page data
// (to detect a Creative Commons licence). It sends a small summary to the isolated
// relay (injected/youtube.js) via window.postMessage. No requests are made, nothing
// is decrypted, nothing is modified.
(() => {
  if (window.__vdlYtMain) return;
  window.__vdlYtMain = true;

  let lastPR = null;
  let lastData = null;
  let lastSent = '';

  function dataVideoId(data) {
    return data?.currentVideoEndpoint?.watchEndpoint?.videoId || '';
  }

  // 'cc' | 'standard' | 'unknown' - looks only inside metadata rows (the "License" row).
  function licenseOf(data, videoId) {
    if (!data || !videoId || dataVideoId(data) !== videoId) return 'unknown';
    const stack = [data];
    let nodes = 0;
    let sawRows = false;
    while (stack.length && nodes < 60000) {
      const n = stack.pop();
      nodes++;
      if (!n || typeof n !== 'object') continue;
      if (n.metadataRowRenderer) {
        sawRows = true;
        const text = JSON.stringify(n.metadataRowRenderer.contents || '');
        if (/creative\s*commons/i.test(text)) return 'cc';
      }
      if (n.metadataRowContainerRenderer) sawRows = true;
      for (const k in n) {
        const v = n[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return sawRows ? 'standard' : 'unknown';
  }

  function fmt(f, adaptive) {
    const mode = f.url ? 'direct' : (f.signatureCipher || f.cipher) ? 'cipher' : 'none';
    return {
      itag: f.itag,
      mime: f.mimeType || '',
      label: f.qualityLabel || '',
      w: f.width || 0,
      h: f.height || 0,
      fps: f.fps || 0,
      bitrate: f.bitrate || 0,
      clen: Number(f.contentLength) || 0,
      audio: !!f.audioQuality,
      adaptive,
      mode,
      drm: !!(f.drmFamilies && f.drmFamilies.length) || !!f.drmTrackType,
      n: !!f.url && /[?&]n=/.test(f.url),
      url: f.url || undefined,
    };
  }

  function summarize(pr, data) {
    const vd = pr.videoDetails || {};
    const sd = pr.streamingData || {};
    const thumbs = vd.thumbnail?.thumbnails || [];
    return {
      videoId: vd.videoId || '',
      title: vd.title || '',
      author: vd.author || '',
      lengthSeconds: Number(vd.lengthSeconds) || 0,
      thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : (vd.videoId ? `https://i.ytimg.com/vi/${vd.videoId}/hqdefault.jpg` : ''),
      isLive: !!(vd.isLive || vd.isUpcoming),
      status: pr.playabilityStatus?.status || '',
      reason: pr.playabilityStatus?.reason || '',
      sabr: !!sd.serverAbrStreamingUrl,
      hls: (vd.isLive && typeof sd.hlsManifestUrl === 'string') ? sd.hlsManifestUrl : '',
      license: licenseOf(data, vd.videoId),
      pageType: location.pathname.split('/')[1] || '',
      visitorData: String((window.ytcfg && ((window.ytcfg.get && window.ytcfg.get('VISITOR_DATA')) || (window.ytcfg.data_ && window.ytcfg.data_.VISITOR_DATA))) || ''),
      formats: [...(sd.formats || []).map((f) => fmt(f, false)), ...(sd.adaptiveFormats || []).map((f) => fmt(f, true))].slice(0, 120),
    };
  }

  function emit(pr, data) {
    try {
      if (!pr || !pr.videoDetails || !pr.videoDetails.videoId) return;
      lastPR = pr;
      if (data) lastData = data;
      const payload = JSON.stringify(summarize(pr, lastData));
      if (payload === lastSent) return;
      lastSent = payload;
      window.postMessage({ __vdl: 'yt', payload }, window.location.origin);
    } catch { /* never break the page */ }
  }

  // 1) Initial page load.
  function readInitial() {
    emit(window.ytInitialPlayerResponse, window.ytInitialData);
  }
  document.addEventListener('DOMContentLoaded', readInitial);
  window.addEventListener('load', readInitial);

  // 2) SPA navigation inside youtube.com.
  window.addEventListener('yt-navigate-finish', (e) => {
    try {
      const r = e.detail && e.detail.response;
      const player = document.getElementById('movie_player');
      const pr = (r && r.playerResponse) || (player && typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null);
      emit(pr, r && r.response);
    } catch { /* ignore */ }
  });

  // 3) Responses of the page's own player/next requests (also covers embeds).
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const isPlayer = url.includes('/youtubei/v1/player');
        const isNext = url.includes('/youtubei/v1/next');
        if (isPlayer || isNext) {
          p.then((res) => res.clone().json()).then((json) => {
            if (isPlayer) emit(json, lastData);
            else { lastData = json; if (lastPR) emit(lastPR, json); }
          }).catch(() => {});
        }
      } catch { /* ignore */ }
      return p;
    };
  }
})();
