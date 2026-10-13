// X / Twitter (isolated content script). On the timeline many videos are loaded at once, so the generic network
// sniffing lists all of them. This script only tells the background WHICH media belongs to which tweet and which
// videos are on screen / playing right now (read from the page's own <video> and tweet link elements).
(() => {
  const isTest = typeof module !== 'undefined' && module.exports;

  // media id used in the video addresses: .../amplify_video/<id>/... or .../tweet_video/<name>.mp4 (GIF)
  function mediaIdFrom(s) {
    const t = String(s || '');
    let m = t.match(/(?:amplify_video_thumb|amplify_video|ext_tw_video_thumb|ext_tw_video)\/(\d+)\//);
    if (m) return m[1];
    m = t.match(/(?:tweet_video_thumb|tweet_video)\/([\w-]+)\.(?:jpg|png|mp4)/);
    return m ? m[1] : '';
  }
  function parseTweetHref(href) {
    const m = String(href || '').match(/^(?:https?:\/\/[^/]+)?\/([^/?#]+)\/status\/(\d+)/);
    return m ? { author: m[1], tweetId: m[2] } : null;
  }

  if (isTest) { module.exports = { mediaIdFrom, parseTweetHref }; return; }
  if (window.top !== window) return;

  let last = '';
  function scan() {
    const list = [];
    for (const art of document.querySelectorAll('article')) {
      const a = art.querySelector('time')?.closest('a');
      const tw = parseTweetHref(a && a.getAttribute('href')) || parseTweetHref(location.pathname);
      for (const v of art.querySelectorAll('video')) {
        const id = mediaIdFrom(v.getAttribute('poster')) || mediaIdFrom(v.currentSrc || v.src);
        if (!id) continue;
        const r = v.getBoundingClientRect();
        const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        const visible = r.height > 0 && h / r.height > 0.5;
        list.push({ id, author: tw?.author || '', tweetId: tw?.tweetId || '', visible: visible || (!v.paused && !v.ended) });
      }
    }
    const key = JSON.stringify(list);
    if (key === last) return;
    last = key;
    try { browser.runtime.sendMessage({ type: 'x_media', list }); } catch { /* background asleep */ }
  }
  setInterval(scan, 800);
})();
