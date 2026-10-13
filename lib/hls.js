// HLS (m3u8) playlist parser. Supports master + media playlists, EXT-X-MAP,
// EXT-X-BYTERANGE and AES-128 (the key is published in the playlist itself).
// DRM variants (SAMPLE-AES, Widevine/FairPlay key formats) are flagged `protected`.

import { resolveUrl, qualityLabel } from './util.js';

export function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

function parseResolution(r) {
  const m = /^(\d+)x(\d+)$/i.exec(r || '');
  return m ? { width: +m[1], height: +m[2] } : {};
}

function keyFromAttrs(attrs, baseUrl) {
  const method = (attrs.METHOD || 'NONE').toUpperCase();
  if (method === 'NONE') return null;
  const format = (attrs.KEYFORMAT || 'identity').toLowerCase();
  return {
    method,
    uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null,
    iv: attrs.IV || null,
    drm: method !== 'AES-128' || format !== 'identity',
  };
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an m3u8 playlist');

  const result = {
    type: 'media',
    variants: [],
    audios: [],
    segments: [],
    endList: false,
    live: false,
    protected: false,
    duration: 0,
    mediaSequence: 0,
    hasMap: false,
  };

  let pendingInf = null; // EXTINF duration
  let pendingVariant = null;
  let pendingRange = null;
  let currentKey = null;
  let currentMap = null;
  let lastRangeEnd = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        pendingVariant = parseAttributes(line.slice(18));
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(line.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) {
          result.audios.push({
            group: a['GROUP-ID'],
            name: a.NAME || a.LANGUAGE || 'audio',
            language: a.LANGUAGE || '',
            default: a.DEFAULT === 'YES',
            url: resolveUrl(a.URI, baseUrl),
          });
        }
      } else if (line.startsWith('#EXTINF:')) {
        pendingInf = parseFloat(line.slice(8)) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        currentKey = keyFromAttrs(parseAttributes(line.slice(11)), baseUrl);
        if (currentKey?.drm) result.protected = true;
      } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
        const k = keyFromAttrs(parseAttributes(line.slice(19)), baseUrl);
        if (k?.drm) result.protected = true;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttributes(line.slice(11));
        currentMap = { url: resolveUrl(a.URI, baseUrl), range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0).range : null };
        result.hasMap = true;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = line.slice(17);
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        result.mediaSequence = parseInt(line.slice(22), 10) || 0;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        result.endList = true;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        if (line.includes('VOD')) result.endList = true;
      }
      continue;
    }

    // URI line
    const url = resolveUrl(line, baseUrl);
    if (pendingVariant) {
      const res = parseResolution(pendingVariant.RESOLUTION);
      result.type = 'master';
      result.variants.push({
        url,
        bandwidth: parseInt(pendingVariant.BANDWIDTH || pendingVariant['AVERAGE-BANDWIDTH'] || '0', 10),
        codecs: pendingVariant.CODECS || '',
        frameRate: parseFloat(pendingVariant['FRAME-RATE']) || 0,
        audioGroup: pendingVariant.AUDIO || null,
        ...res,
      });
      pendingVariant = null;
    } else {
      let range = null;
      if (pendingRange) {
        const r = parseRange(pendingRange, lastRangeEnd);
        range = r.range;
        lastRangeEnd = r.end;
        pendingRange = null;
      }
      result.segments.push({
        url,
        duration: pendingInf || 0,
        range,
        key: currentKey && !currentKey.drm ? currentKey : null,
        map: currentMap,
        seq: result.mediaSequence + result.segments.length,
      });
      result.duration += pendingInf || 0;
      pendingInf = null;
    }
  }

  if (result.type === 'master') {
    result.variants.sort((a, b) => b.bandwidth - a.bandwidth);
    for (const v of result.variants) {
      v.label = qualityLabel(v);
      // Attach the best matching separate audio rendition (if the stream has one).
      if (v.audioGroup) {
        const group = result.audios.filter((a) => a.group === v.audioGroup);
        v.audio = group.find((a) => a.default) || group[0] || null;
      }
    }
  } else {
    result.live = !result.endList;
  }
  return result;
}

function parseRange(spec, defaultOffset) {
  const [len, off] = spec.split('@');
  const length = parseInt(len, 10);
  const offset = off !== undefined ? parseInt(off, 10) : defaultOffset;
  return { range: { start: offset, end: offset + length - 1 }, end: offset + length };
}

// ---- AES-128 helpers -------------------------------------------------------

export function ivBytes(key, seq) {
  const iv = new Uint8Array(16);
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    // Default IV is the segment sequence number as a 128-bit big-endian integer.
    let n = BigInt(seq);
    for (let i = 15; i >= 0 && n > 0n; i--) {
      iv[i] = Number(n & 0xffn);
      n >>= 8n;
    }
  }
  return iv;
}

export async function decryptSegment(cryptoApi, keyBytes, key, seq, data) {
  const cryptoKey = await cryptoApi.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
  return cryptoApi.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes(key, seq) }, cryptoKey, data);
}
