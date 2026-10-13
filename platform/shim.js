// Chrome compatibility: gives extension code the Firefox-style `browser` namespace.
// Chrome MV3 already returns promises from chrome.* calls; the one real difference is that an
// onMessage listener may not answer by returning a Promise, so those listeners are wrapped.
// Plain script (no import/export): the Chrome manifest lists it first for content scripts and
// the extension pages, and the service worker imports it first. Does nothing in Firefox.
(() => {
  const g = globalThis;
  if (typeof g.browser !== 'undefined' || !g.chrome || !g.chrome.runtime) return;
  const wrapped = new WeakMap();
  const onMessage = {
    addListener(fn) {
      const w = (msg, sender, sendResponse) => {
        let r;
        try { r = fn(msg, sender); } catch (e) { sendResponse({ error: String((e && e.message) || e) }); return false; }
        if (r && typeof r.then === 'function') {
          r.then((v) => sendResponse(v), (e) => sendResponse({ error: String((e && e.message) || e) }));
          return true; // keep the channel open for the async answer
        }
        return false;
      };
      wrapped.set(fn, w);
      g.chrome.runtime.onMessage.addListener(w);
    },
    removeListener(fn) { const w = wrapped.get(fn); if (w) g.chrome.runtime.onMessage.removeListener(w); },
    hasListener(fn) { const w = wrapped.get(fn); return !!w && g.chrome.runtime.onMessage.hasListener(w); },
  };
  const runtime = new Proxy(g.chrome.runtime, {
    get(t, k) {
      if (k === 'onMessage') return onMessage;
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  g.browser = new Proxy(g.chrome, { get(t, k) { return k === 'runtime' ? runtime : t[k]; } });
})();
