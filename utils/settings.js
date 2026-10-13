// Settings + history stored in browser.storage.local (works in background, popup and options).

export const DEFAULTS = {
  notifications: true,
  history: true,
  template: '{title} {site} {date}',
  minSizeKB: 10,
  concurrency: 4,
  maxStreamMB: 4096,
  liveMaxMinutes: 180, // 1.5.1: limit of one live recording
  saveAs: false,
  tsToMp4: true,       // 1.5.2: TS streams are saved as MP4 (no re-encoding)
  ytCcOnly: true,
  ytRecordSpeed: 2,
  ytApi: true,
  ytMethod: 'auto',
  defaultQuality: 'best',
  diagFullUrls: false,
  debugLog: false,     // write a debug log (options > Diagnostics); off by default
  defaultType: 'auto',
  defaultAudioFormat: 'mp3',
  defaultAudioQuality: 'best',
  ytClients: 'VISIONOS,ANDROID_VR,IOS,IOS_VDL',
  ytClientOverrides: '',
  ytSequential: true,  // 1.4.3: one request at a time
  ytCpn: true,         // 1.4.3: add cpn to googlevideo URLs
  ytHeaders: true,     // 1.4.3: Origin/Referer/DNT on googlevideo requests
  ytRecordUi: false,   // 1.5.5dev2: show "record from the player" for YouTube videos (live streams always offer it)
  uiLang: 'auto',      // 1.5.5dev2: 'auto' = browser language, or a locale code
};

export async function getSettings() {
  try {
    const { settings } = await browser.storage.local.get('settings');
    return { ...DEFAULTS, ...(settings || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}

const HISTORY_MAX = 300;

export async function getHistory() {
  const { history } = await browser.storage.local.get('history');
  return Array.isArray(history) ? history : [];
}

export async function addHistory(rec) {
  const list = await getHistory();
  list.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), ...rec });
  await browser.storage.local.set({ history: list.slice(0, HISTORY_MAX) });
}

export async function removeHistory(id) {
  const list = (await getHistory()).filter((h) => h.id !== id);
  await browser.storage.local.set({ history: list });
}

export async function clearHistory() {
  await browser.storage.local.set({ history: [] });
}
