// Shared by the page-world recorder (injected/youtube_rec.js) and the background (service/main.js).
// Parses fragmented MP4 / WebM and joins one video and one audio track into a single file
// WITHOUT re-encoding. Written as a plain script so it works as a content script,
// as a side-effect ES import and inside Node's vm for tests; it publishes globalThis.__vdlMux.
(() => {
  'use strict';
  // ------------------------------------------------------------ byte helpers ----
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }


  // ------------------------------------------------------------------- MP4 ----
  function mp4Children(b, start, end) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      let hdr = 8;
      if (size === 1) { size = u64(b, o + 8); hdr = 16; }
      if (size < hdr || o + size > end) break;
      out.push({ type: tag(b, o + 4), start: o, hdr, end: o + size });
      o += size;
    }
    return out;
  }
  const mp4Find = (b, box, type) => mp4Children(b, box.start + box.hdr, box.end).find((c) => c.type === type);

  function mp4InitHeight(init) {
    const top = mp4Children(init, 0, init.length);
    const moov = top.find((c) => c.type === 'moov');
    if (!moov) return 0;
    for (const trak of mp4Children(init, moov.start + moov.hdr, moov.end).filter((c) => c.type === 'trak')) {
      const tkhd = mp4Find(init, trak, 'tkhd');
      if (!tkhd) continue;
      const p = tkhd.start + tkhd.hdr;
      const v = init[p];
      const h = u32(init, p + (v === 1 ? 92 : 80)) >>> 16; // 16.16 fixed point
      if (h) return h;
    }
    return 0;
  }

  function mp4FragmentTime(moofBytes) {
    const moof = { start: 0, hdr: 8, end: moofBytes.length };
    const traf = mp4Find(moofBytes, moof, 'traf');
    const tfdt = traf && mp4Find(moofBytes, traf, 'tfdt');
    if (!tfdt) return null;
    const p = tfdt.start + tfdt.hdr;
    return moofBytes[p] === 1 ? u64(moofBytes, p + 4) : u32(moofBytes, p + 4);
  }

  class Mp4Parser {
    constructor(onInit, onFragment) {
      this.onInit = onInit;
      this.onFragment = onFragment;
      this.pending = new Uint8Array(0);
      this.init = [];
      this.moof = null;
      this.moofTime = null;
      this.seekMoof = false; // set after a recording joined a live stream: bytes up to the next moof box are not on a box boundary
    }
    // index of the next moof box (size, 'moof', mfhd first) in b; -1 none; -2 - i: maybe at i, need more bytes
    static findMoof(b) {
      for (let i = 0; i + 8 <= b.length; i++) {
        if (tag(b, i + 4) !== 'moof') continue;
        if (i + 16 > b.length) return -2 - i;
        const size = u32(b, i);
        if (tag(b, i + 12) === 'mfhd' && size >= 16 && size < 8 * 1024 * 1024) return i;
      }
      return -1;
    }
    push(chunk) {
      this.pending = this.pending.length ? concat([this.pending, chunk]) : chunk;
      let b = this.pending;
      if (this.seekMoof) {
        const i = Mp4Parser.findMoof(b);
        if (i === -1) { this.pending = b.length > 16 ? b.slice(b.length - 16) : b; return; }
        b = b.slice(i >= 0 ? i : -2 - i);
        this.pending = b;
        if (i < 0) return;
        this.seekMoof = false;
        this.moof = null;
      }
      let off = 0;
      for (;;) {
        if (b.length - off < 8) break;
        let size = u32(b, off);
        let hdr = 8;
        if (size === 1) {
          if (b.length - off < 16) break;
          size = u64(b, off + 8);
          hdr = 16;
        }
        if (size < hdr) { off = b.length; break; } // garbage / size 0: give up on this buffer
        if (size > 0x20000000) { // not a box boundary (a live stream joined mid-segment): look for the next moof
          this.pending = b.slice(off + 1);
          this.seekMoof = true;
          this.push(new Uint8Array(0));
          return;
        }
        if (b.length - off < size) break;
        const type = tag(b, off + 4);
        const box = b.slice(off, off + size);
        if (type === 'ftyp') this.init = [box];
        else if (type === 'moov') {
          this.init.push(box);
          const init = concat(this.init);
          this.init = [];
          this.onInit(init, { height: mp4InitHeight(init) });
        } else if (type === 'moof') {
          this.moof = box;
          this.moofTime = mp4FragmentTime(box);
        } else if (type === 'mdat') {
          if (this.moof && this.moofTime !== null) this.onFragment(this.moofTime, concat([this.moof, box]));
          this.moof = null;
        } // styp / sidx / emsg / free / prft are dropped
        off += size;
      }
      this.pending = off ? b.slice(off) : b;
    }
  }


  // ------------------------------------------------------------------ WebM ----
  const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, TRACKS: 0x1654ae6b, CLUSTER: 0x1f43b675, TIMECODE: 0xe7, TRACKENTRY: 0xae, VIDEO: 0xe0, PIXELHEIGHT: 0xba };

  function vint(b, o, isId) {
    if (o >= b.length) return null;
    const first = b[o];
    let len = 1;
    let mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8 || o + len > b.length) return null;
    let value = isId ? first : first & (mask - 1);
    let allOnes = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) {
      value = value * 256 + b[o + i];
      if (b[o + i] !== 0xff) allOnes = false;
    }
    return { len, value, unknown: !isId && allOnes };
  }

  function ebmlChildren(b, start, end) {
    const out = [];
    let o = start;
    while (o < end) {
      const id = vint(b, o, true);
      const size = id && vint(b, o + id.len, false);
      if (!id || !size || size.unknown) break;
      const hdr = id.len + size.len;
      if (o + hdr + size.value > end) break;
      out.push({ id: id.value, start: o, hdr, end: o + hdr + size.value });
      o += hdr + size.value;
    }
    return out;
  }

  function webmPixelHeight(tracks) {
    const root = ebmlChildren(tracks, 0, tracks.length)[0];
    if (!root) return 0;
    for (const entry of ebmlChildren(tracks, root.start + root.hdr, root.end).filter((c) => c.id === ID.TRACKENTRY)) {
      const video = ebmlChildren(tracks, entry.start + entry.hdr, entry.end).find((c) => c.id === ID.VIDEO);
      const ph = video && ebmlChildren(tracks, video.start + video.hdr, video.end).find((c) => c.id === ID.PIXELHEIGHT);
      if (ph) { let v = 0; for (let i = ph.start + ph.hdr; i < ph.end; i++) v = v * 256 + tracks[i]; return v; }
    }
    return 0;
  }

  function webmClusterTime(el, hdr) {
    const tc = ebmlChildren(el, hdr, el.length).find((c) => c.id === ID.TIMECODE);
    if (!tc) return null;
    let v = 0;
    for (let i = tc.start + tc.hdr; i < tc.end; i++) v = v * 256 + el[i];
    return v;
  }

  const WEBM_TOP = new Set([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1254c367, 0x114d9b74, 0x1043a770, 0x1941a469]);
  const SEGMENT_UNKNOWN_HEADER = Uint8Array.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

  class WebmParser {
    constructor(onInit, onFragment) {
      this.onInit = onInit;
      this.onFragment = onFragment;
      this.pending = new Uint8Array(0);
      this.init = [];
      this.height = 0;
      this.gotCluster = false;
      this.seekCluster = false; // set after a recording joined a live stream: bytes up to the next Cluster are not on an element boundary
    }
    // index of the next Cluster start (ID + size + Timecode) in b; -1 none; -2 maybe, need more bytes
    static findCluster(b) {
      for (let i = 0; i + 4 <= b.length; i++) {
        if (b[i] !== 0x1f || b[i + 1] !== 0x43 || b[i + 2] !== 0xb6 || b[i + 3] !== 0x75) continue;
        const sz = vint(b, i + 4, false);
        if (!sz || i + 4 + sz.len >= b.length) return -2 - i;
        if (b[i + 4 + sz.len] === 0xe7) return i;
      }
      return -1;
    }
    push(chunk) {
      this.pending = this.pending.length ? concat([this.pending, chunk]) : chunk;
      let b = this.pending;
      if (this.seekCluster) {
        const i = WebmParser.findCluster(b);
        if (i === -1) { this.pending = b.length > 12 ? b.slice(b.length - 12) : b; return; }
        const from = i >= 0 ? i : -2 - i;
        b = b.slice(from);
        if (i < 0) { this.pending = b; return; } // wait for the rest of the header
        this.seekCluster = false;
        this.pending = b;
      }
      let off = 0;
      for (;;) {
        const id = vint(b, off, true);
        const size = id && vint(b, off + id.len, false);
        if (!id || !size) break;
        const hdr = id.len + size.len;
        if (id.value === ID.SEGMENT) { // descend; advertise unknown size so a partial recording still plays
          this.init.push(SEGMENT_UNKNOWN_HEADER);
          off += hdr;
          continue;
        }
        if (size.unknown) {
          if (id.value !== ID.CLUSTER) { off = b.length; break; }
          // live WebM: a cluster of unknown size ends where the next top-level element starts; re-emit it with a real size
          let p = off + hdr;
          let end = -1;
          for (;;) {
            const cid = vint(b, p, true);
            const csz = cid && vint(b, p + cid.len, false);
            if (!cid || !csz) break; // need more data
            if (WEBM_TOP.has(cid.value)) { end = p; break; }
            if (csz.unknown) break;
            const next = p + cid.len + csz.len + csz.value;
            if (next > b.length) break; // child not complete yet
            p = next;
          }
          if (end < 0) {
            // the children could not be walked (unexpected element): find the next cluster header by its bytes instead
            const k = WebmParser.findCluster(b.subarray(off + hdr));
            if (k >= 0) end = off + hdr + k;
          }
          if (end < 0) break;
          const payload = b.slice(off + hdr, end);
          const ph = id.len + 8;
          const el2 = new Uint8Array(ph + payload.length);
          el2.set(b.slice(off, off + id.len), 0);
          el2[id.len] = 0x01;
          let n = payload.length;
          for (let i = 7; i >= 1; i--) { el2[id.len + i] = n % 256; n = Math.floor(n / 256); }
          el2.set(payload, ph);
          if (!this.gotCluster) { this.gotCluster = true; this.onInit(concat(this.init), { height: this.height }); }
          const t2 = webmClusterTime(el2, ph);
          if (t2 !== null) this.onFragment(t2, el2);
          off = end;
          continue;
        }
        const total = hdr + size.value;
        if (b.length - off < total) break;
        const el = b.slice(off, off + total);
        if (id.value === ID.EBML) {
          this.init = [el];
          this.gotCluster = false;
          this.height = 0;
        } else if (id.value === ID.CLUSTER) {
          if (!this.gotCluster) {
            this.gotCluster = true;
            this.onInit(concat(this.init), { height: this.height });
          }
          const t = webmClusterTime(el, hdr);
          if (t !== null) this.onFragment(t, el);
        } else if (!this.gotCluster && (id.value === ID.INFO || id.value === ID.TRACKS)) {
          this.init.push(el);
          if (id.value === ID.TRACKS) this.height = webmPixelHeight(el);
        } // SeekHead / Cues / Tags / Void dropped
        off += total;
      }
      this.pending = off ? b.slice(off) : b;
    }
  }


  // ----------------------------------------------------------------- muxing ----
  // Joins the recorded video and audio into ONE file without re-encoding.
  // MP4: both inits are merged into one moov with two tracks, fragment track ids are patched.
  // WebM: Tracks are merged, video clusters stay byte-identical, audio clusters get a new track number.
  const w32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
  const readBlob = async (blob) => new Uint8Array(await blob.arrayBuffer());

  function mkBox(type, parts) {
    let n = 8;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    w32(out, 0, n);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function mp4Parts(init) {
    const top = mp4Children(init, 0, init.length);
    const ftyp = top.find((c) => c.type === 'ftyp');
    const moov = top.find((c) => c.type === 'moov');
    if (!moov) return null;
    const kids = mp4Children(init, moov.start + moov.hdr, moov.end);
    const traks = kids.filter((c) => c.type === 'trak');
    const mvhd = kids.find((c) => c.type === 'mvhd');
    if (traks.length !== 1 || !mvhd) return null;
    const trak = init.slice(traks[0].start, traks[0].end);
    const tr = { start: 0, hdr: 8, end: trak.length };
    const tkhd = mp4Find(trak, tr, 'tkhd');
    const mdia = mp4Find(trak, tr, 'mdia');
    const mdhd = mdia && mp4Find(trak, mdia, 'mdhd');
    if (!tkhd || !mdhd) return null;
    const tp = tkhd.start + tkhd.hdr;
    const mp = mdhd.start + mdhd.hdr;
    const mvex = kids.find((c) => c.type === 'mvex');
    const trexBox = mvex && mp4Children(init, mvex.start + mvex.hdr, mvex.end).find((c) => c.type === 'trex');
    return {
      ftyp: ftyp ? init.slice(ftyp.start, ftyp.end) : new Uint8Array(0),
      mvhd: init.slice(mvhd.start, mvhd.end),
      trak,
      tkhdIdOff: tp + (trak[tp] === 1 ? 20 : 12),
      trackId: u32(trak, tp + (trak[tp] === 1 ? 20 : 12)),
      timescale: u32(trak, mp + (trak[mp] === 1 ? 20 : 12)),
      trex: trexBox ? init.slice(trexBox.start, trexBox.end) : null,
    };
  }

  const defaultTrex = (id) => { const p = new Uint8Array(24); w32(p, 4, id); w32(p, 8, 1); return mkBox('trex', [p]); };

  async function patchedFragment(blob, trackId) {
    const head = await readBlob(blob.slice(0, 8));
    const moofSize = u32(head, 0);
    if (tag(head, 4) !== 'moof' || moofSize < 16 || moofSize > blob.size) return null;
    const moof = await readBlob(blob.slice(0, moofSize));
    const traf = mp4Find(moof, { start: 0, hdr: 8, end: moof.length }, 'traf');
    const tfhd = traf && mp4Find(moof, traf, 'tfhd');
    if (!tfhd) return null;
    const p = tfhd.start + tfhd.hdr;
    if (u32(moof, p) & 1) return null; // explicit base_data_offset: cannot be moved safely
    w32(moof, p + 4, trackId);
    return new Blob([moof, blob.slice(moofSize)]);
  }

  async function renumberFragment(blob, seq) {
    const head = await readBlob(blob.slice(0, 24));
    if (head.length < 24 || tag(head, 4) !== 'moof' || tag(head, 12) !== 'mfhd') return blob;
    w32(head, 20, seq);
    return new Blob([head, blob.slice(24)]);
  }

  async function mergeMp4(v, a) {
    const vi = mp4Parts(v.init);
    const ai = mp4Parts(a.init);
    if (!vi || !ai) return null;
    const vid = vi.trackId;
    const aid = ai.trackId === vid ? vid + 1 : ai.trackId;
    const atrak0 = ai.trak.slice();
    w32(atrak0, ai.tkhdIdOff, aid);
    // The audio edit list is written for the audio file's own movie timescale; inside the merged movie it can cut the
    // sound to (almost) nothing in strict players. Without it the audio just plays from its first sample.
    const atrak = mkBox('trak', mp4Children(atrak0, 8, atrak0.length).filter((c) => c.type !== 'edts').map((c) => atrak0.slice(c.start, c.end)));
    const atrex = ai.trex ? ai.trex.slice() : defaultTrex(aid);
    w32(atrex, 12, aid);
    const vtrex = vi.trex || defaultTrex(vid);
    const mvhd = vi.mvhd.slice();
    const nextOff = 8 + (mvhd[8] === 1 ? 108 : 96);
    if (mvhd.length >= nextOff + 4) w32(mvhd, nextOff, Math.max(vid, aid) + 1);
    const init = concat([vi.ftyp, mkBox('moov', [mvhd, vi.trak, atrak, mkBox('mvex', [vtrex, atrex])])]);

    const items = [];
    for (const [k, blob] of v.frags) items.push({ t: k / vi.timescale, blob, id: vid, side: 0 });
    for (const [k, blob] of a.frags) items.push({ t: k / ai.timescale, blob, id: aid, side: 1 });
    items.sort((x, y) => x.t - y.t || x.side - y.side);
    const parts = [init];
    for (const it of items) {
      let b = it.side === 0 ? it.blob : await patchedFragment(it.blob, it.id);
      if (!b) return null;
      b = await renumberFragment(b, parts.length); // fragment numbers must grow through the whole file
      parts.push(b);
    }
    return new Blob(parts, { type: 'video/mp4' });
  }

  // ----------------------------------------- fragmented MP4 -> ordinary MP4 ----
  // Players such as VLC and Windows Media Player cope badly with a hand-made fragmented file (two tracks with
  // different fragment lengths, repeated fragment numbers). The fragments are therefore rewritten into one ordinary
  // MP4: one mdat with the untouched sample data, and a moov with full sample tables (stts/ctts/stss/stsz/stsc/stco).
  const be32 = (n) => { const b = new Uint8Array(4); w32(b, 0, n); return b; };
  const w64 = (b, o, v) => { w32(b, o, Math.floor(v / 4294967296)); w32(b, o + 4, v % 4294967296); };
  const fullBox = (type, ver, flags, parts) => mkBox(type, [Uint8Array.of(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts]);
  const i32 = (b, o) => u32(b, o) | 0;

  function trexDefaults(trex) {
    return trex ? { dur: u32(trex, 20), size: u32(trex, 24), flags: u32(trex, 28) } : { dur: 0, size: 0, flags: 0 };
  }

  // moof -> { tfdt, samples:[{dur,size,flags,cts}], runs:[{off,size,count}] } (offsets relative to the moof start)
  function parseMoof(m, defs) {
    const traf = mp4Find(m, { start: 0, hdr: 8, end: m.length }, 'traf');
    if (!traf) return null;
    const kids = mp4Children(m, traf.start + traf.hdr, traf.end);
    const tfhd = kids.find((c) => c.type === 'tfhd');
    const tfdt = kids.find((c) => c.type === 'tfdt');
    if (!tfhd || !tfdt) return null;
    let p = tfhd.start + tfhd.hdr;
    const fl = u32(m, p) & 0xffffff;
    p += 8;
    if (fl & 1) return null; // explicit base_data_offset
    if (fl & 2) p += 4;
    let dDur = defs.dur;
    let dSize = defs.size;
    let dFlags = defs.flags;
    if (fl & 8) { dDur = u32(m, p); p += 4; }
    if (fl & 0x10) { dSize = u32(m, p); p += 4; }
    if (fl & 0x20) { dFlags = u32(m, p); p += 4; }
    const tp = tfdt.start + tfdt.hdr;
    const time = m[tp] === 1 ? u64(m, tp + 4) : u32(m, tp + 4);
    const samples = [];
    const runs = [];
    let cursor = null;
    for (const c of kids.filter((x) => x.type === 'trun')) {
      let q = c.start + c.hdr;
      const ver = m[q];
      const tf = u32(m, q) & 0xffffff;
      const count = u32(m, q + 4);
      q += 8;
      let off = cursor;
      if (tf & 1) { off = i32(m, q); q += 4; }
      if (off === null || off < 0) return null;
      let firstFlags = null;
      if (tf & 4) { firstFlags = u32(m, q); q += 4; }
      let total = 0;
      for (let i = 0; i < count; i++) {
        let dur = dDur;
        let size = dSize;
        let flags = i === 0 && firstFlags !== null ? firstFlags : dFlags;
        let cts = 0;
        if (tf & 0x100) { dur = u32(m, q); q += 4; }
        if (tf & 0x200) { size = u32(m, q); q += 4; }
        if (tf & 0x400) { flags = u32(m, q); q += 4; }
        if (tf & 0x800) { cts = ver ? i32(m, q) : u32(m, q); q += 4; }
        samples.push({ dur, size, flags, cts });
        total += size;
      }
      runs.push({ off, size: total, count });
      cursor = off + total;
    }
    return samples.length ? { tfdt: time, samples, runs } : null;
  }

  // first non-empty entry of the track's edit list: media_time in the track's timescale (0 when there is none)
  function elstMediaTime(trak) {
    const edts = mp4Find(trak, { start: 0, hdr: 8, end: trak.length }, 'edts');
    const elst = edts && mp4Find(trak, edts, 'elst');
    if (!elst) return 0;
    const p = elst.start + elst.hdr;
    const ver = trak[p];
    const n = u32(trak, p + 4);
    for (let i = 0; i < n; i++) {
      const o = p + 8 + i * (ver === 1 ? 20 : 12);
      const mt = ver === 1 ? u64(trak, o + 8) : i32(trak, o + 4);
      if (ver === 1 ? u32(trak, o + 8) !== 0xffffffff : mt >= 0) return mt;
    }
    return 0;
  }

  async function mergeMp4Flat(v, a) {
    const vi = mp4Parts(v.init);
    const ai = mp4Parts(a.init);
    if (!vi || !ai) return null;
    const vid = vi.trackId;
    const aid = ai.trackId === vid ? vid + 1 : ai.trackId;
    const movieTs = u32(vi.mvhd, vi.mvhd[8] === 1 ? 28 : 20);
    if (!movieTs) return null;
    const tracks = [{ info: vi, cap: v, side: 0, id: vid }, { info: ai, cap: a, side: 1, id: aid }];
    for (const T of tracks) {
      T.defs = trexDefaults(T.info.trex);
      T.samples = [];
      T.chunks = [];
      T.t0 = null;
      let expected = 0;
      for (const k of [...T.cap.frags.keys()].sort((x, y) => x - y)) {
        const blob = T.cap.frags.get(k);
        const head = await readBlob(blob.slice(0, 8));
        const moofSize = u32(head, 0);
        if (tag(head, 4) !== 'moof' || moofSize < 16 || moofSize > blob.size) return null;
        const f = parseMoof(await readBlob(blob.slice(0, moofSize)), T.defs);
        if (!f) return null;
        if (T.t0 === null) T.t0 = f.tfdt;
        else if (Math.abs(f.tfdt - expected) > 2) return null; // a gap or an overlap: keep the fragmented path, it keeps the timing
        expected = f.tfdt;
        for (const r of f.runs) {
          if (r.off < moofSize || r.off + r.size > blob.size) return null;
          T.chunks.push({ t: f.tfdt / T.info.timescale, blob, off: r.off, size: r.size, count: r.count });
        }
        for (const s of f.samples) { T.samples.push(s); expected += s.dur; }
      }
      if (!T.samples.length) return null;
      T.mediaDur = T.samples.reduce((n, s) => n + s.dur, 0);
    }
    // both tracks start at the same instant; a track whose first sample is later gets an empty edit in front
    const base = Math.min(...tracks.map((T) => T.t0 / T.info.timescale));
    for (const T of tracks) {
      const lead = Math.round((T.t0 / T.info.timescale - base) * movieTs);
      let mt = elstMediaTime(T.info.trak);
      let seg = Math.round(((T.mediaDur - mt) * movieTs) / T.info.timescale);
      if (seg <= 0) { mt = 0; seg = Math.round((T.mediaDur * movieTs) / T.info.timescale); }
      T.lead = lead;
      T.mt = mt;
      T.seg = seg;
      T.dur = lead + seg;
      if (T.dur > 0xffffffff) return null;
    }
    // data layout: chunks of both tracks in time order
    const order = [];
    for (const T of tracks) T.chunks.forEach((c) => order.push({ T, c }));
    order.sort((x, y) => x.c.t - y.c.t || x.T.side - y.T.side);
    let pos = 0;
    for (const o of order) { o.c.pos = pos; pos += o.c.size; }
    if (pos > 0xffffff00) return null; // would need 64-bit chunk offsets
    const total = pos;

    const rle = (items, same) => {
      const out = [];
      for (const it of items) {
        const last = out[out.length - 1];
        if (last && same(last, it)) last.n++; else out.push({ it, n: 1 });
      }
      return out;
    };
    const stblOf = (T, stsd, dataStart) => {
      const stts = rle(T.samples, (l, s) => l.it.dur === s.dur);
      const boxes = [stsd, fullBox('stts', 0, 0, [be32(stts.length), ...stts.map((e) => concat([be32(e.n), be32(e.it.dur)]))])];
      if (T.samples.some((s) => s.cts !== 0)) {
        const ctts = rle(T.samples, (l, s) => l.it.cts === s.cts);
        const neg = T.samples.some((s) => s.cts < 0);
        boxes.push(fullBox('ctts', neg ? 1 : 0, 0, [be32(ctts.length), ...ctts.map((e) => concat([be32(e.n), be32(e.it.cts)]))]));
      }
      if (T.side === 0 && T.samples.some((s) => s.flags & 0x10000)) {
        const sync = [];
        T.samples.forEach((s, i) => { if (!(s.flags & 0x10000)) sync.push(i + 1); });
        boxes.push(fullBox('stss', 0, 0, [be32(sync.length), ...sync.map(be32)]));
      }
      const stsc = [];
      T.chunks.forEach((c, i) => { const l = stsc[stsc.length - 1]; if (!l || l.n !== c.count) stsc.push({ first: i + 1, n: c.count }); });
      boxes.push(fullBox('stsc', 0, 0, [be32(stsc.length), ...stsc.map((e) => concat([be32(e.first), be32(e.n), be32(1)]))]));
      boxes.push(fullBox('stsz', 0, 0, [be32(0), be32(T.samples.length), ...T.samples.map((s) => be32(s.size))]));
      boxes.push(fullBox('stco', 0, 0, [be32(T.chunks.length), ...T.chunks.map((c) => be32(dataStart + c.pos))]));
      return mkBox('stbl', boxes);
    };
    const trakOf = (T, dataStart) => {
      const trak = T.info.trak;
      const parts = [];
      for (const c of mp4Children(trak, 8, trak.length)) {
        if (c.type === 'edts') continue;
        if (c.type === 'tkhd') {
          const b = trak.slice(c.start, c.end);
          const p = 8;
          if (b[p] === 1) w64(b, p + 28, T.dur); else w32(b, p + 20, T.dur);
          w32(b, T.info.tkhdIdOff - c.start, T.id);
          parts.push(b);
          if (T.lead > 0 || T.mt > 0) {
            const e = [];
            if (T.lead > 0) e.push(concat([be32(T.lead), be32(0xffffffff), be32(0x10000)]));
            e.push(concat([be32(T.seg), be32(T.mt), be32(0x10000)]));
            parts.push(mkBox('edts', [fullBox('elst', 0, 0, [be32(e.length), ...e])]));
          }
        } else if (c.type === 'mdia') {
          const mp = [];
          for (const m of mp4Children(trak, c.start + 8, c.end)) {
            if (m.type === 'mdhd') {
              const b = trak.slice(m.start, m.end);
              if (b[8] === 1) w64(b, 8 + 24, T.mediaDur); else w32(b, 8 + 16, T.mediaDur);
              mp.push(b);
            } else if (m.type === 'minf') {
              const mf = [];
              const oldStbl = mp4Find(trak, m, 'stbl');
              const stsd = oldStbl && mp4Find(trak, oldStbl, 'stsd');
              if (!stsd) return null;
              for (const x of mp4Children(trak, m.start + 8, m.end)) {
                mf.push(x.type === 'stbl' ? stblOf(T, trak.slice(stsd.start, stsd.end), dataStart) : trak.slice(x.start, x.end));
              }
              mp.push(mkBox('minf', mf));
            } else mp.push(trak.slice(m.start, m.end));
          }
          parts.push(mkBox('mdia', mp));
        } else parts.push(trak.slice(c.start, c.end));
      }
      return mkBox('trak', parts);
    };
    const moovOf = (dataStart) => {
      const mvhd = vi.mvhd.slice();
      const ver = mvhd[8];
      const movieDur = Math.max(...tracks.map((T) => T.dur));
      if (ver === 1) w64(mvhd, 32, movieDur); else w32(mvhd, 24, movieDur);
      w32(mvhd, 8 + (ver === 1 ? 108 : 96), Math.max(vid, aid) + 1);
      const traks = tracks.map((T) => trakOf(T, dataStart));
      return traks.some((t) => !t) ? null : mkBox('moov', [mvhd, ...traks]);
    };
    const enc = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
    const ftyp = mkBox('ftyp', [enc('isom'), be32(512), enc('isom'), enc('iso2'), enc('avc1'), enc('mp41')]);
    const probe = moovOf(0);
    if (!probe) return null;
    const moov = moovOf(ftyp.length + probe.length + 8);
    const mdatHead = new Uint8Array(8);
    w32(mdatHead, 0, 8 + total);
    mdatHead.set([0x6d, 0x64, 0x61, 0x74], 4);
    return new Blob([ftyp, moov, mdatHead, ...order.map((o) => o.c.blob.slice(o.c.off, o.c.off + o.c.size))], { type: 'video/mp4' });
  }

  function encodeSize(n) {
    for (let len = 1; len <= 8; len++) {
      if (n < 2 ** (7 * len) - 1) {
        const out = new Uint8Array(len);
        let x = n;
        for (let i = len - 1; i >= 0; i--) { out[i] = x % 256; x = Math.floor(x / 256); }
        out[0] |= 1 << (8 - len);
        return out;
      }
    }
    throw new Error('size');
  }
  function wrapEl(idBytes, parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    return concat([idBytes, encodeSize(n), ...parts]);
  }
  const idBytes = (b, c) => b.slice(c.start, c.start + vint(b, c.start, true).len);
  const uintOf = (b, c) => { let v = 0; for (let i = c.start + c.hdr; i < c.end; i++) v = v * 256 + b[i]; return v; };

  function webmInitParts(init) {
    const ebml = ebmlChildren(init, 0, init.length)[0];
    if (!ebml || ebml.id !== ID.EBML) return null;
    const kids = ebmlChildren(init, ebml.end + SEGMENT_UNKNOWN_HEADER.length, init.length);
    const info = kids.find((c) => c.id === ID.INFO);
    const tracks = kids.find((c) => c.id === ID.TRACKS);
    if (!info || !tracks) return null;
    const entries = ebmlChildren(init, tracks.start + tracks.hdr, tracks.end).filter((c) => c.id === ID.TRACKENTRY);
    if (entries.length !== 1) return null;
    const entry = entries[0];
    const fields = ebmlChildren(init, entry.start + entry.hdr, entry.end);
    const num = fields.find((c) => c.id === 0xd7);
    if (!num) return null;
    return { ebml: init.slice(ebml.start, ebml.end), info: init.slice(info.start, info.end), init, entry, fields, number: uintOf(init, num), uid: fields.find((c) => c.id === 0x73c5) };
  }

  function rebuildBlock(el, k, newNum) {
    const ps = k.start + k.hdr;
    const tn = vint(el, ps, false);
    if (!tn || newNum > 126) return null;
    return wrapEl(idBytes(el, k), [Uint8Array.of(0x80 | newNum), el.slice(ps + tn.len, k.end)]);
  }

  function remapAudioCluster(el, newNum) {
    const cid = vint(el, 0, true);
    const csz = vint(el, cid.len, false);
    const hdr = cid.len + csz.len;
    const parts = [];
    for (const k of ebmlChildren(el, hdr, el.length)) {
      if (k.id === 0xa3) { const r = rebuildBlock(el, k, newNum); if (!r) return null; parts.push(r); }
      else if (k.id === 0xa0) {
        const sub = [];
        for (const s of ebmlChildren(el, k.start + k.hdr, k.end)) {
          if (s.id === 0xa1) { const r = rebuildBlock(el, s, newNum); if (!r) return null; sub.push(r); } else sub.push(el.slice(s.start, s.end));
        }
        parts.push(wrapEl(idBytes(el, k), sub));
      } else parts.push(el.slice(k.start, k.end));
    }
    return wrapEl(el.slice(0, cid.len), parts);
  }

  async function mergeWebm(v, a) {
    const vi = webmInitParts(v.init);
    const ai = webmInitParts(a.init);
    if (!vi || !ai) return null;
    const newNum = vi.number + 1;
    if (newNum > 126) return null;
    const parts = [];
    for (const f of ai.fields) {
      if (f.id === 0xd7) parts.push(Uint8Array.of(0xd7, 0x81, newNum));
      else if (ai.uid && f === ai.uid && vi.uid && uintOf(ai.init, f) === uintOf(vi.init, vi.uid)) parts.push(Uint8Array.of(0x73, 0xc5, 0x81, newNum + 100));
      else parts.push(ai.init.slice(f.start, f.end));
    }
    const audioEntry = wrapEl(idBytes(ai.init, ai.entry), parts);
    const tracksId = Uint8Array.of(0x16, 0x54, 0xae, 0x6b);
    const tracks = wrapEl(tracksId, [vi.init.slice(vi.entry.start, vi.entry.end), audioEntry]);
    const init = concat([vi.ebml, SEGMENT_UNKNOWN_HEADER, vi.info, tracks]);

    const items = [];
    for (const [k, blob] of v.frags) items.push({ t: k, blob, side: 0 });
    for (const [k, blob] of a.frags) items.push({ t: k, blob, side: 1 });
    items.sort((x, y) => x.t - y.t || x.side - y.side);
    const out = [init];
    for (const it of items) {
      if (it.side === 0) { out.push(it.blob); continue; }
      const r = remapAudioCluster(await readBlob(it.blob), newNum);
      if (!r) return null;
      out.push(new Blob([r]));
    }
    return new Blob(out, { type: 'video/webm' });
  }


  // ------------------------------------------- WebM video + MP4 (AAC) audio -> Matroska ----
  // A live/VP9 YouTube stream gives video as WebM and audio as AAC in fragmented MP4. They cannot share a WebM or
  // MP4 file without re-encoding, but Matroska (.mkv) accepts both: the video clusters stay byte-identical, the AAC
  // samples are cut out of the MP4 fragments and written as SimpleBlocks. No decoding.
  function descAt(b, pos, end) { // MPEG-4 descriptor: tag, variable size
    if (pos >= end) return null;
    const tg = b[pos];
    let p = pos + 1;
    let len = 0;
    for (let i = 0; i < 4 && p < end; i++) { const x = b[p++]; len = (len << 7) | (x & 0x7f); if (!(x & 0x80)) break; }
    return { tag: tg, start: p, end: Math.min(end, p + len) };
  }

  function aacInfo(init) { // -> { timescale, asc, channels, rate, trexDur } | null
    const top = mp4Children(init, 0, init.length);
    const moov = top.find((c) => c.type === 'moov');
    if (!moov) return null;
    const kids = mp4Children(init, moov.start + moov.hdr, moov.end);
    const trak = kids.find((c) => c.type === 'trak');
    if (!trak) return null;
    const tr = (box, type) => mp4Children(init, box.start + box.hdr, box.end).find((c) => c.type === type);
    const mdia = tr(trak, 'mdia');
    const mdhd = mdia && tr(mdia, 'mdhd');
    const minf = mdia && tr(mdia, 'minf');
    const stbl = minf && tr(minf, 'stbl');
    const stsd = stbl && tr(stbl, 'stsd');
    if (!mdhd || !stsd) return null;
    const mp = mdhd.start + mdhd.hdr;
    const timescale = u32(init, mp + (init[mp] === 1 ? 20 : 12));
    // stsd: version/flags(4) + entry_count(4), then the first sample entry box
    const entries = mp4Children(init, stsd.start + stsd.hdr + 8, stsd.end);
    const e = entries.find((c) => c.type === 'mp4a');
    if (!e) return null;
    const ep = e.start + e.hdr;
    const channels = (init[ep + 16] << 8) | init[ep + 17];
    const rate = ((init[ep + 24] << 8) | init[ep + 25]) || 0;
    const esds = mp4Children(init, ep + 28, e.end).find((c) => c.type === 'esds');
    if (!esds) return null;
    let asc = null;
    const walk = (pos, end) => {
      while (pos < end && !asc) {
        const d = descAt(init, pos, end);
        if (!d) return;
        if (d.tag === 0x03) walk(d.start + 3 + ((init[d.start + 2] & 0x80) ? 2 : 0) + ((init[d.start + 2] & 0x40) ? 1 + init[d.start + 3 + ((init[d.start + 2] & 0x80) ? 2 : 0)] : 0), d.end);
        else if (d.tag === 0x04) walk(d.start + 13, d.end);
        else if (d.tag === 0x05) asc = init.slice(d.start, d.end);
        pos = d.end;
      }
    };
    walk(esds.start + esds.hdr + 4, esds.end);
    if (!asc || !timescale) return null;
    let trexDur = 1024;
    const mvex = kids.find((c) => c.type === 'mvex');
    const trex = mvex && mp4Children(init, mvex.start + mvex.hdr, mvex.end).find((c) => c.type === 'trex');
    if (trex) trexDur = u32(init, trex.start + trex.hdr + 12) || 1024;
    return { timescale, asc, channels: channels || 2, rate, trexDur };
  }

  // One fragment (moof+mdat bytes) -> { start (timescale units), samples: [{ size, dur, data }] }
  function aacSamples(frag, defDur) {
    const moof = mp4Children(frag, 0, frag.length).find((c) => c.type === 'moof');
    if (!moof) return null;
    const traf = mp4Children(frag, moof.start + moof.hdr, moof.end).find((c) => c.type === 'traf');
    if (!traf) return null;
    const kids = mp4Children(frag, traf.start + traf.hdr, traf.end);
    const tfhd = kids.find((c) => c.type === 'tfhd');
    const tfdt = kids.find((c) => c.type === 'tfdt');
    const trun = kids.find((c) => c.type === 'trun');
    if (!tfhd || !tfdt || !trun) return null;
    let p = tfhd.start + tfhd.hdr;
    const hf = u32(frag, p);
    p += 8; // flags + track id
    let baseOff = moof.start;
    if (hf & 0x1) { baseOff = u64(frag, p); p += 8; }
    if (hf & 0x2) p += 4;
    let dDur = defDur;
    let dSize = 0;
    if (hf & 0x8) { dDur = u32(frag, p); p += 4; }
    if (hf & 0x10) { dSize = u32(frag, p); p += 4; }
    const tp = tfdt.start + tfdt.hdr;
    const start = frag[tp] === 1 ? u64(frag, tp + 4) : u32(frag, tp + 4);
    let q = trun.start + trun.hdr;
    const tf = u32(frag, q);
    const count = u32(frag, q + 4);
    q += 8;
    let dataOff = moof.start;
    if (tf & 0x1) { dataOff = moof.start + (u32(frag, q) | 0); q += 4; }
    else dataOff = baseOff;
    if (tf & 0x4) q += 4;
    const out = [];
    let at = hf & 0x1 ? dataOff : dataOff; // sample data starts at (moof start + data_offset)
    for (let i = 0; i < count; i++) {
      let dur = dDur;
      let size = dSize;
      if (tf & 0x100) { dur = u32(frag, q); q += 4; }
      if (tf & 0x200) { size = u32(frag, q); q += 4; }
      if (tf & 0x400) q += 4;
      if (tf & 0x800) q += 4;
      if (!size || at + size > frag.length) return null;
      out.push({ size, dur: dur || defDur, data: frag.slice(at, at + size) });
      at += size;
    }
    return { start, samples: out };
  }

  const ebmlUint = (idArr, n) => { const bytes = []; let x = n; do { bytes.unshift(x % 256); x = Math.floor(x / 256); } while (x > 0); return concat([Uint8Array.from(idArr), encodeSize(bytes.length), Uint8Array.from(bytes)]); };
  const ebmlStr = (idArr, str) => { const v = Uint8Array.from([...str].map((c) => c.charCodeAt(0))); return concat([Uint8Array.from(idArr), encodeSize(v.length), v]); };
  const ebmlBin = (idArr, v) => concat([Uint8Array.from(idArr), encodeSize(v.length), v]);
  const ebmlF64 = (idArr, x) => { const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, x); return ebmlBin(idArr, new Uint8Array(buf)); };

  // Same cluster with its Timecode lowered by `delta` ms (block timestamps are relative, so nothing else changes).
  function shiftCluster(el, delta) {
    const cid = vint(el, 0, true);
    const csz = vint(el, cid.len, false);
    const hdr = cid.len + csz.len;
    const parts = [];
    for (const k of ebmlChildren(el, hdr, el.length)) {
      if (k.id === ID.TIMECODE) parts.push(ebmlUint([0xe7], Math.max(0, uintOf(el, k) - delta)));
      else parts.push(el.slice(k.start, k.end));
    }
    return wrapEl(el.slice(0, cid.len), parts);
  }

  async function mergeWebmAac(v, a, opts) {
    const vi = webmInitParts(v.init);
    const ai = aacInfo(a.init);
    if (!vi || !ai) return null;
    const num = vi.number + 1;
    if (num > 126) return null;
    const ebml = wrapEl(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), [
      ebmlUint([0x42, 0x86], 1), ebmlUint([0x42, 0xf7], 1), ebmlUint([0x42, 0xf2], 4), ebmlUint([0x42, 0xf3], 8),
      ebmlStr([0x42, 0x82], 'matroska'), ebmlUint([0x42, 0x87], 4), ebmlUint([0x42, 0x85], 2),
    ]);
    const audio = wrapEl(Uint8Array.of(0xae), [
      ebmlUint([0xd7], num), ebmlUint([0x73, 0xc5], 0x7a11 + num), ebmlUint([0x83], 2), ebmlUint([0x9c], 0),
      ebmlStr([0x86], 'A_AAC'), ebmlBin([0x63, 0xa2], ai.asc),
      wrapEl(Uint8Array.of(0xe1), [ebmlF64([0xb5], ai.rate || 48000), ebmlUint([0x9f], ai.channels)]),
    ]);
    const tracks = wrapEl(Uint8Array.of(0x16, 0x54, 0xae, 0x6b), [vi.init.slice(vi.entry.start, vi.entry.end), audio]);
    const init = concat([ebml, SEGMENT_UNKNOWN_HEADER, vi.info, tracks]);

    // Both tracks are cut to the span they have in common (a player buffers audio and video different distances
    // ahead, so a recording starts/ends at different media times) and shifted so the file starts at 0.
    const vKeys = [...v.frags.keys()].sort((x, y) => x - y);
    if (!vKeys.length || !a.frags.size) return null;
    const deltas = vKeys.slice(1).map((k, i) => k - vKeys[i]).sort((x, y) => x - y);
    const vStep = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 2000;
    const vEnd = vKeys[vKeys.length - 1] + vStep;
    const aParsed = [];
    for (const [k, blob] of a.frags) {
      const parsed = aacSamples(await readBlob(blob), ai.trexDur);
      if (parsed && parsed.samples.length) aParsed.push(parsed);
    }
    if (!aParsed.length) return null;
    aParsed.sort((x, y) => x.start - y.start);
    const msOf = (units) => (units * 1000) / ai.timescale;
    const aStart = msOf(aParsed[0].start);
    const last = aParsed[aParsed.length - 1];
    const aEnd = msOf(last.start + last.samples.reduce((n, x) => n + x.dur, 0));
    const from = Math.max(vKeys[0], aStart - vStep); // video clusters ending before the audio begins are useless
    const to = Math.min(vEnd, aEnd);
    if (!(to > Math.max(vKeys[0], aStart))) return null; // no common span
    // whole video clusters only (they start at a keyframe): no picture without sound at the start or the end
    // (YouTube live recording only; other recordings keep the plain common span)
    let keptV = vKeys;
    if (opts && opts.trimSilent) {
      keptV = vKeys.filter((k) => k >= aStart - 100 && k + vStep <= aEnd + 150);
      if (!keptV.length) keptV = vKeys.filter((k) => k + vStep > aStart && k < to); // span shorter than one cluster: keep what overlaps
    }
    if (!keptV.length) return null;
    const spanEnd = opts && opts.trimSilent ? Math.min(aEnd, keptV[keptV.length - 1] + vStep) : to;
    const aGroups = [];
    for (const ap of aParsed) {
      const samples = [];
      let ts = ap.start;
      for (const sm of ap.samples) {
        const ms = msOf(ts);
        if (ms >= Math.max(from, vKeys[0], keptV[0]) && ms < Math.min(to, spanEnd)) samples.push({ ms, data: sm.data });
        ts += sm.dur;
      }
      if (samples.length) aGroups.push(samples);
    }
    if (!aGroups.length) return null;
    const base = Math.round(Math.min(keptV[0], aGroups[0][0].ms));
    const items = [];
    for (const k of keptV) items.push({ t: k - base, blob: v.frags.get(k), side: 0, shift: base });
    for (const samples of aGroups) items.push({ t: Math.round(samples[0].ms) - base, samples, side: 1 });
    items.sort((x, y) => x.t - y.t || x.side - y.side);
    const out = [init];
    let audioClusters = 0;
    for (const it of items) {
      if (it.side === 0) {
        const el = await readBlob(it.blob);
        out.push(new Blob([it.shift ? shiftCluster(el, it.shift) : el]));
        continue;
      }
      const blocks = it.samples.map((sm) => {
        const rel = Math.round(sm.ms) - base - it.t;
        return wrapEl(Uint8Array.of(0xa3), [Uint8Array.of(0x80 | num, (rel >> 8) & 255, rel & 255, 0x80), sm.data]);
      });
      out.push(new Blob([wrapEl(Uint8Array.of(0x1f, 0x43, 0xb6, 0x75), [ebmlUint([0xe7], it.t), ...blocks])]));
      audioClusters++;
    }
    return audioClusters ? new Blob(out, { type: 'video/x-matroska' }) : null;
  }

  // ----------------------------------- MP4 video (AV1 / H.264) + WebM audio (Opus) -> Matroska ----
  // YouTube serves AV1 video as fragmented MP4 and Opus audio as WebM; neither container can hold both, but Matroska
  // can. Like mergeWebmAac this only copies bytes: the video samples are cut out of the MP4 fragments and written as
  // SimpleBlocks, the Opus clusters are renumbered and kept. No decoding, no re-encoding.
  function mp4VideoInfo(init) { // -> { timescale, width, height, codecId, priv, trexDur } | null
    const top = mp4Children(init, 0, init.length);
    const moov = top.find((c) => c.type === 'moov');
    if (!moov) return null;
    const kids = mp4Children(init, moov.start + moov.hdr, moov.end);
    const trak = kids.find((c) => c.type === 'trak');
    if (!trak) return null;
    const sub = (box, type) => mp4Children(init, box.start + box.hdr, box.end).find((c) => c.type === type);
    const mdia = sub(trak, 'mdia');
    const mdhd = mdia && sub(mdia, 'mdhd');
    const minf = mdia && sub(mdia, 'minf');
    const stbl = minf && sub(minf, 'stbl');
    const stsd = stbl && sub(stbl, 'stsd');
    if (!mdhd || !stsd) return null;
    const mp = mdhd.start + mdhd.hdr;
    const timescale = u32(init, mp + (init[mp] === 1 ? 20 : 12));
    const entry = mp4Children(init, stsd.start + stsd.hdr + 8, stsd.end)[0];
    if (!entry || !timescale) return null;
    const CODECS = { av01: ['V_AV1', 'av1C'], avc1: ['V_MPEG4/ISO/AVC', 'avcC'], avc3: ['V_MPEG4/ISO/AVC', 'avcC'] };
    const spec = CODECS[entry.type];
    if (!spec) return null;
    const ep = entry.start + entry.hdr;
    const width = (init[ep + 24] << 8) | init[ep + 25];
    const height = (init[ep + 26] << 8) | init[ep + 27];
    const cfg = mp4Children(init, ep + 78, entry.end).find((c) => c.type === spec[1]);
    if (!cfg || !width || !height) return null;
    const mvex = kids.find((c) => c.type === 'mvex');
    const trex = mvex && mp4Children(init, mvex.start + mvex.hdr, mvex.end).find((c) => c.type === 'trex');
    return { timescale, width, height, codecId: spec[0], priv: init.slice(cfg.start + cfg.hdr, cfg.end), defs: trexDefaults(trex ? init.slice(trex.start, trex.end) : null) };
  }

  // All samples of the video fragments, in decode order: { ms (presentation time), key, data }.
  async function mp4VideoSamples(v, vi) {
    const out = [];
    for (const k of [...v.frags.keys()].sort((x, y) => x - y)) {
      const blob = v.frags.get(k);
      const head = await readBlob(blob.slice(0, 8));
      const moofSize = u32(head, 0);
      if (tag(head, 4) !== 'moof' || moofSize < 16 || moofSize > blob.size) return null;
      const f = parseMoof(await readBlob(blob.slice(0, moofSize)), vi.defs);
      if (!f) return null;
      const bytes = await readBlob(blob);
      let dts = f.tfdt;
      let at = 0;
      let run = 0;
      let runLeft = 0;
      for (const s of f.samples) {
        if (runLeft === 0) { at = f.runs[run].off; runLeft = f.runs[run].count; run++; }
        if (at + s.size > bytes.length) return null;
        out.push({ ms: Math.round(((dts + s.cts) * 1000) / vi.timescale), key: !(s.flags & 0x10000), data: bytes.subarray(at, at + s.size) });
        at += s.size;
        dts += s.dur;
        runLeft--;
      }
    }
    return out.length ? out : null;
  }

  async function mergeMp4Opus(v, a, opts) {
    const vi = mp4VideoInfo(v.init);
    const ai = webmInitParts(a.init);
    if (!vi || !ai) return null;
    // the audio is Opus with the default millisecond clock; anything else is left to the caller (two files)
    const codec = ai.fields.find((c) => c.id === 0x86);
    if (!codec || String.fromCharCode(...ai.init.slice(codec.start + codec.hdr, codec.end)) !== 'A_OPUS') return null;
    const info = ebmlChildren(ai.info, 0, ai.info.length)[0];
    const scale = info && ebmlChildren(ai.info, info.start + info.hdr, info.end).find((c) => c.id === 0x2ad7b1);
    if (scale && uintOf(ai.info, scale) !== 1000000) return null;
    const samples = await mp4VideoSamples(v, vi);
    if (!samples || !a.frags.size) return null;
    const vNum = 1;
    const aNum = 2;

    // spans (ms): video from the first to the end of the last sample, audio from the first cluster to the end of the last
    const vStep = samples.length > 1 ? Math.max(1, Math.round((samples[samples.length - 1].ms - samples[0].ms) / (samples.length - 1))) : 40;
    const vStart = Math.min(...samples.map((s) => s.ms));
    const vEnd = Math.max(...samples.map((s) => s.ms)) + vStep;
    const aKeys = [...a.frags.keys()].sort((x, y) => x - y);
    const aStep = aKeys.length > 1 ? Math.round((aKeys[aKeys.length - 1] - aKeys[0]) / (aKeys.length - 1)) : 10000;
    const aStart = aKeys[0];
    const aEnd = aKeys[aKeys.length - 1] + aStep;
    const from = Math.max(vStart, aStart);
    const to = Math.min(vEnd, aEnd);
    if (!(to > from)) return null; // no common span

    // video: whole runs from a keyframe; the file begins with the first keyframe inside the common span
    // (live recordings: no picture without sound, so it also ends where the audio ends)
    const keyIdx = samples.map((s, i) => (s.key ? i : -1)).filter((i) => i >= 0);
    if (!keyIdx.length) return null;
    let first = keyIdx.find((i) => samples[i].ms >= from - 100);
    if (first === undefined) first = keyIdx[keyIdx.length - 1];
    let kept = samples.slice(first).filter((s) => s.ms < to + (opts && opts.trimSilent ? 0 : vStep));
    if (!kept.length) return null;
    kept = kept.filter((s) => s.ms < to + vStep);
    const keptAudio = aKeys.filter((k) => k + aStep > kept[0].ms && k < to);
    if (!keptAudio.length) return null;
    const base = Math.min(kept[0].ms, keptAudio[0]);

    const ebml = wrapEl(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), [
      ebmlUint([0x42, 0x86], 1), ebmlUint([0x42, 0xf7], 1), ebmlUint([0x42, 0xf2], 4), ebmlUint([0x42, 0xf3], 8),
      ebmlStr([0x42, 0x82], 'matroska'), ebmlUint([0x42, 0x87], 4), ebmlUint([0x42, 0x85], 2),
    ]);
    const segInfo = wrapEl(Uint8Array.of(0x15, 0x49, 0xa9, 0x66), [ebmlUint([0x2a, 0xd7, 0xb1], 1000000), ebmlF64([0x44, 0x89], Math.max(1, Math.min(to, kept[kept.length - 1].ms + vStep) - base)), ebmlStr([0x4d, 0x80], 'Video Downloader Legal'), ebmlStr([0x57, 0x41], 'Video Downloader Legal')]);
    const videoEntry = wrapEl(Uint8Array.of(0xae), [
      ebmlUint([0xd7], vNum), ebmlUint([0x73, 0xc5], 0x7a11 + vNum), ebmlUint([0x83], 1), ebmlUint([0x9c], 0),
      ebmlStr([0x86], vi.codecId), ebmlBin([0x63, 0xa2], vi.priv),
      wrapEl(Uint8Array.of(0xe0), [ebmlUint([0xb0], vi.width), ebmlUint([0xba], vi.height)]),
    ]);
    const aParts = [];
    for (const f of ai.fields) {
      if (f.id === 0xd7) aParts.push(Uint8Array.of(0xd7, 0x81, aNum));
      else if (f.id === 0x73c5) aParts.push(ebmlUint([0x73, 0xc5], 0x7a11 + aNum));
      else aParts.push(ai.init.slice(f.start, f.end));
    }
    const audioEntry = wrapEl(idBytes(ai.init, ai.entry), aParts);
    const tracks = wrapEl(Uint8Array.of(0x16, 0x54, 0xae, 0x6b), [videoEntry, audioEntry]);
    const out = [concat([ebml, SEGMENT_UNKNOWN_HEADER, segInfo, tracks])];

    // video clusters of about two seconds; audio clusters keep their own layout (renumbered track, shifted time)
    const items = [];
    for (let i = 0; i < kept.length;) {
      const t0 = kept[i].ms;
      let j = i;
      while (j < kept.length && kept[j].ms - t0 < 2000 && j - i < 400) j++;
      items.push({ t: t0 - base, side: 0, samples: kept.slice(i, j), t0 });
      i = j;
    }
    for (const k of keptAudio) items.push({ t: k - base, side: 1, key: k });
    items.sort((x, y) => x.t - y.t || x.side - y.side);
    for (const it of items) {
      if (it.side === 0) {
        const blocks = it.samples.map((s) => {
          const rel = s.ms - it.t0;
          return wrapEl(Uint8Array.of(0xa3), [Uint8Array.of(0x80 | vNum, (rel >> 8) & 255, rel & 255, s.key ? 0x80 : 0), s.data]);
        });
        out.push(new Blob([wrapEl(Uint8Array.of(0x1f, 0x43, 0xb6, 0x75), [ebmlUint([0xe7], it.t), ...blocks])]));
        continue;
      }
      const r = remapAudioCluster(await readBlob(a.frags.get(it.key)), aNum);
      if (!r) return null;
      out.push(new Blob([base ? shiftCluster(r, base) : r]));
    }
    return new Blob(out, { type: 'video/x-matroska' });
  }

  // Returns a Blob with both tracks in one file, or null (caller saves separate files).
  async function mergeReps(videoCap, audioCap, opts) {
    try {
      const v = videoCap.best();
      const a = audioCap.best();
      if (!v || !a) return null;
      if (videoCap.container === 'webm' && audioCap.container === 'mp4' && audioCap.kind === 'audio') return await mergeWebmAac(v, a, opts);
      if (videoCap.container === 'mp4' && audioCap.container === 'webm' && audioCap.kind === 'audio') return await mergeMp4Opus(v, a, opts);
      if (videoCap.container !== audioCap.container) return null;
      return videoCap.container === 'webm' ? await mergeWebm(v, a) : ((await mergeMp4Flat(v, a)) || await mergeMp4(v, a));
    } catch { return null; }
  }


  // Parse a whole downloaded file (fragmented MP4 or WebM) into init + fragments.
  async function repFromBlob(blob, container) {
    const rep = { init: null, frags: new Map(), height: 0, bytes: 0 };
    const onInit = (init, meta) => { if (!rep.init) { rep.init = init; rep.height = meta.height || 0; } };
    const onFrag = (time, bytes) => { if (rep.init && !rep.frags.has(time)) { rep.frags.set(time, new Blob([bytes])); rep.bytes += bytes.length; } };
    const parser = container === 'webm' ? new WebmParser(onInit, onFrag) : new Mp4Parser(onInit, onFrag);
    const STEP = 1 << 20;
    for (let o = 0; o < blob.size; o += STEP) parser.push(new Uint8Array(await blob.slice(o, o + STEP).arrayBuffer()));
    return rep.init && rep.frags.size ? rep : null;
  }


  // ---------------------------------------------- progressive (non-fragmented) MP4 ----
  // Two ordinary .mp4 files (one with video, one with audio) -> one file with both tracks, no re-encoding:
  // new moov = video traks + audio trak(s); the original media data of both files is copied untouched and
  // only the chunk offsets (stco/co64) are shifted.
  async function topBoxes(blob) {
    const out = [];
    let pos = 0;
    while (pos + 8 <= blob.size) {
      const h = new Uint8Array(await blob.slice(pos, pos + 16).arrayBuffer());
      let size = u32(h, 0);
      let hdr = 8;
      if (size === 1) { size = u64(h, 8); hdr = 16; } else if (size === 0) size = blob.size - pos;
      if (size < hdr || pos + size > blob.size) break;
      out.push({ type: tag(h, 4), start: pos, end: pos + size, hdr });
      pos += size;
    }
    return out;
  }

  function subBoxes(b, start, end) {
    const out = [];
    let pos = start;
    while (pos + 8 <= end) {
      let size = u32(b, pos);
      let hdr = 8;
      if (size === 1) { size = u64(b, pos + 8); hdr = 16; } else if (size === 0) size = end - pos;
      if (size < hdr || pos + size > end) break;
      out.push({ type: tag(b, pos + 4), start: pos, end: pos + size, hdr });
      pos += size;
    }
    return out;
  }

  const findBox = (b, parent, type) => subBoxes(b, parent.start + parent.hdr, parent.end).find((x) => x.type === type);

  function trakInfo(b, trak) {
    const mdia = findBox(b, trak, 'mdia');
    const hdlr = mdia && findBox(b, mdia, 'hdlr');
    const tkhd = findBox(b, trak, 'tkhd');
    if (!hdlr || !tkhd) return null;
    const kind = tag(b, hdlr.start + hdlr.hdr + 8);
    const ver = b[tkhd.start + tkhd.hdr];
    return { box: trak, kind, tkhd, idOffset: tkhd.start + tkhd.hdr + (ver === 1 ? 20 : 12), id: u32(b, tkhd.start + tkhd.hdr + (ver === 1 ? 20 : 12)) };
  }

  async function readMoovFile(blob) {
    const boxes = await topBoxes(blob);
    if (boxes.some((x) => x.type === 'moof')) return null; // fragmented: another path
    const moov = boxes.find((x) => x.type === 'moov');
    const mdats = boxes.filter((x) => x.type === 'mdat');
    if (!moov || !mdats.length || moov.end - moov.start > 64 * 1024 * 1024) return null;
    const bytes = new Uint8Array(await blob.slice(moov.start, moov.end).arrayBuffer());
    const root = { start: 0, end: bytes.length, hdr: moov.hdr };
    const kids = subBoxes(bytes, root.hdr, bytes.length);
    const mvhd = kids.find((x) => x.type === 'mvhd');
    if (!mvhd) return null;
    const ver = bytes[mvhd.start + mvhd.hdr];
    const timescale = u32(bytes, mvhd.start + mvhd.hdr + (ver === 1 ? 20 : 12));
    const traks = kids.filter((x) => x.type === 'trak').map((t) => trakInfo(bytes, t)).filter(Boolean);
    return {
      blob, bytes, kids, mvhd, mvhdVer: ver, timescale, traks, boxes,
      ftyp: boxes.find((x) => x.type === 'ftyp'),
      region: { start: Math.min(...mdats.map((x) => x.start)), end: Math.max(...mdats.map((x) => x.end)) },
    };
  }

  const setU32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };

  async function mergeProgressiveMp4(videoBlob, audioBlob) {
    const v = await readMoovFile(videoBlob);
    const a = v && await readMoovFile(audioBlob);
    if (!v || !a || !v.ftyp) return null;
    const vt = v.traks.filter((t) => t.kind === 'vide');
    const at = a.traks.filter((t) => t.kind === 'soun');
    if (!vt.length || !at.length) return null;

    // trak bytes (copied); the audio trak loses its edit list when the movie timescales differ
    const sameScale = v.timescale === a.timescale;
    const trakBytes = (src, t, dropEdts) => {
      const kids = subBoxes(src.bytes, t.box.start + t.box.hdr, t.box.end).filter((k) => !(dropEdts && k.type === 'edts'));
      const body = kids.map((k) => src.bytes.slice(k.start, k.end));
      return concat([mkBox('trak', body)]);
    };
    const vTraks = vt.map((t) => trakBytes(v, t, false));
    const aTraks = at.map((t) => trakBytes(a, t, !sameScale));
    // unique track ids; the audio traks get ids after the video ones
    const maxVid = Math.max(...vt.map((t) => t.id));
    aTraks.forEach((tb, i) => {
      const tk = findBox(tb, { start: 0, end: tb.length, hdr: 8 }, 'tkhd');
      const ver = tb[tk.start + tk.hdr];
      setU32(tb, tk.start + tk.hdr + (ver === 1 ? 20 : 12), maxVid + 1 + i);
    });
    const mvhdBytes = v.bytes.slice(v.mvhd.start, v.mvhd.end);
    setU32(mvhdBytes, v.mvhd.hdr + (v.mvhdVer === 1 ? 108 : 96), maxVid + aTraks.length + 1);
    const moov = mkBox('moov', [mvhdBytes, ...vTraks, ...aTraks]);

    const ftyp = new Uint8Array(await videoBlob.slice(v.ftyp.start, v.ftyp.end).arrayBuffer());
    const vLen = v.region.end - v.region.start;
    const aLen = a.region.end - a.region.start;
    const mdatHdr = new Uint8Array(8);
    setU32(mdatHdr, 0, 8 + vLen + aLen);
    mdatHdr.set([0x6d, 0x64, 0x61, 0x74], 4);
    if (8 + vLen + aLen > 0xffffffff) return null;
    const vNew = ftyp.length + moov.length + 8;
    const aNew = vNew + vLen;
    const deltaV = vNew - v.region.start;
    const deltaA = aNew - a.region.start;

    // shift chunk offsets inside the final moov
    const finalKids = subBoxes(moov, 8, moov.length).filter((k) => k.type === 'trak');
    let ok = true;
    finalKids.forEach((trak, idx) => {
      const delta = idx < vTraks.length ? deltaV : deltaA;
      const mdia = findBox(moov, trak, 'mdia');
      const minf = mdia && findBox(moov, mdia, 'minf');
      const stbl = minf && findBox(moov, minf, 'stbl');
      const co = stbl && (findBox(moov, stbl, 'stco') || findBox(moov, stbl, 'co64'));
      if (!co) { ok = false; return; }
      const p = co.start + co.hdr;
      const n = u32(moov, p + 4);
      if (co.type === 'stco') {
        for (let i = 0; i < n; i++) {
          const o = p + 8 + i * 4;
          const val = u32(moov, o) + delta;
          if (val < 0 || val > 0xffffffff) { ok = false; return; }
          setU32(moov, o, val);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const o = p + 8 + i * 8;
          const val = u64(moov, o) + delta;
          if (val < 0) { ok = false; return; }
          setU32(moov, o, Math.floor(val / 4294967296));
          setU32(moov, o + 4, val >>> 0);
        }
      }
    });
    if (!ok) return null;
    return new Blob([ftyp, moov, mdatHdr, videoBlob.slice(v.region.start, v.region.end), audioBlob.slice(a.region.start, a.region.end)], { type: 'video/mp4' });
  }

  // Joins separately downloaded video and audio files into one; null when not possible.
  async function mergeBlobs(videoBlob, audioBlob, container) {
    try {
      if (videoBlob.size + audioBlob.size > 1.5 * 1024 * 1024 * 1024) return null;
      const v = await repFromBlob(videoBlob, container);
      const a = v && await repFromBlob(audioBlob, container);
      if (v && a) return container === 'webm' ? await mergeWebm(v, a) : ((await mergeMp4Flat(v, a)) || await mergeMp4(v, a));
      // ordinary (non-fragmented) MP4 files, e.g. DASH "one file per representation"
      return container === 'webm' ? null : await mergeProgressiveMp4(videoBlob, audioBlob);
    } catch { return null; }
  }

  const api = { Mp4Parser, WebmParser, mp4InitHeight, webmPixelHeight, concat, mergeReps, mergeMp4, mergeMp4Flat, mergeWebm, mergeWebmAac, mergeMp4Opus, mergeBlobs, mergeProgressiveMp4, repFromBlob };
  globalThis.__vdlMux = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
