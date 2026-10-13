import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSENT_VERSION, isAccepted, newConsent } from '../lib/consent.js';

test('consent: only a current, dated record counts as accepted', () => {
  assert.equal(isAccepted(null), false);
  assert.equal(isAccepted({}), false);
  assert.equal(isAccepted({ version: CONSENT_VERSION }), false); // no date
  assert.equal(isAccepted({ version: CONSENT_VERSION - 1, acceptedAt: 1 }), false); // older wording
  assert.equal(isAccepted({ version: 'x', acceptedAt: 1 }), false);
  assert.equal(isAccepted(newConsent(1760000000000)), true);
  assert.equal(isAccepted({ version: CONSENT_VERSION + 1, acceptedAt: 5 }), true); // newer is fine
  assert.deepEqual(newConsent(5), { version: CONSENT_VERSION, acceptedAt: 5 });
});

test('default file name template is pre-filled: title, site, date', async () => {
  const { DEFAULTS } = await import('../utils/settings.js');
  const { buildFilename } = await import('../lib/util.js');
  assert.equal(DEFAULTS.template, '{title} {site} {date}');
  assert.equal(DEFAULTS.minSizeKB, 10);
  assert.equal(buildFilename(DEFAULTS.template, { title: 'Clip', site: 'a.com', ext: 'mp4', date: new Date(2026, 9, 13) }), 'Clip a.com 2026-10-13.mp4');
});

test('Creative Commons only is on by default', async () => {
  const { DEFAULTS } = await import('../utils/settings.js');
  assert.equal(DEFAULTS.ytCcOnly, true);
});
