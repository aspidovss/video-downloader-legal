// ok.ru: the player embeds its public stream list as JSON in a data attribute.
// Best-effort parser; the generic network sniffer still works if the markup changes.
(() => {
  const seen = new Set();

  function scan() {
    const nodes = document.querySelectorAll('[data-module="OKVideo"][data-options], [data-options*="flashvars"]');
    for (const node of nodes) {
      let opts;
      try {
        opts = JSON.parse(node.getAttribute('data-options'));
        const metadata = opts?.flashvars?.metadata;
        opts = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
      } catch {
        continue;
      }
      if (!opts) continue;
      const title = opts.movie?.title || document.title;
      const thumbnail = opts.movie?.poster || '';
      const items = [];
      for (const v of opts.videos || []) {
        if (v.url && /^https?:/i.test(v.url)) {
          items.push({ kind: 'file', url: v.url, title, thumbnail, quality: v.name || '', mime: 'video/mp4', source: 'ok' });
        }
      }
      const hls = opts.hlsMasterPlaylistUrl || opts.hlsManifestUrl;
      if (hls) items.push({ kind: 'hls', url: hls, title, thumbnail, source: 'ok' });
      const fresh = items.filter((i) => !seen.has(i.url));
      fresh.forEach((i) => seen.add(i.url));
      if (fresh.length) browser.runtime.sendMessage({ type: 'site_media', items: fresh }).catch(() => {});
    }
  }

  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 800);
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
