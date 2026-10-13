// Request-header state for requests made by the extension itself (YouTube client User-Agent,
// Origin/Referer for googlevideo, live HLS). Firefox applies it in blocking webRequest listeners
// (service/main.js); Chrome MV3 has no blocking webRequest, so the same state is turned into
// declarativeNetRequest session rules (buildRules) and every fetch waits until they are in place.

const state = { ua: '', live: false, on: true };
let listener = null;

export const hdr = {
  get ua() { return state.ua; },
  set ua(v) { v = v || ''; if (v !== state.ua) { state.ua = v; listener?.(); } },
  get live() { return state.live; },
  set live(v) { v = !!v; if (v !== state.live) { state.live = v; listener?.(); } },
  get on() { return state.on; },
  set on(v) { v = !!v; if (v !== state.on) { state.on = v; listener?.(); } },
};

const YT = 'https://www.youtube.com';
const BILI_COM = ['bilivideo.com', 'bilivideo.cn', 'akamaized.net', 'hdslb.com'];
const BILI_TV = ['bilibili.tv', 'biliintl.com', 'bstarstatic.com'];
const TIKTOK = ['tiktok.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'ibytedtos.com', 'ibyteimg.com', 'byteimg.com'];
const TYPES = ['xmlhttprequest', 'other', 'media'];

const set = (header, value) => ({ header, operation: 'set', value });
const remove = (header) => ({ header, operation: 'remove' });

// Pure: state -> declarativeNetRequest rules. Only requests that belong to no tab (tabId -1),
// i.e. made by the extension, are touched; the page's own requests are never modified.
export function buildRules(s, initiator) {
  const rules = [];
  let id = 0;
  const add = (priority, condition, requestHeaders) => rules.push({
    id: ++id, priority,
    action: { type: 'modifyHeaders', requestHeaders },
    condition: { tabIds: [-1], resourceTypes: TYPES, ...(initiator ? { initiatorDomains: [initiator] } : {}), ...condition },
  });

  // session bootstrap with the browser's own UA, Referer https://www.youtube.com/sw.js
  add(3, { urlFilter: '||www.youtube.com/sw.js_data' }, [remove('origin'), set('referer', `${YT}/sw.js`)]);

  if (s.ua) {
    add(2, { urlFilter: '||www.youtube.com/youtubei/' }, [set('user-agent', s.ua), set('origin', YT), set('referer', `${YT}/`)]);
    add(2, { urlFilter: '||googlevideo.com^' }, s.on
      ? [set('user-agent', s.ua), set('origin', YT), set('referer', `${YT}/`), set('dnt', '1')]
      : [set('user-agent', s.ua), remove('origin')]);
  } else if (s.live) {
    add(2, { urlFilter: '||googlevideo.com^' }, [set('origin', YT), set('referer', `${YT}/`)]);
  }

  // Bilibili: video servers and API want the site as Referer
  add(1, { requestDomains: BILI_COM }, [remove('origin'), set('referer', 'https://www.bilibili.com/')]);
  add(1, { requestDomains: ['api.bilibili.com'] }, [set('origin', 'https://www.bilibili.com'), set('referer', 'https://www.bilibili.com/')]);
  add(1, { requestDomains: BILI_TV }, [remove('origin'), set('referer', 'https://www.bilibili.tv/')]);
  add(2, { requestDomains: ['api.bilibili.tv', 'api.biliintl.com'] }, [set('origin', 'https://www.bilibili.tv'), set('referer', 'https://www.bilibili.tv/')]);

  // TikTok: the video servers refuse requests without the site as Referer
  add(1, { requestDomains: TIKTOK }, [remove('origin'), set('referer', 'https://www.tiktok.com/')]);
  return rules;
}

// Chrome only: keeps the session rules in sync with `hdr` and makes fetch wait for the update.
export function installChromeRules(chromeApi = globalThis.chrome, initiator = chromeApi?.runtime?.id) {
  const dnr = chromeApi?.declarativeNetRequest;
  if (!dnr) return false;
  let applied = [];
  let pending = Promise.resolve();
  const apply = () => {
    pending = pending.then(async () => {
      const addRules = buildRules(state, initiator);
      await dnr.updateSessionRules({ removeRuleIds: applied, addRules });
      applied = addRules.map((r) => r.id);
    }).catch(() => { /* rules unavailable: API calls may be refused, recording still works */ });
    return pending;
  };
  listener = apply;
  apply();
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (...args) => { await pending; return realFetch(...args); };
  return true;
}
