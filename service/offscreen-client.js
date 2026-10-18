// Firefox package: stub. The Chrome-only offscreen document is never used here (service/main.js calls these
// functions only when IS_CHROME is true). The Chrome build replaces this file with platform/offscreen-client.js
// (see scripts/build-chrome.mjs), so the Firefox package contains no `chrome.offscreen` code at all.
const chromeOnly = () => Promise.reject(new Error('chrome_only'));

export const chromeBlobUrl = chromeOnly;
export const chromeRevoke = chromeOnly;
export const chromeMp3 = chromeOnly;
export const chromeGif = chromeOnly;
