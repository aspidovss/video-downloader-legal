// Settings + history stored in browser.storage.local (works in background, popup and options).

export const DEFAULTS = {
  notifications: true,
  history: true,
  template: '{title} {site} {date}',
  minSizeKB: 150,      // 1.6.0dev6: back to 150 KB (10 KB since 1.5.5dev7 showed too many small files)
  concurrency: 4,
  maxStreamMB: 4096,
  liveMaxMinutes: 180, // 1.5.1: limit of one live recording
  saveAs: false,
  joinFormat: 'mp4',   // 1.6.0dev6: video + audio of different containers are joined into 'mp4' (Telegram sends it as a video) or 'mkv'
  tsToMp4: true,       // 1.5.2: TS streams are saved as MP4 (no re-encoding); kept for older settings
  gifMake: 'joyreactor', // 1.6.4: GIF made from a video file in the browser: 'joyreactor' (only there) | 'all' | 'off'
  updateCheck: true,   // 1.6.4: updater package (Chrome / Edge) only: look at the latest GitHub release once a day
  tsFormat: '',        // 1.6.4: TS streams are saved as 'mp4' | 'mkv' | 'ts'; '' = from tsToMp4 (MP4 unless it was switched off)
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
  subs: true,          // 1.6.1: YouTube subtitles on/off (off: no row in the card, nothing is looked up or saved)
  subsWithVideo: false, // 1.6.0dev5: YouTube subtitles saved with the video (embedded into .webm, else a .srt next to it)
  subsSrt: true,       // 1.6.1: the "SRT" button (subtitles only) in the card
  hotkeys: true,       // 1.6.0dev2: keyboard shortcuts on/off (the shortcuts themselves are set below)
  hkExecute: 'Alt+Up',    // open the popup
  hkVideo: 'Alt+Down',    // download the first video
  hkAudio: 'Alt+Shift+Down', // download the audio of the first media
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
