// Why YouTube did not give a video: one code the popup can explain in plain words, and whether the
// "record while playing" fallback can help. Works on what the extension already has (the page's player data,
// the API answers, download errors, the download test); nothing extra is requested.
// Status codes come first; the reason text (English or the account's language: en + ru are recognised) only
// when the codes are not enough.

const RX = {
  age: /confirm your age|age[- ]restricted|inappropriate for some users|подтвердите (?:свой )?возраст|неприемлем\w* для некоторых|ограничени\w* по возрасту/i,
  bot: /not a bot|confirm you.?re not a robot|не робот|не бот/i,
  private: /private video|video is private|частное видео|видео с ограниченным доступом/i,
  members: /members[- ]only|join this channel|channel members|спонсор/i,
  region: /not (?:made )?(?:this video )?available in your country|in your country|в вашей стране|в вашем регионе/i,
  paid: /purchase|payment|rent(?:al)?\b|buy |купит|аренд|платн|оплат/i,
  removed: /removed|no longer available|terminated|does not exist|isn.?t available|unavailable|удален|удалён|недоступн|не существует/i,
};

// input: { summary, logs: [{ status, playability, reason, error }], session, dlFailed, dlLimited, http429, iosOnly, testCut, apiDone }
// -> { code, reason, record: 'yes' | 'no' | 'maybe', busy: boolean }  (code '' = nothing to explain)
export function classifyYt(input) {
  const s = input?.summary || {};
  const logs = (input?.logs || []).filter(Boolean);
  const answers = [s, ...logs.map((l) => ({ status: l.playability, reason: l.reason }))].filter((a) => a.status || a.reason);
  const statuses = new Set(answers.map((a) => String(a.status || '')));
  const texts = answers.map((a) => `${a.reason || ''} ${a.subreason || ''}`).join(' \n ');
  const firstReason = (answers.find((a) => a.status && a.status !== 'OK' && a.reason) || {}).reason || '';
  const out = (code, record, busy = false) => ({ code, reason: String(firstReason).slice(0, 200), record, busy });
  const playable = s.status === 'OK' || (!s.status && logs.some((l) => l.playability === 'OK'));

  if (s.upcoming || statuses.has('LIVE_STREAM_OFFLINE')) return { ...out('upcoming', 'no'), startAt: Number(s.startAt) || 0 };
  if (s.paid || (!playable && RX.paid.test(texts))) return out('paid', 'no');
  if ((s.formats || []).length && s.formats.every((f) => f.drm)) return out('paid', 'no');
  if (statuses.has('CONTENT_CHECK_REQUIRED')) return out('contentCheck', 'no');
  if (statuses.has('AGE_CHECK_REQUIRED') || statuses.has('AGE_VERIFICATION_REQUIRED') || RX.age.test(texts) || (s.familySafe === false && statuses.has('LOGIN_REQUIRED'))) return out('age', 'yes');
  if (RX.bot.test(texts)) return out('bot', 'maybe', true);
  if (RX.private.test(texts)) return out('private', 'no');
  if (RX.members.test(texts)) return out('members', 'maybe');
  if (RX.region.test(texts)) return out('region', 'no');
  if (!playable && (statuses.has('ERROR') || RX.removed.test(texts))) return out('removed', 'no');
  if (!playable && (statuses.has('LOGIN_REQUIRED') || statuses.has('UNPLAYABLE'))) return out('unknown', 'maybe', true);

  // the page plays it, but no link came out of it
  if (input?.http429 || logs.some((l) => l.status === 429)) return out('rate', 'maybe', true);
  if (input?.testCut || input?.dlLimited || (input?.iosOnly && input?.dlFailed)) return out('cut', 'yes');
  const net = logs.length && logs.every((l) => !l.status && l.error) && /^(?:err|bad)/.test(String(input?.session || ''));
  if (net) return out('network', 'no');
  if (input?.apiDone && input?.noLinks && s.sabr) return out('sabr', 'yes');
  if (input?.apiDone && input?.noLinks) return out('unknown', 'yes', true);
  return out('', 'maybe');
}

// Start time of an upcoming stream for the message, in the browser's local time
export function startText(startAt, locale) {
  if (!startAt) return '';
  try { return new Date(startAt * 1000).toLocaleString(locale || undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; }
}
