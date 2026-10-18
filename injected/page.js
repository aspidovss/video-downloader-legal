// Generic page scanner: reports <video>/<audio>/<source> URLs and page metadata to the background.
(() => {
  if (window.__vdlPage) return;
  window.__vdlPage = true;

  const isTop = window.top === window;
  let timer = null;
  let lastUrl = location.href;
  let sentKey = '';

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

  // Every <video> of the page (also those playing from a blob:) with its cover and whether it is on screen:
  // in a feed of short videos this tells which detected playlist is the one being watched.
  function feed() {
    if (!isTop) return [];
    const vh = window.innerHeight || 0;
    const vw = window.innerWidth || 0;
    const out = [];
    for (const el of document.querySelectorAll('video')) {
      if (out.length >= 40) break;
      const r = el.getBoundingClientRect();
      const shown = r.width > 0 && r.height > 0 ? Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) / (r.width * r.height) : 0;
      const src = el.currentSrc || el.src || '';
      out.push({ poster: /^https?:/i.test(el.poster || '') ? el.poster : '', src: /^https?:/i.test(src) ? src : '', visible: shown >= 0.5, playing: !el.paused });
    }
    return out;
  }

  function report() {
    const videos = collect();
    const list = feed();
    const key = `${location.href}|${document.title}|${videos.map((v) => v.url).join(',')}|${list.map((v) => `${v.poster}${v.visible ? '+' : '-'}${v.playing ? 'p' : ''}`).join(',')}`;
    if (key === sentKey) return;
    sentKey = key;
    browser.runtime.sendMessage({
      type: 'page_info',
      top: isTop,
      url: location.href,
      title: isTop ? (meta('og:title') || document.title) : '',
      thumbnail: isTop ? meta('og:image') : '',
      videos,
      feed: list,
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

  for (const ev of ['loadedmetadata', 'play', 'pause', 'durationchange']) {
    document.addEventListener(ev, schedule, true);
  }
  window.addEventListener('scroll', schedule, { passive: true, capture: true });

  // Firefox for Android has no working downloads API: the background hands the finished file to this page, and it is
  // saved like any page download (an <a download> link to a blob: address).
  // The phone shows its "Download file?" dialog for this tab; started while the tab is hidden (the popup is on top),
  // the dialog can vanish at once. So a file waits until the tab is on screen again, then the next one 1.5 s later.
  if (isTop) {
    const queue = [];
    let busy = false;
    const saveNext = () => {
      if (busy || !queue.length || document.visibilityState !== 'visible') return;
      busy = true;
      const { blob, name } = queue.shift();
      try {
        const url = URL.createObjectURL(blob);
        // The link is clicked without being put into the page: single-page sites (m.youtube.com) catch clicks on links
        // in their document and open the address themselves (the video then opens in a new window, nothing is saved).
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.rel = 'noopener';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 600000);
      } catch { /* nothing more can be done here */ }
      setTimeout(() => { busy = false; saveNext(); }, 1500);
    };
    document.addEventListener('visibilitychange', () => setTimeout(saveNext, 400));
    window.addEventListener('focus', () => setTimeout(saveNext, 400));
    browser.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'vdl_save' || !(msg.blob instanceof Blob)) return undefined;
      queue.push({ blob: msg.blob, name: String(msg.name || 'video').slice(0, 200) });
      const waiting = document.visibilityState !== 'visible';
      setTimeout(saveNext, waiting ? 0 : 300);
      return Promise.resolve({ ok: true, waiting });
    });
  }
  schedule();
})();
