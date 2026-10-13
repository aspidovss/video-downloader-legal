// Canva (isolated content script). A shared design with video ("/watch" page) carries the HLS address in an inline
// script of the page ("hlsManifestUrl"). We read it from the page and hand it over.
(() => {
  const isTest = typeof module !== 'undefined' && module.exports;
  const RE = /['"]hlsManifestUrl['"]\s*:\s*['"]([^'"]+)['"]/;

  function findHls(text) {
    const m = String(text).match(RE);
    if (!m) return '';
    let u = m[1];
    try { u = JSON.parse(`"${u}"`); } catch { /* keep as is */ }
    return /^https:\/\//.test(u) ? u : '';
  }
  const isWatch = (url) => /canva\.com\/.*\/watch/.test(url);

  if (isTest) { module.exports = { findHls, isWatch }; return; }
  if (window.top !== window) return;

  let last = '';
  let tries = 0;
  function scan() {
    const url = location.href;
    if (url !== last) { last = url; tries = 0; }
    if (!isWatch(url) || tries > 20) return;
    tries++;
    for (const s of document.querySelectorAll('script')) {
      const u = findHls(s.textContent || '');
      if (!u) continue;
      tries = 99;
      try { browser.runtime.sendMessage({ type: 'page_media', site: 'canva.com', url, title: document.title || '', items: [{ kind: 'hls', url: u }] }); } catch { /* asleep */ }
      return;
    }
  }
  setInterval(scan, 1500);
})();
