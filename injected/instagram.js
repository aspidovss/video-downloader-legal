// Instagram (isolated content script). The page player feeds the video through MSE in small pieces, so network
// sniffing only sees fragments. We read what the PAGE ITSELF is given for the
// current post: the page HTML (same origin, the user's own session) contains the DASH manifest
// ("video_dash_manifest" / "dash_manifests") and the plain mp4 list ("video_versions").
// Nothing is decrypted or forged; the result goes to the background as data.
(() => {
  const isTest = typeof module !== 'undefined' && module.exports;

  const unescape = (s) => { try { return JSON.parse(`"${s}"`); } catch { return ''; } };

  function extractManifests(text) {
    const out = [];
    for (const m of String(text).matchAll(/"dash_manifests":(\[.*?\])/g)) {
      try {
        const arr = JSON.parse(m[1]);
        for (const x of arr) if (x && typeof x.manifest_xml === 'string' && x.manifest_xml.includes('<MPD')) out.push(x.manifest_xml);
      } catch { /* ignore */ }
      if (out.length) break;
    }
    if (!out.length) {
      for (const m of String(text).matchAll(/"(?:video_dash_manifest|dash_manifest_xml_string)":\s*"((?:\\.|[^"\\])*)"/g)) {
        const xml = unescape(m[1]);
        if (xml.includes('<MPD')) { out.push(xml); break; }
      }
    }
    return out;
  }

  function extractVersions(text) {
    const out = [];
    for (const m of String(text).matchAll(/"video_versions":(\[.*?\])/g)) {
      try {
        for (const v of JSON.parse(m[1])) {
          if (v && typeof v.url === 'string' && /^https:\/\//.test(v.url)) out.push({ url: v.url, width: Number(v.width) || 0, height: Number(v.height) || 0 });
        }
      } catch { /* ignore */ }
      if (out.length) break;
    }
    return out;
  }

  // Facebook: plain mp4 addresses in the page data (JSON-escaped), same idea as the DASH manifest above
  function extractFbVersions(text) {
    const out = [];
    const seen = new Set();
    const re = /"(browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url)":\s*"((?:\\.|[^"\\])*)"/g;
    for (const m of String(text).matchAll(re)) {
      const url = unescape(m[2]);
      if (!/^https:\/\//.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, width: 0, height: /hd/.test(m[1]) ? 720 : 360 });
    }
    return out;
  }

  const isFb = (url) => /^https?:\/\/(?:[\w-]+\.)?(?:facebook\.com|fb\.watch)\//.test(url);
  // posts, reels, IGTV and stories have their own addresses; the media list is in the page data of that address
  const isMediaPage = (url) => (isFb(url)
    ? /facebook\.com\/(?:watch|reel|reels|share\/[vr]|[^/?#]+\/videos|video\.php|photo)|[?&]v=\d|fb\.watch\//.test(url)
    : /instagram\.com\/(?:[^/]+\/)?(?:reel|reels|p|tv|stories)\//.test(url));

  // Account the media belongs to: stories and /<account>/reel|p|tv/ carry it in the address, otherwise the post owner in page data.
  function extractAccount(url, text) {
    const u = String(url).match(/instagram\.com\/(?:stories\/([^/?#]+)|([^/?#]+)\/(?:reel|reels|p|tv)\/)/);
    const fromUrl = u && (u[1] || u[2]);
    if (fromUrl && fromUrl !== 'highlights') return fromUrl;
    if (isFb(url)) {
      const f = String(url).match(/facebook\.com\/([^/?#]+)\/videos\//);
      if (f && !/^(watch|reel|share|groups)$/.test(f[1])) return f[1];
      const o = String(text).match(/"owner":\{[^{}]*?"name":"((?:\\.|[^"\\])*)"/);
      return o ? unescape(o[1]).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) : '';
    }
    const m = String(text).match(/"(?:owner|user)":\{[^{}]*?"username":"([\w.]+)"/);
    return m ? m[1] : '';
  }

  if (isTest) { module.exports = { extractManifests, extractVersions, extractFbVersions, isMediaPage, extractAccount }; return; }
  if (window.top !== window) return;

  async function scan(url, attempt = 0) {
    let html = '';
    let htmlStatus = 0;
    try {
      const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
      htmlStatus = res.status;
      html = await res.text();
    } catch { /* fall back to the DOM below */ }
    let manifests = extractManifests(html);
    const fb = isFb(url);
    const getVersions = (t) => (fb ? extractFbVersions(t) : extractVersions(t));
    let versions = getVersions(html);
    let from = 'html';
    if (!manifests.length && !versions.length) {
      from = 'dom';
      const dom = document.documentElement.innerHTML;
      manifests = extractManifests(dom);
      versions = getVersions(dom);
    }
    const account = extractAccount(url, html) || extractAccount(url, document.documentElement.innerHTML);
    if (location.href !== url) return; // the user already moved on
    if (!manifests.length && !versions.length && attempt < 4) {
      // the page may not have loaded its data yet: look again shortly
      setTimeout(() => { if (location.href === url) scan(url, attempt + 1); }, 1500);
      return;
    }
    try {
      await browser.runtime.sendMessage({ type: 'ig_media', site: fb ? 'facebook.com' : 'instagram.com', url, title: document.title || '', account, manifests, versions, scan: { from, htmlStatus, htmlLength: html.length, attempt } });
    } catch { /* background asleep: it will be woken by the next navigation */ }
  }

  let last = '';
  setInterval(() => {
    const url = location.href;
    if (url === last) return;
    last = url;
    if (isMediaPage(url)) scan(url);
  }, 500);
})();
