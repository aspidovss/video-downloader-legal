// Captions on a GIF made in the converter (1.6.7). Three styles:
//   bar         - white bar(s) above and / or below the video with black bold text ("67676767" memes)
//   overlay     - white text with a black outline (or black with white) on the video: top / center / bottom
//   demotivator - the video in a thin white frame on black, a big white serif title and a smaller line under it
// captionLayout() is pure (text width comes from a measure function), so it is tested in Node;
// drawCaption() paints the static parts and the text with a canvas 2D context.
import { gifSize } from './gif.js';

export const CAPTION_STYLES = ['none', 'bar', 'overlay', 'demotivator'];
export const BAR_POS = ['top', 'bottom', 'both'];
export const OVERLAY_POS = ['top', 'center', 'bottom'];
export const OVERLAY_COLORS = ['white', 'black'];

export const FONTS = {
  bar: (px) => `bold ${px}px "Arial Black", "Segoe UI Black", "Segoe UI", Arial, sans-serif`,
  overlay: (px) => `bold ${px}px Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif`,
  title: (px) => `${px}px "Times New Roman", Times, Georgia, serif`,
  sub: (px) => `${px}px "Times New Roman", Times, Georgia, serif`,
};

// remembered between runs: the style and the positions (not the text)
export function captionPrefs(p = {}) {
  return {
    style: CAPTION_STYLES.includes(p.style) ? p.style : 'none',
    barPos: BAR_POS.includes(p.barPos) ? p.barPos : 'top',
    overlayPos: OVERLAY_POS.includes(p.overlayPos) ? p.overlayPos : 'bottom',
    overlayColor: OVERLAY_COLORS.includes(p.overlayColor) ? p.overlayColor : 'white',
  };
}

// words into lines no wider than maxWidth (a word wider than the line is cut by characters); "\n" starts a new line
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const para of String(text || '').split(/\r?\n/)) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    let line = '';
    for (let w of words) {
      while (measure(w) > maxWidth && w.length > 1) { // a very long word: as many characters as fit
        let n = w.length - 1;
        while (n > 1 && measure(w.slice(0, n)) > maxWidth) n--;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, n));
        w = w.slice(n);
      }
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next) > maxWidth) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

// the biggest font size (from `start` down to `min`) at which the text takes at most maxLines lines
export function fitText(text, maxWidth, maxLines, start, min, measureAt) {
  let px = Math.max(min, Math.round(start));
  for (;;) {
    const lines = wrapText(text, maxWidth, (s) => measureAt(s, px));
    if (lines.length <= maxLines || px <= min) return { px, lines: lines.slice(0, Math.max(maxLines, 1)) };
    px = Math.max(min, Math.round(px * 0.9));
  }
}

const clean = (s) => String(s || '').trim();

// srcW / srcH: the video; maxWidth: the GIF width chosen; cap: { style, barPos, overlayPos, overlayColor, top, bottom, text, title, sub }
// measureAt(text, px, font) -> width in pixels.
// -> { width, height, video: { x, y, w, h }, background, blocks: [{ kind, x, y, w, h }], texts: [{ lines, px, font, x, y, lineH, fill, stroke, strokeW }] }
export function captionLayout(srcW, srcH, maxWidth, cap = {}, measureAt) {
  const style = CAPTION_STYLES.includes(cap.style) ? cap.style : 'none';
  if (style === 'demotivator') return demotivator(srcW, srcH, maxWidth, cap, measureAt);
  const { width: w, height: h } = gifSize(srcW, srcH, maxWidth);
  const out = { width: w, height: h, video: { x: 0, y: 0, w, h }, background: '', blocks: [], texts: [] };
  if (style === 'bar') {
    const pos = BAR_POS.includes(cap.barPos) ? cap.barPos : 'top';
    const want = [];
    if (pos !== 'bottom' && clean(cap.top)) want.push(['top', clean(cap.top)]);
    if (pos !== 'top' && clean(cap.bottom)) want.push(['bottom', clean(cap.bottom)]);
    const font = FONTS.bar;
    const m = (s, px) => measureAt(s, px, font(px));
    let y = 0;
    const bars = want.map(([where, text]) => {
      const fit = fitText(text, w * 0.92, 3, Math.max(14, w * 0.085), 10, m);
      const lineH = Math.round(fit.px * 1.18);
      const pad = Math.round(fit.px * 0.42);
      return { where, fit, lineH, pad, hBar: fit.lines.length * lineH + pad * 2 };
    });
    const top = bars.find((b) => b.where === 'top');
    const bottom = bars.find((b) => b.where === 'bottom');
    if (top) { out.blocks.push({ kind: 'white', x: 0, y: 0, w, h: top.hBar }); y = top.hBar; }
    out.video.y = y;
    if (bottom) out.blocks.push({ kind: 'white', x: 0, y: y + h, w, h: bottom.hBar });
    out.height = y + h + (bottom ? bottom.hBar : 0);
    for (const b of bars) {
      const y0 = b.where === 'top' ? 0 : y + h;
      out.texts.push({ lines: b.fit.lines, px: b.fit.px, font: font(b.fit.px), x: w / 2, y: y0 + b.pad + b.lineH / 2, lineH: b.lineH, fill: '#000' });
    }
  } else if (style === 'overlay' && clean(cap.text)) {
    const font = FONTS.overlay;
    const fit = fitText(clean(cap.text), w * 0.92, 3, Math.max(14, w * 0.1), 10, (s, px) => measureAt(s, px, font(px)));
    const lineH = Math.round(fit.px * 1.1);
    const blockH = fit.lines.length * lineH;
    const margin = Math.round(Math.max(4, h * 0.04));
    const pos = OVERLAY_POS.includes(cap.overlayPos) ? cap.overlayPos : 'bottom';
    const top = pos === 'top' ? margin : pos === 'center' ? (h - blockH) / 2 : h - margin - blockH;
    const white = cap.overlayColor !== 'black';
    out.texts.push({ lines: fit.lines, px: fit.px, font: font(fit.px), x: w / 2, y: top + lineH / 2, lineH, fill: white ? '#fff' : '#000', stroke: white ? '#000' : '#fff', strokeW: Math.max(2, Math.round(fit.px * 0.14)) });
  }
  return out;
}

