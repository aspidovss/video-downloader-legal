// Recording of a LIVE HLS stream (non-DRM only): the media playlist is re-read every few seconds and every new
// segment is downloaded once. Nothing is re-encoded. The result is the list of downloaded pieces in order.
// Ends when the stream ends (#EXT-X-ENDLIST), the user presses Stop, a limit is reached or the stream fails.

import { parsePlaylist } from './hls.js';
import { downloadParts, fetchText, StreamError } from './downloader.js';

// Waits `ms`; a Stop (stopSignal) ends the wait normally, a Cancel (signal) throws.
function wait(ms, signal, stopSignal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new StreamError('aborted')); return; }
    if (stopSignal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); stopSignal?.removeEventListener('abort', onStop); };
    const onAbort = () => { done(); reject(new StreamError('aborted')); };
    const onStop = () => { done(); resolve(); };
    const t = setTimeout(() => { done(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    stopSignal?.addEventListener('abort', onStop, { once: true });
  });
}

const keyOf = (seg) => `${String(seg.url).split(/[?#]/)[0]}|${seg.range ? `${seg.range.start}-${seg.range.end}` : ''}`;

export async function recordLive(playlistUrl, opts = {}) {
  const {
    signal, stopSignal, fetchFn = globalThis.fetch.bind(globalThis), maxBytes = Infinity, maxSeconds = Infinity,
    onProgress, concurrency = 3, minPollMs = 1000, maxPollMs = 5000, maxPlaylistFailures = 8, maxSegmentFailures = 5, credentials = 'include',
  } = opts;

  const out = { blobs: [], ext: 'ts', seconds: 0, bytes: 0, segments: 0, missed: 0, gaps: 0, reason: '', lastError: '', polls: 0, plSegs: 0, sample: '' };
  const errText = (e) => `${e?.code || e?.name || 'error'} ${e?.status || ''} ${String(e?.message || '').replace(/https?:\/\/\S+/g, '')}`.trim().slice(0, 60);
  const seen = new Set();
  let lastSeq = -1;
  let lastMap = null;
  let playlistFails = 0;
  let segFails = 0;
  let pollMs = 2000;

  for (;;) {
    if (signal?.aborted) throw new StreamError('aborted');
    if (stopSignal?.aborted) { out.reason = 'stopped'; break; }

    let pl = null;
    try {
      pl = parsePlaylist(await fetchText(playlistUrl, { fetchFn, signal }), playlistUrl);
      playlistFails = 0;
      out.polls++;
      out.plSegs = pl.segments.length;
    } catch (e) {
      if (signal?.aborted || (e instanceof StreamError && e.code === 'aborted')) throw new StreamError('aborted');
      out.lastError = `playlist ${errText(e)}`;
      if (++playlistFails >= maxPlaylistFailures) { out.reason = 'errors'; break; }
    }

    if (pl) {
      if (pl.type === 'master') throw new StreamError('empty', 'A media playlist is required');
      if (pl.protected) throw new StreamError('drm', 'Stream is DRM-protected');
      if (pl.hasMap) out.ext = 'mp4';

      const fresh = pl.segments.filter((s) => !seen.has(keyOf(s)));
      if (fresh.length) {
        if (lastSeq >= 0 && fresh[0].seq > lastSeq + 1) out.gaps += fresh[0].seq - lastSeq - 1; // the window moved past some segments
        if (!out.sample) out.sample = fresh[0].url;
        const parts = [];
        for (const seg of fresh) {
          if (seg.map && (!lastMap || lastMap.url !== seg.map.url)) {
            parts.push({ url: seg.map.url, range: seg.map.range, init: true });
            lastMap = seg.map;
          }
          parts.push({ url: seg.url, range: seg.range, key: seg.key, seq: seg.seq });
        }
        const take = (blobs, segs) => {
          for (const b of blobs) { out.blobs.push(b); out.bytes += b.size; }
          out.segments += segs.length;
          out.seconds += segs.reduce((n, x) => n + (x.duration || 0), 0);
        };
        try {
          take(await downloadParts(parts, { concurrency, signal, fetchFn, credentials }), fresh);
          segFails = 0;
        } catch (e) {
          if (signal?.aborted || (e instanceof StreamError && e.code === 'aborted')) throw new StreamError('aborted');
          // something in this batch failed: retry piece by piece so one expired segment does not cost its neighbours
          let okAny = false;
          let pi = 0;
          for (const seg of fresh) {
            const mine = [];
            if (parts[pi] && parts[pi].init) mine.push(parts[pi++]);
            mine.push(parts[pi++]);
            try { take(await downloadParts(mine, { concurrency: 1, signal, fetchFn, credentials }), [seg]); okAny = true; } catch (e2) {
              if (signal?.aborted || (e2 instanceof StreamError && e2.code === 'aborted')) throw new StreamError('aborted');
              out.lastError = `segment ${errText(e2)}`;
              out.missed++; // expired / unavailable: skip it, keep going
            }
          }
          if (okAny) segFails = 0; else if (++segFails >= maxSegmentFailures) out.reason = 'errors';
        }
        for (const s of fresh) seen.add(keyOf(s));
        lastSeq = fresh[fresh.length - 1].seq;
        const last = fresh[fresh.length - 1].duration;
        if (last) pollMs = Math.min(maxPollMs, Math.max(minPollMs, (last * 1000) / 2));
        onProgress?.({ seconds: out.seconds, bytes: out.bytes, segments: out.segments, missed: out.missed });
        if (out.reason) break;
      }
      if (pl.endList) { out.reason = 'ended'; break; }
    }

    if (out.bytes >= maxBytes) { out.reason = 'size'; break; }
    if (out.seconds >= maxSeconds) { out.reason = 'time'; break; }
    await wait(pollMs, signal, stopSignal);
  }
  return out;
}
