// Compact description of an MP4 initialization segment / file head (for diagnostics only): which tracks it has,
// their timescales, sample entry types and edit lists. No media data, no URLs.

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function boxes(b, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(b, pos);
    let hdr = 8;
    if (size === 1) { size = u32(b, pos + 12); hdr = 16; } else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) break;
    out.push({ type: tag(b, pos + 4), start: pos, end: pos + size, hdr });
    pos += size;
  }
  return out;
}
const find = (b, box, type) => boxes(b, box.start + box.hdr, box.end).find((x) => x.type === type);

export function describeInit(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const top = boxes(b, 0, b.length);
  const out = { top: top.map((x) => x.type).slice(0, 8), brand: '', movieTimescale: 0, fragmented: false, tracks: [] };
  const ftyp = top.find((x) => x.type === 'ftyp');
  if (ftyp) out.brand = tag(b, ftyp.start + 8);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) return out;
  const kids = boxes(b, moov.start + moov.hdr, moov.end);
  const mvhd = kids.find((x) => x.type === 'mvhd');
  if (mvhd) out.movieTimescale = u32(b, mvhd.start + mvhd.hdr + (b[mvhd.start + mvhd.hdr] === 1 ? 20 : 12));
  out.fragmented = kids.some((x) => x.type === 'mvex');
  for (const trak of kids.filter((x) => x.type === 'trak')) {
    const t = { id: 0, flags: 0, handler: '', timescale: 0, entry: '', edits: [] };
    const tkhd = find(b, trak, 'tkhd');
    if (tkhd) {
      const v = b[tkhd.start + tkhd.hdr];
      t.flags = (b[tkhd.start + tkhd.hdr + 1] << 16) | (b[tkhd.start + tkhd.hdr + 2] << 8) | b[tkhd.start + tkhd.hdr + 3];
      t.id = u32(b, tkhd.start + tkhd.hdr + (v === 1 ? 20 : 12));
    }
    const mdia = find(b, trak, 'mdia');
    if (mdia) {
      const mdhd = find(b, mdia, 'mdhd');
      if (mdhd) t.timescale = u32(b, mdhd.start + mdhd.hdr + (b[mdhd.start + mdhd.hdr] === 1 ? 20 : 12));
      const hdlr = find(b, mdia, 'hdlr');
      if (hdlr) t.handler = tag(b, hdlr.start + hdlr.hdr + 8);
      const minf = find(b, mdia, 'minf');
      const stbl = minf && find(b, minf, 'stbl');
      const stsd = stbl && find(b, stbl, 'stsd');
      if (stsd && stsd.start + stsd.hdr + 16 <= stsd.end) t.entry = tag(b, stsd.start + stsd.hdr + 12);
    }
    const edts = find(b, trak, 'edts');
    const elst = edts && find(b, edts, 'elst');
    if (elst) {
      const ver = b[elst.start + elst.hdr];
      const n = Math.min(u32(b, elst.start + elst.hdr + 4), 4);
      let o = elst.start + elst.hdr + 8;
      for (let i = 0; i < n; i++) {
        if (ver === 1) { t.edits.push({ dur: u32(b, o + 4), media: u32(b, o + 12) | 0 }); o += 20; } else { t.edits.push({ dur: u32(b, o), media: u32(b, o + 4) | 0 }); o += 12; }
      }
    }
    out.tracks.push(t);
  }
  return out;
}