function demotivator(srcW, srcH, maxWidth, cap, measureAt) {
  const W = Math.max(120, Math.round(maxWidth));
  const margin = Math.round(W * 0.08);
  const gap = Math.max(3, Math.round(W * 0.008)); // black space between the video and the frame line
  const line = Math.max(1, Math.round(W * 0.004));
  const inner = W - 2 * (margin + gap + line);
  const { width: vw, height: vh } = gifSize(srcW, srcH, inner);
  const vx = Math.round((W - vw) / 2);
  const vy = margin + gap + line;
  const frame = { x: vx - gap - line, y: vy - gap - line, w: vw + 2 * (gap + line), h: vh + 2 * (gap + line) };
  const textW = W - 2 * Math.round(W * 0.06);
  const texts = [];
  let y = frame.y + frame.h + Math.round(W * 0.035);
  const title = clean(cap.title), sub = clean(cap.sub);
  if (title) {
    const fit = fitText(title, textW, 2, W * 0.085, 12, (s, px) => measureAt(s, px, FONTS.title(px)));
    const lineH = Math.round(fit.px * 1.15);
    texts.push({ lines: fit.lines, px: fit.px, font: FONTS.title(fit.px), x: W / 2, y: y + lineH / 2, lineH, fill: '#fff' });
    y += fit.lines.length * lineH + Math.round(W * 0.012);
  }
  if (sub) {
    const fit = fitText(sub, textW, 2, W * 0.042, 10, (s, px) => measureAt(s, px, FONTS.sub(px)));
    const lineH = Math.round(fit.px * 1.25);
    texts.push({ lines: fit.lines, px: fit.px, font: FONTS.sub(fit.px), x: W / 2, y: y + lineH / 2, lineH, fill: '#fff' });
    y += fit.lines.length * lineH;
  }
  const H = Math.round(y + (title || sub ? W * 0.05 : margin - Math.round(W * 0.035)));
  return { width: W, height: H, video: { x: vx, y: vy, w: vw, h: vh }, background: '#000', blocks: [{ kind: 'frame', ...frame, line }], texts };
}

// static parts under the video (background, bars, frame)
export function drawBackdrop(ctx, L) {
  if (L.background) { ctx.fillStyle = L.background; ctx.fillRect(0, 0, L.width, L.height); }
  for (const b of L.blocks) {
    if (b.kind === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(b.x, b.y, b.w, b.h); }
    else if (b.kind === 'frame') { ctx.strokeStyle = '#fff'; ctx.lineWidth = b.line; ctx.strokeRect(b.x + b.line / 2, b.y + b.line / 2, b.w - b.line, b.h - b.line); }
  }
}

// the text over everything
export function drawTexts(ctx, L) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const t of L.texts) {
    ctx.font = t.font;
    t.lines.forEach((s, i) => {
      const y = t.y + i * t.lineH;
      if (t.stroke) { ctx.strokeStyle = t.stroke; ctx.lineWidth = t.strokeW; ctx.strokeText(s, t.x, y); }
      ctx.fillStyle = t.fill;
      ctx.fillText(s, t.x, y);
    });
  }
  ctx.restore();
}

// a canvas-based measure function for captionLayout()
export function canvasMeasure(doc = globalThis.document) {
  const ctx = doc.createElement('canvas').getContext('2d');
  return (s, px, font) => { ctx.font = font; return ctx.measureText(s).width; };
}
