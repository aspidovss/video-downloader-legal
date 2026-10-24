// Where and for which videos a GIF made from the video is offered (1.6.5): the settings' GIF block.
// Pure functions; used by the background (service/main.js) and the options page (checking the expressions).

export const GIF_LIMIT_SECONDS = 180; // the longest video a GIF is ever made from (memory and time)
export const GIF_SIZES = [640, 480, 320, 240];
export const GIF_FPS = [5, 8, 10, 12, 15];
export const GIF_DEFAULTS = { gifEnabled: true, gifMaxSec: 60, gifSites: '', gifExclude: '', gifWidth: 480, gifFps: 10 };

// "one expression per line" -> { list: [RegExp], errors: [{ line, text, message }] }; empty lines and "# notes" are skipped
export function parsePatterns(text) {
  const list = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const s = raw.trim();
    if (!s || s.startsWith('#')) return;
    if (s.length > 300) { errors.push({ line: i + 1, text: s.slice(0, 40), message: 'too long' }); return; }
    try { list.push(new RegExp(s, 'i')); } catch (e) { errors.push({ line: i + 1, text: s, message: String(e?.message || e) }); }
  });
  return { list, errors };
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

// Is the GIF offered for a video on this page? Page host first; the video's own host as the second chance.
// Expressions with an error are left out (one typo must not switch every rule off).
export function gifSiteAllowed(pageUrl, videoUrl, sitesText, excludeText) {
  const hosts = [hostOf(pageUrl), hostOf(videoUrl)].filter(Boolean);
  if (!hosts.length) return false;
  const only = parsePatterns(sitesText).list;
  const not = parsePatterns(excludeText).list;
  if (not.length && hosts.some((h) => not.some((r) => r.test(h)))) return false;
  if (!only.length) return true;
  return hosts.some((h) => only.some((r) => r.test(h)));
}

// settings -> clean values
export function gifPrefs(s = {}) {
  const max = Math.round(Number(s.gifMaxSec));
  const width = Number(s.gifWidth);
  const fps = Number(s.gifFps);
  return {
    enabled: s.gifEnabled !== false,
    maxSec: Math.min(GIF_LIMIT_SECONDS, Math.max(1, Number.isFinite(max) && max > 0 ? max : GIF_DEFAULTS.gifMaxSec)),
    sizes: GIF_SIZES.slice(), // the card offers every width (1.6.5)
    width: GIF_SIZES.includes(width) ? width : GIF_DEFAULTS.gifWidth, // the one chosen at first
    fps: GIF_FPS.includes(fps) ? fps : GIF_DEFAULTS.gifFps,
    sites: String(s.gifSites || ''),
    exclude: String(s.gifExclude || ''),
  };
}
