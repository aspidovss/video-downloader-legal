// MPEG-TS -> MP4 (or Matroska, 1.6.4) without re-encoding (own code).
// Supports what HLS streams normally carry: H.264 video (stream type 0x1B) and AAC audio in ADTS (0x0F).
// Anything else (HEVC, AC-3, MP3 ...), broken or too large input -> returns null and the caller keeps the TS file.
// The result is a progressive MP4 (moov first, one mdat) that starts at 0:00 and plays in VLC / Windows Media Player.

export const TS_MP4_MAX_BYTES = 700 * 1024 * 1024; // the data is held in memory several times over

const SR_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// ---------------------------------------------------------------- bytes ----
const cat = (arrs) => {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const be = (v, n) => { const a = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { a[i] = v % 256; v = Math.floor(v / 256); } return a; };
const u32 = (v) => be(v >>> 0, 4);
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function box(type, ...payload) {
  const body = cat(payload);
  return cat([u32(body.length + 8), str(type), body]);
}
const fullBox = (type, version, flags, ...payload) => box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...payload);

// ------------------------------------------------------------- H.264 SPS ----
class Bits {
  constructor(b) { this.b = b; this.p = 0; }
  bit() { const v = (this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v; }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  ue() { let z = 0; while (this.bit() === 0 && z < 32) z++; return z ? (2 ** z - 1) + this.bits(z) : 0; }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}
function unescape(b) { // remove emulation prevention bytes
  const out = [];
  for (let i = 0; i < b.length; i++) {
    if (i >= 2 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) continue;
    out.push(b[i]);
  }
  return Uint8Array.from(out);
}
export function parseSps(nal) { // nal includes the 1-byte NAL header
  const r = new Bits(unescape(nal.subarray(1)));
  const profile = r.bits(8);
  const compat = r.bits(8);
  const level = r.bits(8);
  r.ue();
  let chroma = 1;
  let bitDepthL = 8;
  let bitDepthC = 8;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.bit();
    bitDepthL = 8 + r.ue();
    bitDepthC = 8 + r.ue();
    r.bit();
    if (r.bit()) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (r.bit()) {
          const size = i < 6 ? 16 : 64;
          let last = 8;
          let next = 8;
          for (let j = 0; j < size; j++) {
            if (next !== 0) { next = (last + r.se() + 256) % 256; }
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }
  r.ue();
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) {
    r.bit(); r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue();
  r.bit();
  const wMbs = r.ue() + 1;
  const hMap = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit();
  let crop = [0, 0, 0, 0];
  if (r.bit()) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  const cx = chroma === 0 || chroma === 3 ? 1 : 2;
  const cy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  const width = wMbs * 16 - cx * (crop[0] + crop[1]);
  const height = (2 - frameMbsOnly) * hMap * 16 - cy * (crop[2] + crop[3]);
  if (!(width > 0 && height > 0 && width < 16384 && height < 16384)) throw new Error('sps');
  return { profile, compat, level, chroma, bitDepthL, bitDepthC, width, height };
}

// ------------------------------------------------------------------ TS ----
function findSync(b) {
  for (let i = 0; i < Math.min(b.length - 188 * 3, 4096); i++) {
    if (b[i] === 0x47 && b[i + 188] === 0x47 && b[i + 376] === 0x47) return i;
  }
  return -1;
}

function pts(b, o) {
  return ((b[o] >> 1) & 7) * 2 ** 30 + (((b[o + 1] << 8) | b[o + 2]) >> 1) * 2 ** 15 + (((b[o + 3] << 8) | b[o + 4]) >> 1);
}

// -> { video: {pes:[{pts,dts,data}]}, audio: {...}, ok }
function demux(b) {
  const start = findSync(b);
  if (start < 0) return null;
  let pmtPid = -1;
  const streams = new Map(); // pid -> { type, chunks, hdr, list }
  let vPid = -1;
  let aPid = -1;
  let unsupported = false;

  const flush = (s) => {
    if (!s.chunks.length) return;
    const d = cat(s.chunks);
    s.chunks = [];
    if (d.length < 9 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return;
    const flags = d[7] >> 6;
    const hl = d[8];
    if (9 + hl > d.length) return;
    let p = null;
    let dts = null;
    if (flags >= 2) p = pts(d, 9);
    if (flags === 3) dts = pts(d, 14);
    if (p === null) return;
    s.list.push({ pts: p, dts: dts === null ? p : dts, data: d.subarray(9 + hl) });
  };

  for (let o = start; o + 188 <= b.length; o += 188) {
    if (b[o] !== 0x47) {
      // lost sync: look for the next one
      const n = findSync(b.subarray(o));
      if (n < 0) break;
      o += n - 188;
      continue;
    }
    if (b[o + 1] & 0x80) continue;
    const pusi = (b[o + 1] & 0x40) !== 0;
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    const afc = (b[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc & 2) p += 1 + b[o + 4];
    if (!(afc & 1) || p >= o + 188) continue;
    const end = o + 188;

    if (pid === 0 && pusi && pmtPid < 0) {
      const sec = p + 1 + b[p];
      const len = ((b[sec + 1] & 0x0f) << 8) | b[sec + 2];
      for (let i = sec + 8; i + 4 <= sec + 3 + len - 4 && i + 4 <= end; i += 4) {
        const prog = (b[i] << 8) | b[i + 1];
        if (prog !== 0) { pmtPid = ((b[i + 2] & 0x1f) << 8) | b[i + 3]; break; }
      }
      continue;
    }
    if (pid === pmtPid && pusi && vPid < 0 && aPid < 0) {
      const sec = p + 1 + b[p];
      const len = ((b[sec + 1] & 0x0f) << 8) | b[sec + 2];
      const pil = ((b[sec + 10] & 0x0f) << 8) | b[sec + 11];
      let i = sec + 12 + pil;
      const stop = Math.min(sec + 3 + len - 4, end);
      while (i + 5 <= stop) {
        const type = b[i];
        const epid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
        const esl = ((b[i + 3] & 0x0f) << 8) | b[i + 4];
        if (type === 0x1b && vPid < 0) { vPid = epid; streams.set(epid, { type, chunks: [], list: [], kind: 'video' }); }
        else if (type === 0x0f && aPid < 0) { aPid = epid; streams.set(epid, { type, chunks: [], list: [], kind: 'audio' }); }
        else if ([0x24, 0x03, 0x04, 0x81, 0x87, 0x06, 0x11, 0x10, 0x02].includes(type)) unsupported = true; // a stream we cannot carry over
        i += 5 + esl;
      }
      continue;
    }
    const s = streams.get(pid);
    if (!s) continue;
    if (pusi) flush(s);
    s.chunks.push(b.subarray(p, end));
  }
  for (const s of streams.values()) flush(s);
  if (unsupported || vPid < 0) return null;
  return { video: streams.get(vPid).list, audio: aPid >= 0 ? streams.get(aPid).list : [] };
}

// unwrap 33-bit timestamps (a long recording passes 2^33 / 90000 = 26.5 hours; also segment restarts)
function unwrap(list) {
  const W = 2 ** 33;
  let addP = 0;
  let addD = 0;
  let lp = null;
  let ld = null;
  for (const e of list) {
    if (lp !== null && e.pts + addP < lp - W / 2) addP += W;
    if (ld !== null && e.dts + addD < ld - W / 2) addD += W;
    e.pts += addP;
    e.dts += addD;
    lp = e.pts;
    ld = e.dts;
  }
}

// ---------------------------------------------------------- elementary ----
function nalUnits(d) { // Annex B -> [{type, data}]
  const out = [];
  let i = 0;
  const n = d.length;
  let s = -1;
  while (i + 3 <= n) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
      if (s >= 0) out.push(d.subarray(s, d[i - 1] === 0 && i - 1 > s ? i - 1 : i));
      s = i + 3;
      i += 3;
    } else i++;
  }
  if (s >= 0 && s < n) out.push(d.subarray(s, n));
  return out.filter((x) => x.length > 0);
}

function buildVideo(pes) {
  const samples = [];
  const spsList = [];
  const ppsList = [];
  const same = (a, b2) => a.length === b2.length && a.every((v, i) => v === b2[i]);
  let cur = null;
  const startSample = (e) => { cur = { pts: e.pts, dts: e.dts, nals: [], key: false, vcl: false }; samples.push(cur); };
  for (const e of pes) {
    cur = null;
    for (const nal of nalUnits(e.data)) {
      const t = nal[0] & 31;
      if (t === 9) { // access unit delimiter: starts a new sample inside a PES holding several
        if (cur && cur.vcl) cur = null;
        continue;
      }
      if (!cur) startSample(e);
      if (t === 7) { if (!spsList.some((x) => same(x, nal))) spsList.push(nal.slice()); continue; }
      if (t === 8) { if (!ppsList.some((x) => same(x, nal))) ppsList.push(nal.slice()); continue; }
      if (t === 1 || t === 5) { cur.vcl = true; if (t === 5) cur.key = true; }
      cur.nals.push(nal);
    }
  }
  const good = samples.filter((s) => s.vcl);
  // start at the first key frame
  const k = good.findIndex((s) => s.key);
  if (k < 0 || !spsList.length || !ppsList.length) return null;
  if (spsList.length > 1) {
    // several different SPS: fine only when they describe the same picture size
    const a = parseSps(spsList[0]);
    for (const s of spsList.slice(1)) { const c = parseSps(s); if (c.width !== a.width || c.height !== a.height) return null; }
  }
  const use = good.slice(k).map((s) => {
    const parts = [];
    for (const nal of s.nals) { parts.push(u32(nal.length), nal); }
    return { pts: s.pts, dts: s.dts, key: s.key, data: cat(parts) };
  });
  return { samples: use, spsList, ppsList };
}

function buildAudio(pes) {
  const frames = []; // { pts, data }
  let cfg = null;
  let expected = null;
  for (const e of pes) {
    const d = e.data;
    let i = 0;
    let first = true;
    while (i + 7 <= d.length) {
      if (d[i] !== 0xff || (d[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
      const prot = d[i + 1] & 1;
      const profile = (d[i + 2] >> 6) & 3;
      const fi = (d[i + 2] >> 2) & 15;
      const ch = ((d[i + 2] & 1) << 2) | (d[i + 3] >> 6);
      const len = ((d[i + 3] & 3) << 11) | (d[i + 4] << 3) | (d[i + 5] >> 5);
      const hdr = prot ? 7 : 9;
      if (fi > 12 || len < hdr || i + len > d.length) break;
      if (!cfg) cfg = { profile, fi, ch, rate: SR_TABLE[fi] };
      else if (cfg.fi !== fi || cfg.ch !== ch) return null;
      const sr = cfg.rate;
      let t;
      if (first) {
        t = e.pts;
        // keep the running clock unless there is a real gap (a missed segment)
        if (expected !== null && Math.abs(t - expected) < 2 * 1024 * 90000 / sr) t = expected;
        first = false;
      } else t = expected;
      frames.push({ pts: t, data: d.subarray(i + hdr, i + len) });
      expected = t + 1024 * 90000 / sr;
      i += len;
    }
  }
  if (!cfg || !frames.length) return null;
  return { cfg, frames };
}

// ----------------------------------------------------------------- MP4 ----
function rle(values) { // [[count, value], ...]
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++; else out.push([1, v]);
  }
  return out;
}
const u32s = (arr) => cat(arr.map((v) => u32(v)));

function stblFor(tr, offsets) {
  const n = tr.sizes.length;
  const stts = fullBox('stts', 0, 0, u32(tr.sttsRuns.length), cat(tr.sttsRuns.map(([c, d]) => cat([u32(c), u32(d)]))));
  const ctts = tr.cttsRuns ? fullBox('ctts', 0, 0, u32(tr.cttsRuns.length), cat(tr.cttsRuns.map(([c, d]) => cat([u32(c), u32(d)])))) : new Uint8Array(0);
  const stss = tr.syncs ? fullBox('stss', 0, 0, u32(tr.syncs.length), u32s(tr.syncs)) : new Uint8Array(0);
  const stsc = fullBox('stsc', 0, 0, u32(tr.stscRuns.length), cat(tr.stscRuns.map(([first, per]) => cat([u32(first), u32(per), u32(1)]))));
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(n), u32s(tr.sizes));
  const stco = fullBox('stco', 0, 0, u32(offsets.length), u32s(offsets));
  return box('stbl', tr.stsd, stts, ctts, stss, stsc, stsz, stco);
}

function trakFor(tr, id, movieTs, offsets) {
  const dur = Math.round(tr.durationMs * movieTs / 1000);
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(dur),
    new Uint8Array(8), new Uint8Array([0, 0, 0, 0]), new Uint8Array([tr.video ? 0 : 1, 0, 0, 0]),
    u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
    u32(tr.video ? tr.width * 65536 : 0), u32(tr.video ? tr.height * 65536 : 0));
  const edits = [];
  if (tr.emptyMs > 0) edits.push([Math.round(tr.emptyMs * movieTs / 1000), 0xffffffff]);
  edits.push([Math.max(1, Math.round((tr.durationMs - tr.emptyMs) * movieTs / 1000)), tr.mediaTime]);
  const elst = fullBox('elst', 0, 0, u32(edits.length), cat(edits.map(([d, m]) => cat([u32(d), u32(m), u32(1)]))));
  const edts = box('edts', elst);
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(tr.timescale), u32(tr.mediaDuration), new Uint8Array([0x55, 0xc4, 0, 0]));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), str(tr.video ? 'vide' : 'soun'), new Uint8Array(12), str(tr.video ? 'VideoHandler\0' : 'SoundHandler\0'));
  const mhd = tr.video ? fullBox('vmhd', 0, 1, new Uint8Array(8)) : fullBox('smhd', 0, 0, new Uint8Array(4));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const minf = box('minf', mhd, dinf, stblFor(tr, offsets));
  return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
}

