// MPEG-DASH (MPD) parser. Handles SegmentTemplate (Number / Time / SegmentTimeline),
// SegmentList and single-file BaseURL representations of the first Period.
// Anything with <ContentProtection> is flagged `protected` and never downloaded.
import { MiniDOMParser } from './xmlmini.js';

import { resolveUrl, qualityLabel } from './util.js';

export function parseISODuration(d) {
  if (!d) return 0;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(d);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (parseFloat(m[4]) || 0);
}

function kids(el, name) {
  return [...el.childNodes].filter((n) => n.nodeType === 1 && (n.localName || n.nodeName) === name);
}
function kid(el, name) {
  return kids(el, name)[0] || null;
}

function childBase(el, base) {
  const b = el && kid(el, 'BaseURL');
  return b && b.textContent.trim() ? resolveUrl(b.textContent.trim(), base) : base;
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(\w*?)(%0(\d+)d)?\$/g, (m, name, _f, width) => {
    if (name === '') return '$';
    if (!(name in vars)) return m;
    const v = String(vars[name]);
    return width ? v.padStart(+width, '0') : v;
  });
}

// Find the closest ancestor-or-self element carrying the given child (Rep -> Set -> Period).
function inherited(chain, name) {
  for (const el of chain) {
    const c = el && kid(el, name);
    if (c) return c;
  }
  return null;
}

function attrNum(el, name, def) {
  const v = el && el.getAttribute(name);
  return v !== null && v !== undefined && v !== '' ? Number(v) : def;
}

export function parseMPD(text, baseUrl, DOMParserImpl = globalThis.DOMParser || MiniDOMParser) {
  const doc = new DOMParserImpl().parseFromString(text, 'text/xml');
  const mpd = doc.documentElement;
  if (!mpd || (mpd.localName || mpd.nodeName) !== 'MPD') throw new Error('Not an MPD manifest');

  const live = mpd.getAttribute('type') === 'dynamic';
  const totalDuration = parseISODuration(mpd.getAttribute('mediaPresentationDuration'));
  const out = { live, protected: false, duration: totalDuration, videos: [], audios: [] };

  const mpdBase = childBase(mpd, baseUrl);
  const period = kid(mpd, 'Period');
  if (!period) return out;
  const periodDuration = parseISODuration(period.getAttribute('duration')) || totalDuration;
  const periodBase = childBase(period, mpdBase);

  for (const set of kids(period, 'AdaptationSet')) {
    const setBase = childBase(set, periodBase);
    const setProtected = kids(set, 'ContentProtection').length > 0;

    for (const rep of kids(set, 'Representation')) {
      const repBase = childBase(rep, setBase);
      const chain = [rep, set, period];
      const mime = rep.getAttribute('mimeType') || set.getAttribute('mimeType') || '';
      const contentType = set.getAttribute('contentType') || mime.split('/')[0];
      const isVideo = contentType === 'video' || mime.startsWith('video/');
      const isAudio = contentType === 'audio' || mime.startsWith('audio/');
      if (!isVideo && !isAudio) continue;

      if (setProtected || kids(rep, 'ContentProtection').length) out.protected = true;

      const info = {
        id: rep.getAttribute('id') || '',
        bandwidth: attrNum(rep, 'bandwidth', 0),
        width: attrNum(rep, 'width', attrNum(set, 'width', 0)),
        height: attrNum(rep, 'height', attrNum(set, 'height', 0)),
        codecs: rep.getAttribute('codecs') || set.getAttribute('codecs') || '',
        mime,
        lang: set.getAttribute('lang') || '',
        initUrl: null,
        segments: [],
      };
      info.label = isVideo ? qualityLabel(info) : qualityLabel(info) || info.lang;

      const tpl = inherited(chain, 'SegmentTemplate');
      const list = inherited(chain, 'SegmentList');
      const vars = { RepresentationID: info.id, Bandwidth: info.bandwidth };

      if (tpl) {
        const timescale = attrNum(tpl, 'timescale', 1);
        const startNumber = attrNum(tpl, 'startNumber', 1);
        const media = tpl.getAttribute('media');
        const init = tpl.getAttribute('initialization');
        if (init) info.initUrl = resolveUrl(fillTemplate(init, vars), repBase);
        const timeline = kid(tpl, 'SegmentTimeline');

        if (media && timeline) {
          let t = 0;
          let n = startNumber;
          for (const s of kids(timeline, 'S')) {
            if (s.getAttribute('t') !== null) t = Number(s.getAttribute('t'));
            const d = Number(s.getAttribute('d'));
            const r = attrNum(s, 'r', 0);
            const reps = r < 0 ? Math.max(0, Math.ceil(((periodDuration * timescale) - t) / d)) : r + 1;
            for (let i = 0; i < reps; i++) {
              info.segments.push({ url: resolveUrl(fillTemplate(media, { ...vars, Number: n, Time: t }), repBase), duration: d / timescale });
              t += d;
              n++;
            }
          }
        } else if (media) {
          const d = attrNum(tpl, 'duration', 0);
          if (!d || !periodDuration) throw new Error('DASH: cannot determine segment count');
          const count = Math.ceil((periodDuration * timescale) / d);
          for (let i = 0; i < count; i++) {
            const n = startNumber + i;
            info.segments.push({ url: resolveUrl(fillTemplate(media, { ...vars, Number: n, Time: i * d }), repBase), duration: d / timescale });
          }
        }
      } else if (list) {
        const initEl = kid(list, 'Initialization');
        if (initEl && initEl.getAttribute('sourceURL')) info.initUrl = resolveUrl(initEl.getAttribute('sourceURL'), repBase);
        for (const s of kids(list, 'SegmentURL')) {
          const media = s.getAttribute('media');
          const range = s.getAttribute('mediaRange');
          const r = range ? range.split('-').map(Number) : null;
          info.segments.push({ url: media ? resolveUrl(media, repBase) : repBase, range: r ? { start: r[0], end: r[1] } : null });
        }
      } else if (repBase !== setBase || kid(rep, 'BaseURL') || kid(rep, 'SegmentBase')) {
        // Whole stream in one file.
        info.segments.push({ url: repBase });
      }

      if (info.segments.length) (isVideo ? out.videos : out.audios).push(info);
    }
  }

  out.videos.sort((a, b) => b.bandwidth - a.bandwidth);
  out.audios.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}
