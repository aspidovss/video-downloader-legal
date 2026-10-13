// Generic page scanner: reports <video>/<audio>/<source> URLs and page metadata to the background.
(() => {
  if (window.__vdlPage) return;
  window.__vdlPage = true;

  const isTop = window.top === window;
  let timer = null;
  let lastUrl = location.href;
  const sentKey = new Set();

  function meta(name, attr = 'property') {
    return document.querySelector(`meta[${attr}="${name}"]`)?.content || '';
  }

  function collect() {
    const out = [];
    const add = (url, el) => {
      if (!url || !/^https?:/i.test(url)) return; // blob:/data: cannot be downloaded directly
      out.push({
        url,
        poster: el.poster || '',
        duration: Number.isFinite(el.duration) ? el.duration : 0,
      });
    };
    for (const el of document.querySelectorAll('video, audio')) {
      add(el.currentSrc || el.src, el);
      for (const s of el.querySelectorAll('source')) add(s.src, el);
    }
    return out;
  }

  function report() {
    const videos = collect();
    const key = `${location.href}|${document.title}|${videos.map((v) => v.url).join(',')}`;
    if (sentKey.has(key)) return;
    sentKey.add(key);
    browser.runtime.sendMessage({
      type: 'page_info',
      top: isTop,
      url: location.href,
      title: isTop ? (meta('og:title') || document.title) : '',
      thumbnail: isTop ? meta('og:image') : '',
      videos,
    }).catch(() => {});
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(report, 700);
  }

  new MutationObserver(() => {
    if (location.href !== lastUrl) lastUrl = location.href; // SPA navigation
    schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });

  for (const ev of ['loadedmetadata', 'play', 'durationchange']) {
    document.addEventListener(ev, schedule, true);
  }
  schedule();
})();