// AVCDecoderConfigurationRecord (the body of 'avcC'; also the CodecPrivate of V_MPEG4/ISO/AVC in Matroska)
function avcConfig(v, sps) {
  const info = parseSps(sps[0]);
  const high = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(info.profile);
  const body = cat([new Uint8Array([1, sps[0][1], sps[0][2], sps[0][3], 0xff, 0xe0 | sps.length]),
    cat(sps.map((s) => cat([be(s.length, 2), s]))), new Uint8Array([v.ppsList.length]), cat(v.ppsList.map((s) => cat([be(s.length, 2), s]))),
    high ? new Uint8Array([0xfc | info.chroma, 0xf8 | (info.bitDepthL - 8), 0xf8 | (info.bitDepthC - 8), 0]) : new Uint8Array(0)]);
  return { body, info };
}

const aacConfig = (cfg) => new Uint8Array([((cfg.profile + 1) << 3) | (cfg.fi >> 1), ((cfg.fi & 1) << 7) | (cfg.ch << 3)]);

function avc1(v, sps) {
  const { body, info } = avcConfig(v, sps);
  const avcC = box('avcC', body);
  const name = new Uint8Array(32);
  return { entry: box('avc1', new Uint8Array(6), be(1, 2), new Uint8Array(16), be(info.width, 2), be(info.height, 2),
    u32(0x00480000), u32(0x00480000), u32(0), be(1, 2), name, be(0x18, 2), be(0xffff, 2), avcC), info };
}

