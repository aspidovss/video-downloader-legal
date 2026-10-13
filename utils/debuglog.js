// Debug log in browser.storage.local (opt-in: settings.debugLog). Written by the background,
// read / cleared by the options page. Nothing is ever sent anywhere by itself.
import { LOG_KEY, makeEntry, trimLog } from '../lib/debuglog.js';

let enabled = false;
let full = false;
let queue = [];
let timer = null;
let chain = Promise.resolve();

export function configureLog(s) {
  enabled = !!(s && s.debugLog);
  full = !!(s && s.diagFullUrls);
}

export function logEnabled() { return enabled; }

export function dlog(tag, msg, data) {
  if (!enabled) return;
  try { queue.push(makeEntry(tag, msg, data, full)); } catch { return; }
  if (!timer) timer = setTimeout(flushLog, 300);
}

export function flushLog() {
  clearTimeout(timer);
  timer = null;
  const batch = queue;
  queue = [];
  if (!batch.length) return chain;
  chain = chain.then(async () => {
    try {
      const cur = (await browser.storage.local.get(LOG_KEY))[LOG_KEY];
      await browser.storage.local.set({ [LOG_KEY]: trimLog([...(Array.isArray(cur) ? cur : []), ...batch]) });
    } catch { /* storage unavailable: the entries are dropped */ }
  });
  return chain;
}

export async function readLog() {
  try {
    const cur = (await browser.storage.local.get(LOG_KEY))[LOG_KEY];
    return Array.isArray(cur) ? cur : [];
  } catch { return []; }
}

export async function clearLog() {
  queue = [];
  clearTimeout(timer);
  timer = null;
  await chain;
  try { await browser.storage.local.remove(LOG_KEY); } catch { /* ignore */ }
}
