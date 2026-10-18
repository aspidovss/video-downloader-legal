// JoyReactor (joyreactor.com / .cc, reactor.cc and their fandom subdomains), 1.6.4.
// A "gif" post is shown as a video in two files, …/pics/post/webm/<tags>-<id>.webm and …/pics/post/mp4/<tags>-<id>.mp4;
// the original GIF of the post usually lies next to them as …/pics/post/<tags>-<id>.gif (or under /full/).
// One card per post: MP4, WEBM and the GIF (when the server has it).

const HOST = /^img\d*\.(?:joyreactor\.(?:com|cc)|reactor\.cc)$/i;
const PAGE = /(^|\.)(joyreactor\.(com|cc)|reactor\.cc)$/i;

export const isJoyreactorPage = (url) => { try { return PAGE.test(new URL(url).hostname); } catch { return false; } };

// -> { host, slug, id, fmt } | null
export function jrParse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!HOST.test(u.hostname)) return null;
  const m = /^\/pics\/post\/(?:(webm|mp4)\/|full\/)?([^/]+)-(\d+)\.(webm|mp4|gif)$/i.exec(u.pathname);
  if (!m) return null;
  const fmt = m[4].toLowerCase();
  if (m[1] && m[1].toLowerCase() !== fmt) return null;
  if (!m[1] && fmt !== 'gif') return null;
  return { host: u.hostname.toLowerCase(), slug: m[2], id: m[3], fmt };
}

// where the original GIF of the post may be (tried in this order)
export function jrGifCandidates(p) {
  return [`https://${p.host}/pics/post/${p.slug}-${p.id}.gif`, `https://${p.host}/pics/post/full/${p.slug}-${p.id}.gif`];
}

// the tags of the file name without the service ones: "maine-coon-cats-video-with-sound" -> "maine coon cats"
const SERVICE = new Set(['video', 'with', 'sound', 'gif', 'gifs', 'videogif', 'webm', 'mp4', 'coub']);
export function jrTitle(slug) {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch { /* as it is */ }
  const words = s.split(/[-\s]+/).filter((w) => w && !SERVICE.has(w.toLowerCase()));
  return words.join(' ').slice(0, 120);
}
