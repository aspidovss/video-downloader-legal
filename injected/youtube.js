// Isolated-world relay between the page-world scripts (youtube_main.js, youtube_rec.js)
// and the extension background.
(() => {
  const apiWait = new Map();
  let lastStart = {};
  let apiSeq = 0;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.payload !== 'string') return;
    let data;
    try { data = JSON.parse(e.data.payload); } catch { return; }
    if (e.data.__vdl === 'yt') browser.runtime.sendMessage({ type: 'yt_player', data, top: window.top === window }).catch(() => {});
    else if (e.data.__vdl === 'api-res' || e.data.__vdl === 'live-res') { const w = apiWait.get(data.id); if (w) { apiWait.delete(data.id); w(data); } }
    else if (e.data.__vdl === 'rec-reload' && window.top === window) {
      try { sessionStorage.setItem('vdlRec', JSON.stringify({ speed: 1, maxMB: lastStart.maxMB, live: true, maxMin: lastStart.maxMin, at: Date.now() })); } catch { /* ignore */ }
      location.reload();
    } else if (e.data.__vdl === 'rec-status' && window.top === window) browser.runtime.sendMessage({ type: 'yt_rec_status', state: data }).catch(() => {});
  });

  // Commands from the popup (via the background): arm + reload, save, cancel.
  browser.runtime.onMessage.addListener((msg) => {
    // Method 2: ask the page-world script to make the /player request from inside the page.
    if (msg && msg.type === 'yt_page_api' && window.top === window) {
      return new Promise((resolve) => {
        const id = ++apiSeq;
        const timer = setTimeout(() => { apiWait.delete(id); resolve({ id, session: 'err:timeout', results: [] }); }, 60000);
        apiWait.set(id, (res) => { clearTimeout(timer); resolve(res); });
        window.postMessage({ __vdl: 'api-cmd', id, videoId: msg.videoId, clients: msg.clients }, window.location.origin);
      });
    }
    if (msg && msg.type === 'yt_live_test' && window.top === window) {
      return new Promise((resolve) => {
        const id = ++apiSeq;
        const timer = setTimeout(() => { apiWait.delete(id); resolve({ id, steps: ['timeout'] }); }, 30000);
        apiWait.set(id, (res) => { clearTimeout(timer); resolve(res); });
        window.postMessage({ __vdl: 'live-cmd', id, url: msg.url }, window.location.origin);
      });
    }
    if (!msg || msg.type !== 'yt_rec_cmd' || window.top !== window) return undefined;
    if (msg.cmd === 'start' && msg.live) {
      lastStart = { maxMB: msg.maxMB, maxMin: msg.maxMin };
      window.postMessage({ __vdl: 'rec-cmd', cmd: 'start', live: true, maxMB: msg.maxMB, maxMin: msg.maxMin }, window.location.origin);
    } else if (msg.cmd === 'start') {
      try { sessionStorage.setItem('vdlRec', JSON.stringify({ speed: msg.speed, maxMB: msg.maxMB, live: !!msg.live, maxMin: msg.maxMin, at: Date.now() })); } catch { /* ignore */ }
      // a link with a start time (t=, start=) would begin in the middle of the video: reload without it
      try {
        const u = new URL(location.href);
        const had = ['t', 'start', 'time_continue'].filter((k) => u.searchParams.has(k));
        if (had.length) { had.forEach((k) => u.searchParams.delete(k)); location.replace(u.href); } else location.reload();
      } catch { location.reload(); }
    } else {
      window.postMessage({ __vdl: 'rec-cmd', cmd: msg.cmd, names: msg.names, only: msg.only }, window.location.origin);
    }
    return Promise.resolve({ ok: true });
  });
})();
