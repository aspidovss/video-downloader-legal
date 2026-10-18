// Streams that publish video and sound as separate HLS media playlists (Low-Latency HLS packagers and others).
// When the master playlist cannot be read (for example a one-time token answers 403 to a second request), the
// media playlists the player fetched are put together again: one entry per stream with the video qualities, each
// joined with the audio playlist. Generic: playlists of one folder, the track types come from their init segments.

// Folder of a playlist address: same host and path up to the last "/" (the query is ignored)
export function playlistDir(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/[^/]*$/, '')}`;
  } catch {
    return '';
  }
}

// What the init segment holds: { video, audio, width, height, codec } (describeInit() result in, see mp4info.js)
export function trackInfo(desc) {
  const tr = (desc && desc.tracks) || [];
  const v = tr.find((t) => t.handler === 'vide');
  const a = tr.find((t) => t.handler === 'soun');
  return { video: !!v, audio: !!a, width: v ? v.width : 0, height: v ? v.height : 0, codec: v ? v.entry : (a ? a.entry : '') };
}

const label = (v, dupHeight) => {
  const base = v.height ? `${v.height}p` : (v.bandwidth ? `${Math.round(v.bandwidth / 1000)}k` : 'video');
  return dupHeight && v.bandwidth ? `${base} ${(v.bandwidth / 1e6).toFixed(1)}M` : base;
};

// items: [{ id, url, track: trackInfo, bandwidth, live }] -> [{ dir, members: [ids], variants: [...] }]
// A group needs at least one video-only and one audio-only playlist in the same folder.
export function buildSynthGroups(items) {
  const byDir = new Map();
  for (const it of items) {
    if (!it || !it.track) continue;
    const dir = playlistDir(it.url);
    if (!dir) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(it);
  }
  const out = [];
  for (const [dir, list] of byDir) {
    const videos = list.filter((x) => x.track.video && !x.track.audio);
    const audios = list.filter((x) => x.track.audio && !x.track.video);
    if (!videos.length || !audios.length) continue;
    // the best sound: the highest known bitrate, else the first one seen
    const audio = audios.slice().sort((x, y) => (y.bandwidth || 0) - (x.bandwidth || 0))[0];
    const sorted = videos.slice().sort((x, y) => (y.track.height || 0) - (x.track.height || 0) || (y.bandwidth || 0) - (x.bandwidth || 0));
    const heights = new Map();
    for (const v of sorted) heights.set(v.track.height || 0, (heights.get(v.track.height || 0) || 0) + 1);
    const variants = sorted.map((v) => {
      const flat = { height: v.track.height || 0, width: v.track.width || 0, bandwidth: (v.bandwidth || 0) + (audio.bandwidth || 0) };
      return { url: v.url, label: label({ ...flat, bandwidth: v.bandwidth || 0 }, heights.get(flat.height) > 1), codecs: v.track.codec || '', ...flat, audioUrl: audio.url };
    });
    out.push({ dir, live: list.some((x) => x.live), members: list.map((x) => x.id), variants });
  }
  return out;
}
