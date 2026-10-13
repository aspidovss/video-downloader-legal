// Which runtime we are in. The Chrome build runs the background as a service worker
// (no DOM, no URL.createObjectURL, no blocking webRequest); Firefox keeps an event page.
export const IS_CHROME = typeof globalThis.chrome !== 'undefined' && !!globalThis.chrome.offscreen && typeof globalThis.document === 'undefined';