function mp4a(cfg, avgBitrate) {
  const asc = aacConfig(cfg);
  const dec = cat([new Uint8Array([0x04, 13 + 2 + 2, 0x40, 0x15, 0, 0, 0]), u32(avgBitrate), u32(avgBitrate), new Uint8Array([0x05, 2]), asc]);
  const es = cat([new Uint8Array([0x03, 3 + dec.length + 3, 0, 0, 0]), dec, new Uint8Array([0x06, 1, 0x02])]);
  return box('mp4a', new Uint8Array(6), be(1, 2), new Uint8Array(8), be(cfg.ch || 2, 2), be(16, 2), new Uint8Array(4), be(cfg.rate, 2), new Uint8Array(2), fullBox('esds', 0, 0, es));
}

// -------------------------------------------------------------- convert ----
export function convertTs(bytes) {
  try {
    const dm = demux(bytes);
    if (!dm || !dm.video.length) return null;
    unwrap(dm.video);
    unwrap(dm.audio);
    const v = buildVideo(dm.video);
    if (!v || !v.samples.length) return null;
    const a = dm.audio.length ? buildAudio(dm.audio) : null;
    if (dm.audio.length && !a) return null;

    // timeline: zero = presentation time of the first video frame; audio before it is dropped
    const vs = v.samples;
    const T0 = vs[0].pts;
    let dtsFixed = false;
    for (let i = 1; i < vs.length; i++) if (vs[i].dts <= vs[i - 1].dts) { dtsFixed = true; break; }
    if (dtsFixed) { // DTS must increase: spread equal/odd values over the frame interval
      const step = Math.max(1, Math.round((vs[vs.length - 1].dts - vs[0].dts) / Math.max(1, vs.length - 1)) || 3000);
      for (let i = 1; i < vs.length; i++) if (vs[i].dts <= vs[i - 1].dts) vs[i].dts = vs[i - 1].dts + step;
    }
    const dts0 = vs[0].dts;
    const vDur = vs.map((s, i) => (i + 1 < vs.length ? vs[i + 1].dts - s.dts : 0));
    const lastDur = vs.length > 1 ? vDur[vs.length - 2] : 3000;
    vDur[vs.length - 1] = lastDur;
    const vTr = {
      video: true, timescale: 90000, sizes: vs.map((s) => s.data.length),
      sttsRuns: rle(vDur), cttsRuns: null, syncs: [],
    };
    const ct = vs.map((s) => Math.max(0, Math.round(s.pts - s.dts)));
    if (ct.some((x) => x !== 0)) vTr.cttsRuns = rle(ct);
    vs.forEach((s, i) => { if (s.key) vTr.syncs.push(i + 1); });
    if (vTr.syncs.length === vs.length) vTr.syncs = null;
    vTr.mediaDuration = vs[vs.length - 1].dts - dts0 + lastDur;
    vTr.durationMs = (Math.max(...vs.map((x) => x.pts)) - vs[0].pts + lastDur) / 90;
    vTr.mediaTime = Math.max(0, Math.round(vs[0].pts - dts0));
    vTr.emptyMs = 0;
    const { entry, info } = avc1(v, v.spsList);
    vTr.stsd = fullBox('stsd', 0, 0, u32(1), entry);
    vTr.width = info.width;
    vTr.height = info.height;
    vTr.items = vs.map((s, i) => ({ data: s.data, t: (s.dts - dts0) / 90000 }));

    const tracks = [vTr];
    if (a) {
      const sr = a.cfg.rate;
      const fr = a.frames.filter((f) => f.pts >= T0 - 1024 * 90000 / sr / 2);
      if (fr.length) {
        const times = fr.map((f) => Math.round((f.pts - T0) * sr / 90000));
        const first = times[0];
        const aDur = times.map((t, i) => (i + 1 < times.length ? Math.max(1, times[i + 1] - t) : 1024));
        const total = times[times.length - 1] - first + aDur[aDur.length - 1];
        const bytesTotal = fr.reduce((n, f) => n + f.data.length, 0);
        const avg = Math.round(bytesTotal * 8 / Math.max(0.1, total / sr));
        const aTr = {
          video: false, timescale: sr, sizes: fr.map((f) => f.data.length), sttsRuns: rle(aDur), cttsRuns: null, syncs: null,
          mediaDuration: total, durationMs: 0, mediaTime: 0, emptyMs: Math.max(0, first / sr * 1000),
          stsd: fullBox('stsd', 0, 0, u32(1), mp4a(a.cfg, avg)),
        };
        aTr.durationMs = aTr.emptyMs + total / sr * 1000;
        aTr.items = fr.map((f, i) => ({ data: f.data, t: Math.max(0, times[i] / sr) }));
        tracks.push(aTr);
      }
    }

    // chunks: one chunk per track for every second of media, written in time order
    const chunks = []; // { tr, items }
    const buckets = new Map();
    tracks.forEach((tr, ti) => {
      for (const it of tr.items) {
        const sec = Math.floor(it.t);
        const key = `${sec}:${ti}`;
        let c = buckets.get(key);
        if (!c) { c = { sec, ti, items: [] }; buckets.set(key, c); chunks.push(c); }
        c.items.push(it);
      }
    });
    chunks.sort((x, y) => x.sec - y.sec || x.ti - y.ti);
    tracks.forEach((tr, ti) => {
      tr.chunkList = chunks.filter((c) => c.ti === ti);
      tr.stscRuns = [];
      tr.chunkList.forEach((c, i) => {
        const last = tr.stscRuns[tr.stscRuns.length - 1];
        if (!last || last[1] !== c.items.length) tr.stscRuns.push([i + 1, c.items.length]);
      });
    });
    let rel = 0;
    for (const c of chunks) { c.rel = rel; for (const it of c.items) rel += it.data.length; }
    if (rel > 3.9 * 1024 * 1024 * 1024) return null;

    const movieTs = 1000;
    const durationMs = Math.max(...tracks.map((t) => t.durationMs));
    const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(movieTs), u32(Math.round(durationMs)), u32(0x00010000), be(0x0100, 2), new Uint8Array(10),
      u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000), new Uint8Array(24), u32(tracks.length + 1));
    const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    const makeMoov = (base) => box('moov', mvhd, ...tracks.map((tr, i) => trakFor(tr, i + 1, movieTs, tr.chunkList.map((c) => base + c.rel))));
    const moovSize = makeMoov(0).length;
    const base = ftyp.length + moovSize + 8;
    const moov = makeMoov(base);
    const mdatHdr = cat([u32(rel + 8), str('mdat')]);
    const parts = [ftyp, moov, mdatHdr];
    for (const c of chunks) for (const it of c.items) parts.push(it.data);
    return { parts, info: { width: info.width, height: info.height, seconds: durationMs / 1000, frames: vs.length, audioFrames: tracks[1] ? tracks[1].sizes.length : 0 } };
  } catch {
    return null;
  }
}

