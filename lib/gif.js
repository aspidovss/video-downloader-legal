// Animated GIF encoder (own code, 1.6.4): frames come in one at a time (RGBA), only the encoded bytes are kept.
// Every frame gets its own palette (median cut, 255 colours). Pixels that did not change visibly against what is
// already on screen are written as transparent, and only the box around the changed pixels is stored, so still
// backgrounds cost almost nothing. No dithering (it makes the file larger and flickers).

const TRANSPARENT = 255;

// ---- palette (median cut on a 5-bit-per-channel histogram) ----------------
function medianCut(hist, maxColors) {
  // hist: Map(bin -> count); bin = r5 << 10 | g5 << 5 | b5
  const entries = [];
  for (const [bin, n] of hist) entries.push({ r: (bin >> 10) & 31, g: (bin >> 5) & 31, b: bin & 31, n, bin });
  if (!entries.length) return [];
  const boxOf = (list) => {
    let r0 = 31, r1 = 0, g0 = 31, g1 = 0, b0 = 31, b1 = 0, n = 0;
    for (const e of list) {
      if (e.r < r0) r0 = e.r; if (e.r > r1) r1 = e.r;
      if (e.g < g0) g0 = e.g; if (e.g > g1) g1 = e.g;
      if (e.b < b0) b0 = e.b; if (e.b > b1) b1 = e.b;
      n += e.n;
    }
    const dr = r1 - r0, dg = g1 - g0, db = b1 - b0;
    const ch = dg >= dr && dg >= db ? 'g' : dr >= db ? 'r' : 'b';
    return { list, n, span: Math.max(dr, dg, db), ch };
  };
  const boxes = [boxOf(entries)];
  while (boxes.length < maxColors) {
    let pick = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.list.length < 2 || bx.span === 0) continue;
      const score = bx.span * Math.sqrt(bx.n);
      if (score > best) { best = score; pick = i; }
    }
    if (pick < 0) break;
    const bx = boxes[pick];
    const ch = bx.ch;
    bx.list.sort((a, b) => a[ch] - b[ch]);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < bx.list.length - 1; i++) {
      acc += bx.list[i].n;
      if (acc >= bx.n / 2) { cut = i + 1; break; }
      cut = i + 1;
    }
    boxes.splice(pick, 1, boxOf(bx.list.slice(0, cut)), boxOf(bx.list.slice(cut)));
  }
  return boxes.map((bx) => {
    let r = 0, g = 0, b = 0;
    for (const e of bx.list) { r += e.r * e.n; g += e.g * e.n; b += e.b * e.n; }
    const k = 255 / 31 / bx.n;
    return { rgb: [Math.round(r * k), Math.round(g * k), Math.round(b * k)], bins: bx.list.map((e) => e.bin) };
  });
}

