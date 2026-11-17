// Tablet page format "PGE2" (see firmware page.h) and drawing it on a canvas
// exactly like the tablet does (same templates, colours and stroke widths).
export const PAGE_W = 1600;            // units across every page
export const LETTER_H = 2070;          // 8.5 x 11 in
export const TPL = { blank: 0, lines: 1, grid: 2, dots: 3 };
export const TPL_NAME = ['blank', 'lines', 'grid', 'dots'];
export const SK_PEN = 0, SK_FOUNTAIN = 1, SK_HIGHLIGHT = 2;
export const PEN_COLORS = ['#111111', '#6B7280', '#DC2626', '#EA580C', '#CA8A04', '#16A34A',
  '#0D9488', '#2563EB', '#4F46E5', '#9333EA', '#DB2777', '#92400E'];
export const TEXT_SIZES = [36, 48, 64];   // text box font size in units (S, M, L)
const LINE_C = '#C3D3EC', MARGIN_C = '#F2BDBD', GRID_C = '#D9E2EF', DOT_C = '#A9B6C8';
const dec = new TextDecoder();

export function c565(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (((n >> 19) & 31) << 11) | (((n >> 10) & 63) << 5) | ((n >> 3) & 31);
}
export function rgbOf565(v) {
  const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
  return [Math.round(r * 255 / 31), Math.round(g * 255 / 63), Math.round(b * 255 / 31)];
}
export const css565 = v => { const [r, g, b] = rgbOf565(v); return `rgb(${r},${g},${b})`; };

export function decodePage(buf) {
  if (!buf) return null;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 24 || String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'PGE2') return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 4;
  const version = dv.getUint32(p, true); p += 4;
  const w = dv.getUint16(p, true), h = dv.getUint16(p + 2, true); p += 4;
  const ns = dv.getUint32(p, true), no = dv.getUint32(p + 4, true); p += 12;
  const strokes = [], objs = [];
  let bottom = 0;
  for (let i = 0; i < ns; i++) {
    if (p + 16 > u8.length) return null;
    const s = { kind: u8[p], flags: u8[p + 1], color: dv.getUint16(p + 2, true), rec: dv.getUint16(p + 4, true), t: dv.getUint32(p + 8, true) };
    const n = dv.getUint32(p + 12, true); p += 16;
    if (p + n * 5 > u8.length) return null;
    s.x = new Int16Array(n); s.y = new Int16Array(n); s.w = new Uint8Array(n);
    for (let k = 0; k < n; k++) { s.x[k] = dv.getInt16(p, true); s.y[k] = dv.getInt16(p + 2, true); s.w[k] = u8[p + 4]; p += 5; }
    for (let k = 0; k < n; k++) bottom = Math.max(bottom, s.y[k] + s.w[k] / 8);
    strokes.push(s);
  }
  for (let i = 0; i < no; i++) {
    if (p + 13 > u8.length) return null;
    const o = { type: u8[p], size: u8[p + 1], color: dv.getUint16(p + 2, true), x: dv.getInt16(p + 4, true), y: dv.getInt16(p + 6, true),
      w: dv.getInt16(p + 8, true), h: dv.getInt16(p + 10, true) };
    const il = u8[p + 12]; p += 13;
    o.id = dec.decode(u8.subarray(p, p + il)); p += il;
    const tl = dv.getUint16(p, true); p += 2;
    o.text = dec.decode(u8.subarray(p, p + tl)); p += tl;
    bottom = Math.max(bottom, o.y + o.h);
    objs.push(o);
  }
  return { version, w, h, strokes, objs, bottom };
}

export const pageHasWork = pg => !!(pg && (pg.strokes.some(s => s.x.length) || pg.objs.length));

