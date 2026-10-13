// TikTok (isolated content script, top frame). The player's video elements use blob: addresses, so the page-world script
// (injected/tiktok_main.js) reads the video data from the page and posts it here; this script forwards it to the
// background (which video is on screen, its author / id / caption / cover and the addresses of its files).
(() => {
  const isTest = typeof module !== 'undefined' && module.exports;

  // address without the query (the signature changes on every load): the path identifies the video file
  function pathKey(u) {
    try { const x = new URL(u); return x.pathname.replace(/\/+$/, ''); } catch { return ''; }
  }
  function videoLink(href) { // /@author/video/123 -> { author, id }
    const m = String(href || '').match(/\/@([^/?#]+)\/video\/(\d+)/);
    return m ? { author: decodeURIComponent(m[1]), id: m[2] } : null;
  }

  if (isTest) { module.exports = { pathKey, videoLink }; return; }
  if (window.top !== window) return;

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__vdlTt !== 1) return;
    try { browser.runtime.sendMessage({ type: 'tiktok_media', list: d.list, dbg: d.dbg, url: d.url }); } catch { /* background asleep */ }
  });

  // fallback for the background: fetch the video from inside the page (the site's own cookies and Referer)
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'tt_fetch') return undefined;
    return fetch(msg.url, { credentials: 'include' }).then(async (r) => (r.ok ? { ok: true, blob: await r.blob() } : { ok: false, status: r.status })).catch((err) => ({ ok: false, status: 0, error: String(err && err.message || err) }));
  });
})();
