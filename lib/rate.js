// Download speed and remaining time of a job (1.6.4): a rolling window of progress samples.
// Speed is bytes per second over the last few seconds; the remaining time comes from the
// pace of finished parts (segments or 4 MB ranges), which works without knowing the total size.

export function makeRate({ windowMs = 5000, minSpanMs = 1500, now = () => Date.now() } = {}) {
  let samples = [];
  const api = {
    reset() { samples = [{ t: now(), bytes: 0, done: 0 }]; },
    add(bytes, done) {
      const last = samples[samples.length - 1];
      // a new pass (a retry or the next file) starts counting again from zero
      if (!last || bytes < last.bytes || done < last.done) api.reset();
      const t = now();
      samples.push({ t, bytes, done });
      while (samples.length > 2 && samples[1].t <= t - windowMs) samples.shift();
    },
    span() {
      if (samples.length < 2) return 0;
      return samples[samples.length - 1].t - samples[0].t;
    },
    // bytes per second, or 0 while there is not enough to measure
    speed() {
      const span = api.span();
      if (span < minSpanMs) return 0;
      const a = samples[0], b = samples[samples.length - 1];
      return Math.max(0, ((b.bytes - a.bytes) * 1000) / span);
    },
    // seconds left for `total` parts, or 0 while there is not enough to measure
    eta(total) {
      const span = api.span();
      if (span < minSpanMs) return 0;
      const a = samples[0], b = samples[samples.length - 1];
      const perSec = ((b.done - a.done) * 1000) / span;
      if (!(perSec > 0)) return 0;
      return Math.max(1, Math.round((total - b.done) / perSec));
    },
  };
  api.reset();
  return api;
}

// "~45 s", "~3 min", "~1 h 20 min" with localized unit words
export function etaText(sec, units = { s: 's', min: 'min', h: 'h' }) {
  if (!(sec > 0)) return '';
  if (sec < 60) return `~${Math.max(5, Math.ceil(sec / 5) * 5)} ${units.s}`;
  const m = Math.round(sec / 60);
  if (m < 60) return `~${m} ${units.min}`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `~${hh} ${units.h} ${mm} ${units.min}` : `~${hh} ${units.h}`;
}