// Ruled / grid / dotted paper, from `fromY` (units) down to the page bottom.
export function drawTemplate(ctx, tpl, { k, top = 0, fromY = 0, pageH }) {
  if (!tpl) return;
  const W = PAGE_W * k;
  ctx.save();
  ctx.lineWidth = Math.max(0.6, k * 1.6);
  if (tpl === TPL.lines) {
    const sp = 64, start = Math.ceil(Math.max(fromY, sp * 2) / sp) * sp;
    ctx.strokeStyle = LINE_C; ctx.beginPath();
    for (let y = start; y < pageH; y += sp) { ctx.moveTo(0, top + y * k); ctx.lineTo(W, top + y * k); }
    ctx.stroke();
    ctx.strokeStyle = MARGIN_C; ctx.beginPath(); ctx.moveTo(110 * k, top + fromY * k); ctx.lineTo(110 * k, top + pageH * k); ctx.stroke();
  } else {
    const sp = 40, first = Math.ceil(fromY / sp) * sp;
    if (tpl === TPL.grid) {
      ctx.strokeStyle = GRID_C; ctx.beginPath();
      for (let y = first; y < pageH; y += sp) { ctx.moveTo(0, top + y * k); ctx.lineTo(W, top + y * k); }
      for (let x = 0; x <= PAGE_W; x += sp) { ctx.moveTo(x * k, top + fromY * k); ctx.lineTo(x * k, top + pageH * k); }
      ctx.stroke();
    } else {
      ctx.fillStyle = DOT_C;
      const r = Math.max(0.7, k * 1.8);
      for (let y = first; y < pageH; y += sp) for (let x = sp; x < PAGE_W; x += sp) { ctx.beginPath(); ctx.arc(x * k, top + y * k, r, 0, 7); ctx.fill(); }
    }
  }
  ctx.restore();
}

// Strokes (and optionally text boxes through `drawObj`) at k px per unit.
// Highlighter uses multiply blending like the tablet; pens are drawn on top.
export function drawStrokes(ctx, pg, { k, top = 0 }) {
  if (!pg) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'multiply';
  for (const s of pg.strokes) {
    if (s.kind !== SK_HIGHLIGHT || !s.x.length) continue;
    ctx.strokeStyle = ctx.fillStyle = css565(s.color);
    ctx.lineWidth = Math.max(1, s.w[0] / 4 * k);
    ctx.beginPath(); ctx.moveTo(s.x[0] * k, top + s.y[0] * k);
    if (s.x.length === 1) ctx.lineTo(s.x[0] * k + 0.01, top + s.y[0] * k);
    for (let i = 1; i < s.x.length; i++) ctx.lineTo(s.x[i] * k, top + s.y[i] * k);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  for (const s of pg.strokes) {
    if (s.kind === SK_HIGHLIGHT || !s.x.length) continue;
    ctx.strokeStyle = ctx.fillStyle = css565(s.color);
    const n = s.x.length;
    if (n === 1) { ctx.beginPath(); ctx.arc(s.x[0] * k, top + s.y[0] * k, Math.max(0.5, s.w[0] / 8 * k), 0, 7); ctx.fill(); continue; }
    // runs of nearly equal width become one path (fast); width changes start a new run
    let i = 0;
    while (i < n - 1) {
      const w0 = s.w[i];
      let j = i + 1;
      while (j < n - 1 && Math.abs(s.w[j] - w0) <= Math.max(1, w0 * 0.08)) j++;
      ctx.lineWidth = Math.max(0.7, (s.w[i] + s.w[j]) / 8 * k);
      ctx.beginPath(); ctx.moveTo(s.x[i] * k, top + s.y[i] * k);
      for (let q = i + 1; q <= j; q++) ctx.lineTo(s.x[q] * k, top + s.y[q] * k);
      ctx.stroke();
      i = j;
    }
  }
  ctx.restore();
}

/**
 * Draw a whole page like the tablet shows it.
 * opts: {k, bg (image|canvas covering the page top, page width), tpl, pageH, objImage(o)->img|null, pdfPage (no template under bg)}
 */
export function drawPage(ctx, pg, opts) {
  const { k, bg, tpl, pageH, objImage, top = 0 } = opts;
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.fillRect(0, top, PAGE_W * k, pageH * k);
  let fromY = 0;
  if (bg) {
    const bh = bg.height * PAGE_W / bg.width;
    ctx.drawImage(bg, 0, top, PAGE_W * k, bh * k);
    fromY = bh + 24;
  }
  if (!opts.noTemplate) drawTemplate(ctx, tpl, { k, top, fromY, pageH });
  if (pg && objImage) {
    ctx.globalCompositeOperation = 'multiply';
    for (const o of pg.objs) { const im = objImage(o); if (im) ctx.drawImage(im, o.x * k, top + o.y * k, o.w * k, o.h * k); }
    ctx.globalCompositeOperation = 'source-over';
  }
  drawStrokes(ctx, pg, { k, top });
  ctx.restore();
}
