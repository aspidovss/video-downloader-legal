// TikTok (page world). The player uses blob: addresses, so the file cannot be matched by the <video> address.
// The page's own components hold the data of every video (id, author, caption, cover, file addresses): read it from the
// element that shows the video (React fiber) and report it to the isolated script (injected/tiktok.js) via postMessage.
(() => {
  if (window.__vdlTtMain || window.top !== window) return;
  window.__vdlTtMain = true;

  const pathKey = (u) => { try { return new URL(u).pathname.replace(/\/+$/, ''); } catch { return ''; } };
  const text = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const looksItem = (o) => !!o && typeof o === 'object' && typeof o.id === 'string' && /^\d{8,}$/.test(o.id) && (!!o.video || o.desc !== undefined || !!o.author);

  function fiberOf(el) {
    for (const k in el) if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return el[k];
    return null;
  }
  // Walk the component tree upwards from an element: the player component holds { id, desc, playUrl, bitrateInfo ... },
  // a component higher up may hold the whole item ({ id, author, video: {...} }). Collect both.
  function collectFromFiber(el, acc) {
    let f = fiberOf(el);
    for (let d = 0; f && d < 40; d++, f = f.return) {
      for (const p of [f.memoizedProps, f.pendingProps]) {
        if (!p || typeof p !== 'object') continue;
        const cands = [p.item, p, p.itemInfo && p.itemInfo.itemStruct];
        let n = 0;
        for (const v of Object.values(p)) { cands.push(v); if (++n > 14) break; }
        for (const c of cands) {
          if (!looksItem(c)) continue;
          if (c.video && c.author) { if (!acc.full) acc.full = c; } else if (!acc.partial) acc.partial = c;
        }
      }
      if (acc.full) return;
    }
  }
  function findItem(v) {
    const acc = { full: null, partial: null };
    let el = v;
    for (let i = 0; i < 10 && el && !acc.full; i++, el = el.parentElement) collectFromFiber(el, acc);
    try { // single video page: the page data
      const m = location.pathname.match(/\/video\/(\d+)/);
      const st = window.__$UNIVERSAL_DATA$__?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (m && st && String(st.id) === m[1] && !acc.full) acc.full = st;
    } catch { /* no page data */ }
    if (!acc.full && !acc.partial) return null;
    const out = { ...(acc.partial || {}), ...(acc.full || {}) };
    if (acc.partial && acc.full && String(acc.partial.id) !== String(acc.full.id)) return acc.partial; // not the same video: do not mix
    return out;
  }
  function linkInfo(v) { // fallback: the author / id from the link next to the video
    let el = v;
    for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
      const a = el.querySelector && el.querySelector('a[href*="/video/"]');
      const m = a && String(a.getAttribute('href')).match(/\/@([^/?#]+)\/video\/(\d+)/);
      if (m) {
        const d = el.querySelector('[data-e2e$="video-desc"], [data-e2e="browse-video-desc"]');
        return { author: decodeURIComponent(m[1]), id: m[2], desc: text(d) };
      }
    }
    const m = location.pathname.match(/\/@([^/?#]+)\/video\/(\d+)/);
    return m ? { author: decodeURIComponent(m[1]), id: m[2], desc: text(document.querySelector('[data-e2e="browse-video-desc"]')) } : null;
  }

  function addrs(item) {
    const v = item.video || {};
    const out = [];
    const sizes = [];
    const add = (u) => {
      if (typeof u === 'string') { if (/^https?:/.test(u)) out.push(u); return; }
      if (u && typeof u === 'object') {
        for (const x of [...(u.UrlList || []), ...(u.urlList || []), ...(u.url_list || [])]) add(x);
        const n = Number(u.DataSize || u.dataSize || 0);
        if (n > 0) sizes.push(n);
      }
    };
    for (const o of [v, item]) {
      add(o.playAddr); add(o.playUrl); add(o.downloadAddr); add(o.PlayAddrStruct);
      for (const b of o.bitrateInfo || []) { add(b && (b.PlayAddr || b.playAddr)); if (b && Number(b.DataSize) > 0) sizes.push(Number(b.DataSize)); }
    }
    if (Number(v.size) > 0) sizes.push(Number(v.size));
    return { keys: [...new Set(out.map(pathKey).filter(Boolean))].slice(0, 12), sizes: [...new Set(sizes)].slice(0, 12) };
  }
  function domAuthor(v) {
    let el = v;
    for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
      const u = el.querySelector && el.querySelector('[data-e2e="video-author-uniqueid"], [data-e2e="browse-username"], [data-e2e="feed-video-nickname"], a[href^="/@"]');
      if (u) {
        const h = u.getAttribute && u.getAttribute('href');
        const m = h && String(h).match(/\/@([^/?#]+)/);
        return m ? decodeURIComponent(m[1]) : text(u).replace(/^@/, '');
      }
    }
    return '';
  }
  function domDesc(v) {
    let el = v;
    for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
      const d = el.querySelector && el.querySelector('[data-e2e$="video-desc"], [data-e2e="browse-video-desc"]');
      if (d) return text(d);
    }
    return '';
  }
  function domPoster(v) { // the biggest picture next to the player (cover shown before the video starts)
    let el = v;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      let best = 0;
      let src = '';
      for (const im of el.querySelectorAll ? el.querySelectorAll('img[src^="http"]') : []) {
        const area = (im.naturalWidth || 0) * (im.naturalHeight || 0);
        if (area > best && area >= 20000) { best = area; src = im.currentSrc || im.src; }
      }
      if (src) return src;
    }
    return '';
  }

  const dbg = { videos: 0, blob: 0, http: 0, fiber: 0, link: 0, none: 0, shapes: '' };
  let last = '';
  function scan() {
    const list = [];
    dbg.videos = dbg.blob = dbg.http = dbg.fiber = dbg.link = dbg.none = 0;
    for (const v of document.querySelectorAll('video')) {
      dbg.videos++;
      const src = v.currentSrc || v.src || '';
      if (/^blob:/.test(src)) dbg.blob++; else if (/^https?:/.test(src)) dbg.http++;
      const r = v.getBoundingClientRect();
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const visible = r.height > 0 && h / r.height > 0.5;
      const e = { visible, keys: [], sizes: [], id: '', author: '', desc: '', poster: '', duration: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0 };
      if (/^https?:/.test(src)) e.keys.push(pathKey(src));
      const item = findItem(v);
      if (item) {
        dbg.fiber++;
        const a = addrs(item);
        e.keys.push(...a.keys);
        e.sizes = a.sizes;
        e.id = String(item.id);
        e.author = String((item.author && (item.author.uniqueId || item.author.nickname)) || (typeof item.author === 'string' ? item.author : '') || '');
        e.desc = String(item.desc || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const c = (item.video && (item.video.cover || item.video.originCover || item.video.dynamicCover)) || item.cover || item.poster || item.originCover || item.posterUrl;
        e.poster = typeof c === 'string' && /^https:/.test(c) ? c : '';
        if (!dbg.shapes) dbg.shapes = `${Object.keys(item).slice(0, 40).join(',')}|${Object.keys(item.video || {}).slice(0, 20).join(',')}|a:${a.keys.length} s:${a.sizes.length}`;
      } else {
        const li = linkInfo(v);
        if (li) { dbg.link++; Object.assign(e, li); } else dbg.none++;
      }
      // what the page elements show (works when the data objects do not carry it)
      if (!e.author) e.author = domAuthor(v);
      if (!e.desc) e.desc = domDesc(v);
      if (!e.poster) e.poster = /^https?:/.test(v.poster || '') ? v.poster : domPoster(v);
      if (!e.id) { const li = linkInfo(v); if (li) e.id = li.id; }
      e.keys = [...new Set(e.keys)];
      list.push(e);
    }
    const key = JSON.stringify([list, dbg]);
    if (key === last) return;
    last = key;
    window.postMessage({ __vdlTt: 1, list, dbg: { ...dbg }, url: location.href }, location.origin);
  }
  setInterval(scan, 800);
})();
