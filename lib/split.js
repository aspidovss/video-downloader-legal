// Recordings and long downloads saved in parts (1.6.8): a part is closed when it reaches a size or a length,
// whichever comes first, and saved at once; the next one goes on without a gap. Pure helpers (tested in Node).

export const SPLIT_DEFAULTS = { splitLive: true, splitVideo: false, partMB: 2000, partMin: 60 };
export const PART_MB = { min: 50, max: 4000 };
export const PART_MIN = { min: 1, max: 720 };

const clamp = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };

// settings -> { live: { bytes, seconds } | null, video: { ... } | null }
export function splitPrefs(s = {}) {
  const lim = {
    bytes: clamp(s.partMB, PART_MB.min, PART_MB.max, SPLIT_DEFAULTS.partMB) * 1048576,
    seconds: clamp(s.partMin, PART_MIN.min, PART_MIN.max, SPLIT_DEFAULTS.partMin) * 60,
  };
  return {
    live: s.splitLive === false ? null : lim,
    video: s.splitVideo === true ? lim : null,
  };
}

// a part has reached its limit
export const partDue = (part, lim) => !!lim && ((part.bytes || 0) >= lim.bytes || (part.seconds || 0) >= lim.seconds);

// 3725 -> "01-02-05" (hours keep growing past 99)
export function partStamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}-${p(Math.floor(s / 60) % 60)}-${p(s % 60)}`;
}
export const partSuffix = (sec) => ` (${partStamp(sec)})`;

// "Stream 720p.mp4" + 3600 -> "Stream 720p (01-00-00).mp4"; ".audio.m4a" stays at the end
export function withPartSuffix(filename, sec) {
  const m = /^(.*?)((?:\.audio)?\.[a-z0-9]{1,5})$/i.exec(String(filename || ''));
  return m ? `${m[1]}${partSuffix(sec)}${m[2]}` : `${filename}${partSuffix(sec)}`;
}

// Long downloads (HLS / DASH, not live): where to cut, planned before the download from the segment lengths and
// the bitrate of each track (bits per second; 0 = unknown, then only the length counts).
// tracks: [{ durations: [seconds per media segment], bandwidth }] -> cut times in seconds (ascending), [] = one file
export function planCuts(tracks, lim) {
  if (!lim || !tracks.length) return [];
  const starts = tracks.map((t) => { let x = 0; return t.durations.map((d) => { const s = x; x += d || 0; return s; }); });
  if (starts.some((s, i) => s.length < 2 || tracks[i].durations.some((d) => !(d > 0)))) return [];
  const rate = tracks.reduce((n, t) => n + (Number(t.bandwidth) || 0), 0) / 8; // bytes per second, all tracks together
  const cuts = [];
  let from = 0;
  // candidate cut points: the starts of the first track's segments (other tracks cut at their nearest boundary)
  for (const t of starts[0]) {
    if (t <= from) continue;
    const len = t - from;
    if (len >= lim.seconds || (rate > 0 && len * rate >= lim.bytes)) { cuts.push(t); from = t; }
  }
  return cuts;
}

// parts of one track ({ init?: true, duration? } in order) -> one list per piece, the init part repeated in front of each
export function splitTrackParts(parts, cuts) {
  const groups = [[]];
  const inits = [];
  let t = 0;
  let k = 0;
  for (const p of parts) {
    if (p.init) { inits.push(p); groups[groups.length - 1].push(p); continue; }
    while (k < cuts.length && t >= cuts[k] - 0.001) {
      k++;
      groups.push(inits.length ? [inits[inits.length - 1]] : []);
    }
    groups[groups.length - 1].push(p);
    t += p.duration || 0;
  }
  while (groups.length < cuts.length + 1) groups.push(inits.length ? [inits[inits.length - 1]] : []);
  return groups;
}