// MPEG-TS -> Matroska (1.6.4): the same H.264 + AAC as for MP4, written by lib/mux.js (globalThis.__vdlMux).
// Matroska keeps the presentation time of every frame, so B-frames need no extra table.
export function convertTsMkv(bytes, mux = globalThis.__vdlMux) {
  try {
    if (!mux || typeof mux.writeMkvAvcAac !== 'function') return null;
    const dm = demux(bytes);
    if (!dm || !dm.video.length) return null;
    unwrap(dm.video);
    unwrap(dm.audio);
    const v = buildVideo(dm.video);
    if (!v || !v.samples.length) return null;
    const a = dm.audio.length ? buildAudio(dm.audio) : null;
    if (dm.audio.length && !a) return null;
    const vs = v.samples;
    const T0 = Math.min(...vs.map((x) => x.pts));
    const video = vs.map((x) => ({ t: (x.pts - T0) / 90, data: x.data, flags: x.key ? 0x80 : 0, key: x.key, extra: null }));
    const sorted = vs.map((x) => x.pts).sort((p, q) => p - q);
    const step = sorted.length > 1 ? Math.max(1, (sorted[sorted.length - 1] - sorted[0]) / (sorted.length - 1)) : 3000;
    let durationMs = (sorted[sorted.length - 1] - T0 + step) / 90;
    let audio = [];
    let asc = null;
    if (a) {
      const sr = a.cfg.rate;
      const half = 1024 * 90000 / sr / 2;
      audio = a.frames.filter((f) => f.pts >= T0 - half).map((f) => ({ t: Math.max(0, (f.pts - T0) / 90), data: f.data, flags: 0x80, key: true, extra: null }));
      if (audio.length) {
        asc = aacConfig(a.cfg);
        durationMs = Math.max(durationMs, audio[audio.length - 1].t + 1024 * 1000 / sr);
      }
    }
    const { body, info } = avcConfig(v, v.spsList);
    const blob = mux.writeMkvAvcAac({ avcC: body, width: info.width, height: info.height, asc, rate: a?.cfg.rate, channels: a?.cfg.ch || 2, video, audio, durationMs });
    return blob ? { blob, info: { width: info.width, height: info.height, seconds: durationMs / 1000, frames: video.length, audioFrames: audio.length } } : null;
  } catch {
    return null;
  }
}

export async function tsToMkv(blob, mux) {
  try {
    if (!blob || blob.size < 188 * 4 || blob.size > TS_MP4_MAX_BYTES) return null;
    const r = convertTsMkv(new Uint8Array(await blob.arrayBuffer()), mux);
    return r ? r.blob : null;
  } catch {
    return null;
  }
}

// Blob in, Blob out; null when the stream is not something this converter can carry over unchanged.
export async function tsToMp4(blob) {
  try {
    if (!blob || blob.size < 188 * 4 || blob.size > TS_MP4_MAX_BYTES) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const r = convertTs(bytes);
    return r ? new Blob(r.parts, { type: 'video/mp4' }) : null;
  } catch {
    return null;
  }
}
