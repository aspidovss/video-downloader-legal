// The accepted-terms flag lives in storage.local under its own key (not in `settings`, so saving
// the options form can never overwrite it). Nothing here leaves the browser.
import { isAccepted, newConsent } from '../lib/consent.js';

export async function getConsent() {
  try {
    const { consent } = await browser.storage.local.get('consent');
    return consent || null;
  } catch {
    return null;
  }
}

export async function hasConsent() {
  return isAccepted(await getConsent());
}

export async function acceptConsent() {
  const rec = newConsent();
  await browser.storage.local.set({ consent: rec });
  return rec;
}

export async function revokeConsent() {
  await browser.storage.local.remove('consent');
}
