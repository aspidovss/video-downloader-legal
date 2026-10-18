// Video feeds (pages that scroll through many short videos played over HLS): which playlist belongs to which <video>
// on the page. The page reports its videos with their cover picture (poster) and whether they are on screen; a
// playlist matches a video when the media file name in the playlist and the name of the poster (or of a direct
// source) are the same word. Generic: no site names, only file names.

const SUFFIX = /([-_.](poster|thumb|thumbnail|cover|preview|mobile|large|small|medium|silent|sd|hd|\d{3,4}p?))+$/i;

// File name without folder, extension and common size / role suffixes, lower case ("WeeklySkyblueChick-poster.jpg" -> "weeklyskybluechick")
export function fileStem(url, keepCase = false) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const s = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(SUFFIX, '');
    return keepCase ? s : s.toLowerCase();
  } catch {
    return '';
  }
}

// Words a playlist can be known by: its media file names and the folders of its own address ("/gifs/<name>/hd.m3u8")
export function playlistStems(playlistUrl, mediaUrls = []) {
  const out = new Set();
  for (const u of mediaUrls) { const s = fileStem(u); if (s.length >= 6) out.add(s); }
  try {
    for (const part of new URL(playlistUrl).pathname.split('/').slice(0, -1)) {
      const s = decodeURIComponent(part).toLowerCase();
      if (s.length >= 6 && /[a-z]/.test(s)) out.add(s);
    }
  } catch { /* no address */ }
  return [...out];
}

// feed: [{ poster, src, visible, playing }] -> the matching video or null
export function matchFeed(stems, feed) {
  if (!stems || !stems.length || !feed || !feed.length) return null;
  const set = new Set(stems);
  for (const v of feed) {
    for (const u of [v.poster, v.src]) {
      const s = u ? fileStem(u) : '';
      if (s.length >= 6 && set.has(s)) return v;
    }
  }
  return null;
}

// "WeeklySkyblueChick" -> "Weekly Skyblue Chick", "my_clip-01" -> "my clip 01"
export function humanStem(name) {
  return String(name || '').replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().slice(0, 80);
}
