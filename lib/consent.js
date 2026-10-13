// Terms-of-use consent (1.5.5dev2). Pure helpers; storage lives in utils/consent.js.
// Bump CONSENT_VERSION when the wording changes: everybody is asked again.
export const CONSENT_VERSION = 1;

export function isAccepted(rec) {
  return !!rec && typeof rec === 'object' && Number(rec.version) >= CONSENT_VERSION && Number.isFinite(Number(rec.acceptedAt)) && Number(rec.acceptedAt) > 0;
}

export function newConsent(now = Date.now()) {
  return { version: CONSENT_VERSION, acceptedAt: now };
}