// ---- LZW ----------------------------------------------------------------------
function lzw(indices, minCode = 8) {
  const out = [];
  let cur = 0;
  let nbits = 0;
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let next = eoi + 1;
  let dict = new Map();
  const put = (code) => {
    cur |= code << nbits;
    nbits += size;
    while (nbits >= 8) { out.push(cur & 255); cur >>>= 8; nbits -= 8; }
  };
  put(clear);
  let prefix = indices.length ? indices[0] : -1;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    put(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      put(clear);
      dict = new Map();
      size = minCode + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  if (prefix >= 0) put(prefix);
  put(eoi);
  if (nbits > 0) out.push(cur & 255);
  // sub-blocks of at most 255 bytes
  const blocks = [minCode];
  for (let i = 0; i < out.length; i += 255) {
    const n = Math.min(255, out.length - i);
    blocks.push(n);
    for (let j = 0; j < n; j++) blocks.push(out[i + j]);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

const le16 = (v) => [v & 255, (v >> 8) & 255];

// ---- encoder ---------------------------------------------------------------------
// opts.threshold: how much a pixel may differ (sum of |dR|+|dG|+|dB|) from the screen to be left transparent
export function createGifEncoder(width, height, { loop = 0, threshold = 18 } = {}) {
  if (!(width > 0 && height > 0 && width < 65536 && height < 65536)) throw new Error('gif: bad size');
  const parts = [];
  parts.push(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(width), ...le16(height), 0x00, 0, 0]));
  // NETSCAPE2.0: repeat forever (0) or n times
  parts.push(Uint8Array.from([0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 0x03, 0x01, ...le16(loop), 0x00]));
  const screen = new Uint8Array(width * height * 3); // what is shown after the frames so far
  let frames = 0;
  let bytes = parts[0].length + parts[1].length;

  return {
    get frames() { return frames; },
    get bytes() { return bytes; },
    // rgba: Uint8Array / Uint8ClampedArray of width * height * 4; delayCs: hundredths of a second
    addFrame(rgba, delayCs = 10) {
      const n = width * height;
      const changed = new Uint8Array(n);
      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      for (let p = 0, y = 0; y < height; y++) {
        for (let x = 0; x < width; x++, p++) {
          const q = p * 4;
          const s = p * 3;
          const diff = Math.abs(rgba[q] - screen[s]) + Math.abs(rgba[q + 1] - screen[s + 1]) + Math.abs(rgba[q + 2] - screen[s + 2]);
          if (frames === 0 || diff > threshold) {
            changed[p] = 1;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; } // nothing changed: one transparent pixel
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      // palette of the changed pixels
      const hist = new Map();
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const p = y * width + x;
          if (!changed[p]) continue;
          const q = p * 4;
          const bin = ((rgba[q] >> 3) << 10) | ((rgba[q + 1] >> 3) << 5) | (rgba[q + 2] >> 3);
          hist.set(bin, (hist.get(bin) || 0) + 1);
        }
      }
      const pal = medianCut(hist, 255);
      const lookup = new Map();
      pal.forEach((c, i) => { for (const bin of c.bins) lookup.set(bin, i); });
      const idx = new Uint8Array(w * h);
      for (let y = y0, k = 0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++, k++) {
          const p = y * width + x;
          if (!changed[p]) { idx[k] = TRANSPARENT; continue; }
          const q = p * 4;
          const bin = ((rgba[q] >> 3) << 10) | ((rgba[q + 1] >> 3) << 5) | (rgba[q + 2] >> 3);
          const i = lookup.get(bin) ?? 0;
          idx[k] = i;
          const c = pal[i].rgb;
          const s = p * 3;
          screen[s] = c[0]; screen[s + 1] = c[1]; screen[s + 2] = c[2];
        }
      }
      const table = new Uint8Array(256 * 3);
      pal.forEach((c, i) => table.set(c.rgb, i * 3));
      const d = Math.max(2, Math.min(65535, Math.round(delayCs)));
      const head = Uint8Array.from([
        0x21, 0xf9, 0x04, (1 << 2) | 1, ...le16(d), TRANSPARENT, 0x00, // graphic control: do not dispose, transparent index
        0x2c, ...le16(x0), ...le16(y0), ...le16(w), ...le16(h), 0x80 | 7, // image descriptor + local table of 256
      ]);
      const data = lzw(idx, 8);
      parts.push(head, table, data);
      bytes += head.length + table.length + data.length;
      frames++;
    },
    finish() {
      parts.push(Uint8Array.of(0x3b));
      bytes += 1;
      return parts;
    },
  };
}

// Size of a GIF made from a video: width at most maxWidth, even numbers kept.
export function gifSize(srcW, srcH, maxWidth) {
  if (!(srcW > 0 && srcH > 0)) return { width: maxWidth, height: Math.round(maxWidth * 9 / 16) };
  const w = Math.min(srcW, maxWidth);
  return { width: Math.max(2, Math.round(w)), height: Math.max(2, Math.round(srcH * w / srcW)) };
}
