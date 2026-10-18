// Updater package only (scripts/build-chrome.mjs --updater): looks at the latest GitHub release at most once a day
// when the service worker wakes up, and on request from the settings page ("Check now").
// The result is kept in storage.local.vdlUpdate; the popup shows a line when a newer version is out.
import { UPDATE_API, UPDATE_EVERY_MS, releaseInfo, isEdge } from '../lib/updatecheck.js';

const current = chrome.runtime.getManifest().version;

async function enabled() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings?.updateCheck !== false;
}

export async function checkNow() {
  const at = Date.now();
  try {
    const r = await fetch(UPDATE_API, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const info = releaseInfo(await r.json(), current, isEdge());
    if (!info) throw new Error('no release');
    const { vdlUpdate: old } = await chrome.storage.local.get('vdlUpdate');
    const state = { ...info, current, checkedAt: at, error: '', dismissed: old?.dismissed === info.version ? old.dismissed : '' };
    await chrome.storage.local.set({ vdlUpdate: state });
    return state;
  } catch (e) {
    const { vdlUpdate: old } = await chrome.storage.local.get('vdlUpdate');
    const state = { ...(old || {}), current, checkedAt: at, error: String(e?.message || e) };
    await chrome.storage.local.set({ vdlUpdate: state });
    return state;
  }
}

async function maybeCheck() {
  if (!(await enabled())) return;
  const { vdlUpdate } = await chrome.storage.local.get('vdlUpdate');
  if (vdlUpdate?.current === current && Date.now() - (vdlUpdate?.checkedAt || 0) < UPDATE_EVERY_MS) return;
  await checkNow();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'vdl_update_check') return false;
  checkNow().then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});
maybeCheck().catch(() => {});
