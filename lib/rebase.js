// Live recordings of HLS streams carry the stream's own clock (a Twitch recording starts at "44:19" in VLC).
// This moves the timestamps so the file starts at 0: fMP4 (tfdt of every moof) and MPEG-TS (PTS, DTS, PCR).
// Only timestamp fields are rewritten, in place and at the same size; the media data is not touched.

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const w32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const w64 = (b, o, v) => { w32(b, o, Math.floor(v / 4294967296)); w32(b, o + 4, v % 4294967296); };

function boxes(b, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    let hdr = 8;
    if (size === 1) { size = u64(b, o + 8); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type: tag(b, o + 4), start: o, hdr, end: o + size });
    o += size;
  }
  return out;
}
const child = (b, box, type) => boxes(b, box.start + box.hdr, box.end).find((c) => c.type === type);

// ---------------------------------------------------------------- fMP4 ----
function timescales(b, into) { // track id -> media timescale, from an init segment
  for (const moov of boxes(b, 0, b.length).filter((x) => x.type === 'moov')) {
    for (const trak of boxes(b, moov.start + moov.hdr, moov.end).filter((x) => x.type === 'trak')) {
      const tkhd = child(b, trak, 'tkhd');
      const mdia = child(b, trak, 'mdia');
      const mdhd = mdia && child(b, mdia, 'mdhd');
      if (!tkhd || !mdhd) continue;
      const tp = tkhd.start + tkhd.hdr;
      const mp = mdhd.start + mdhd.hdr;
      into.set(u32(b, tp + (b[tp] === 1 ? 20 : 12)), u32(b, mp + (b[mp] === 1 ? 20 : 12)));
    }
  }
}

// every tfdt of the moofs in b: [{ track, pos, v1, time }]
function tfdts(b) {
  const out = [];
  for (const moof of boxes(b, 0, b.length).filter((x) => x.type === 'moof')) {
    for (const traf of boxes(b, moof.start + moof.hdr, moof.end).filter((x) => x.type === 'traf')) {
      const tfhd = child(b, traf, 'tfhd');
      const tfdt = child(b, traf, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const p = tfdt.start + tfdt.hdr;
      out.push({ track: u32(b, tfhd.start + tfhd.hdr + 4), pos: p, v1: b[p] === 1, time: b[p] === 1 ? u64(b, p + 4) : u32(b, p + 4) });
    }
  }
  return out;
}

async function rebaseMp4(blobs) {
  const scale = new Map();
  let base = null; // seconds
  const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
  // pass 1: timescales (init segments) and the first timestamp (the earliest track of the first fragment)
  for (const blob of blobs) {
    const b = await bytesOf(blob);
    timescales(b, scale);
    if (base === null) {
      const list = tfdts(b).filter((x) => scale.get(x.track));
      if (list.length) base = Math.min(...list.map((x) => x.time / scale.get(x.track)));
    }
  }
  if (base === null || base < 0.5) return blobs; // already starts near 0
  const out = [];
  for (const blob of blobs) {
    const b = await bytesOf(blob);
    const list = tfdts(b);
    if (!list.length) { out.push(blob); continue; }
    for (const x of list) {
      const sc = scale.get(x.track);
      if (!sc) continue;
      const t = Math.max(0, x.time - Math.round(base * sc));
      if (x.v1) w64(b, x.pos + 4, t); else if (t <= 0xffffffff) w32(b, x.pos + 4, t);
    }
    out.push(new Blob([b], { type: blob.type }));
  }
  return out;
}

// ------------------------------------------------------------------- TS ----
const MOD33 = 2 ** 33;
function readTs(b, o) {
  return ((b[o] >> 1) & 7) * 2 ** 30 + (((b[o + 1] << 22) | ((b[o + 2] >> 1) << 15) | (b[o + 3] << 7) | (b[o + 4] >> 1)) >>> 0);
}
function writeTs(b, o, v) {
  const hi = Math.floor(v / 2 ** 30) & 7;
  const lo = v % 2 ** 30;
  b[o] = (b[o] & 0xf0) | (hi << 1) | 1;
  b[o + 1] = (lo >>> 22) & 255;
  b[o + 2] = (((lo >>> 15) & 0x7f) << 1) | 1;
  b[o + 3] = (lo >>> 7) & 255;
  b[o + 4] = ((lo & 0x7f) << 1) | 1;
}

// calls fn(kind, offset) for every PTS / DTS / PCR field of the 188-byte packets in b (kind: 'ts' | 'pcr')
function eachTs(b, fn) {
  for (let p = 0; p + 188 <= b.length; p += 188) {
    if (b[p] !== 0x47) continue;
    const afc = (b[p + 3] >> 4) & 3;
    let pay = p + 4;
    if (afc & 2) {
      const afl = b[p + 4];
      if (afl >= 7 && (b[p + 5] & 0x10)) fn('pcr', p + 6);
      pay = p + 5 + afl;
    }
    if (!(afc & 1) || !(b[p + 1] & 0x40) || pay + 14 > p + 188) continue;
    if (b[pay] !== 0 || b[pay + 1] !== 0 || b[pay + 2] !== 1) continue;
    const sid = b[pay + 3];
    if (!((sid >= 0xc0 && sid <= 0xef) || sid === 0xbd)) continue;
    const flags = b[pay + 7] >> 6;
    if (flags & 2) fn('ts', pay + 9);
    if (flags === 3 && pay + 19 <= p + 188) fn('ts', pay + 14);
  }
}
const pcrBase = (b, o) => b[o] * 2 ** 25 + b[o + 1] * 2 ** 17 + b[o + 2] * 2 ** 9 + b[o + 3] * 2 + (b[o + 4] >> 7);
function writePcr(b, o, v) {
  b[o] = Math.floor(v / 2 ** 25) & 255;
  b[o + 1] = Math.floor(v / 2 ** 17) & 255;
  b[o + 2] = Math.floor(v / 2 ** 9) & 255;
  b[o + 3] = Math.floor(v / 2) & 255;
  b[o + 4] = ((v % 2) << 7) | (b[o + 4] & 0x7f);
}

async function rebaseTs(blobs) {
  let base = null; // 90 kHz ticks
  for (const blob of blobs) {
    const b = new Uint8Array(await blob.arrayBuffer());
    let min = Infinity;
    eachTs(b, (kind, o) => { const v = kind === 'pcr' ? pcrBase(b, o) : readTs(b, o); if (v < min) min = v; });
    if (min !== Infinity) { base = min; break; }
  }
  if (base === null || base < 45000) return blobs; // starts within 0.5 s of 0 already
  const out = [];
  for (const blob of blobs) {
    const b = new Uint8Array(await blob.arrayBuffer());
    let changed = false;
    eachTs(b, (kind, o) => {
      changed = true;
      if (kind === 'pcr') writePcr(b, o, (pcrBase(b, o) - base + MOD33) % MOD33);
      else writeTs(b, o, (readTs(b, o) - base + MOD33) % MOD33);
    });
    out.push(changed ? new Blob([b], { type: blob.type }) : blob);
  }
  return out;
}

// Returns blobs whose timeline starts at 0 (the same blobs when nothing had to change or the format is not known).
export async function rebaseTimestamps(blobs, ext) {
  try {
    if (!blobs.length) return blobs;
    if (ext === 'mp4') return await rebaseMp4(blobs);
    if (ext === 'ts') return await rebaseTs(blobs);
  } catch { /* keep the recording as it is */ }
  return blobs;
}
