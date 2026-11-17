// Builds the finished PDF.
// - Homework: one Letter-width page per tablet page: the question at the top,
//   the paper (lines/grid/dots) below it, and the handwriting as vector lines.
// - Annotated PDF: the original PDF pages (still vector, still selectable text)
//   with the handwriting, highlighter and text boxes drawn on top; pages added on
//   the tablet become blank pages in the right place.
import { PAGE_W, TPL, SK_HIGHLIGHT, rgbOf565 } from './page.js';
import { pagesOf, tplFor } from './model.js';

const LETTER_W = 612;
const LINE_C = [0xC3, 0xD3, 0xEC], MARGIN_C = [0xF2, 0xBD, 0xBD], GRID_C = [0xD9, 0xE2, 0xEF], DOT_C = [0xA9, 0xB6, 0xC8];

/**
 * opts: {
 *   pages: Map(pageId -> decoded PGE2 | null),
 *   background(page) -> Promise<{jpg: Uint8Array, bh: units} | null>   (homework question picture, high-res)
 *   pageImage(page) -> Promise<Uint8Array JPEG>      (raster of an original page, used when vector copy isn't possible)
 *   pdfBytes: Uint8Array | null                      (original PDF for annotate records)
 *   textImage(obj) -> Promise<Uint8Array PNG | null> (transparent picture of a text box)
 * }
 */
export async function buildPdf(a, opts) {
  const L = window.PDFLib;
  if (!L) throw new Error('PDF library failed to load');
  const { PDFDocument, rgb, LineCapStyle, BlendMode } = L;
  const col = c => rgb(c[0] / 255, c[1] / 255, c[2] / 255);
  const doc = await PDFDocument.create();
  doc.setTitle([a.subject, a.title].filter(Boolean).join(' - ') || 'Homework');
  doc.setCreator('Homework Tablet');

  let src = null;
  if (a.kind === 'pdf' && opts.pdfBytes) {
    try { src = await PDFDocument.load(opts.pdfBytes, { ignoreEncryption: true }); } catch (e) { src = null; }
  }

  // ---- drawing helpers: x/y in units, page origin (ox, oyTop) in points, k = pt per unit
  const drawTemplate = (page, tpl, g, fromY, pageH) => {
    const { ox, top, k } = g, W = PAGE_W * k;
    const Y = u => top - u * k;
    if (tpl === TPL.lines) {
      for (let u = Math.ceil(Math.max(fromY, 128) / 64) * 64; u < pageH; u += 64)
        page.drawLine({ start: { x: ox, y: Y(u) }, end: { x: ox + W, y: Y(u) }, thickness: 0.5, color: col(LINE_C) });
      page.drawLine({ start: { x: ox + 110 * k, y: Y(fromY) }, end: { x: ox + 110 * k, y: Y(pageH) }, thickness: 0.5, color: col(MARGIN_C) });
    } else if (tpl === TPL.grid) {
      const first = Math.ceil(fromY / 40) * 40;
      for (let u = first; u < pageH; u += 40) page.drawLine({ start: { x: ox, y: Y(u) }, end: { x: ox + W, y: Y(u) }, thickness: 0.4, color: col(GRID_C) });
      for (let x = 0; x <= PAGE_W; x += 40) page.drawLine({ start: { x: ox + x * k, y: Y(fromY) }, end: { x: ox + x * k, y: Y(pageH) }, thickness: 0.4, color: col(GRID_C) });
    } else if (tpl === TPL.dots) {
      const first = Math.ceil(fromY / 40) * 40;
      for (let u = first; u < pageH; u += 40) for (let x = 40; x < PAGE_W; x += 40)
        page.drawCircle({ x: ox + x * k, y: Y(u), size: 0.55, color: col(DOT_C) });
    }
  };

  const pathOf = (s, i0, i1, g) => {
    let d = '';
    for (let i = i0; i <= i1; i++) d += `${i === i0 ? 'M' : ' L'} ${(s.x[i] * g.k).toFixed(2)} ${(s.y[i] * g.k).toFixed(2)}`;
    if (i0 === i1) d += ` L ${(s.x[i0] * g.k + 0.01).toFixed(2)} ${(s.y[i0] * g.k).toFixed(2)}`;
    return d;
  };

  const drawInk = async (page, pg, g) => {
    if (!pg) return;
    // text boxes first (under the ink), then highlighter (multiply), then pens
    for (const o of pg.objs) {
      const png = opts.textImage ? await opts.textImage(o) : null;
      if (!png) continue;
      const img = await doc.embedPng(png);
      page.drawImage(img, { x: g.ox + o.x * g.k, y: g.top - (o.y + o.h) * g.k, width: o.w * g.k, height: o.h * g.k });
    }
    for (const s of pg.strokes) {
      if (s.kind !== SK_HIGHLIGHT || !s.x.length) continue;
      page.drawSvgPath(pathOf(s, 0, s.x.length - 1, g), { x: g.ox, y: g.top, borderColor: col(rgbOf565(s.color)),
        borderWidth: Math.max(1, s.w[0] / 4 * g.k), borderLineCap: LineCapStyle.Round, blendMode: BlendMode.Multiply });
    }
    for (const s of pg.strokes) {
      if (s.kind === SK_HIGHLIGHT || !s.x.length) continue;
      const color = col(rgbOf565(s.color));
      const n = s.x.length;
      if (n === 1) { page.drawCircle({ x: g.ox + s.x[0] * g.k, y: g.top - s.y[0] * g.k, size: Math.max(0.3, s.w[0] / 8 * g.k), color }); continue; }
      let i = 0;
      while (i < n - 1) {   // runs of (nearly) the same width -> one path each
        const w0 = s.w[i];
        let j = i + 1;
        while (j < n - 1 && Math.abs(s.w[j] - w0) <= Math.max(1, w0 * 0.08)) j++;
        page.drawSvgPath(pathOf(s, i, j, g), { x: g.ox, y: g.top, borderColor: color,
          borderWidth: Math.max(0.3, (s.w[i] + s.w[j]) / 8 * g.k), borderLineCap: LineCapStyle.Round });
        i = j;
      }
    }
  };

  const list = pagesOf(a);
  let lastW = LETTER_W;
  for (const p of list) {
    const pg = opts.pages.get(p.id) || null;
    const tpl = tplFor(a, p);
    if (a.kind === 'pdf' && !p.local) {
      const sp = p.src;
      const idx = (a.srcPages || []).indexOf(sp);
      let page = null, g;
      if (src && !sp.rot && idx >= 0 && idx < src.getPageCount()) {
        try {
          [page] = await doc.copyPages(src, [idx]);
          doc.addPage(page);
          const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
          g = { ox: box.x, top: box.y + box.height, k: box.width / PAGE_W };
        } catch (e) { page = null; }
      }
      if (!page) {   // rotated or unreadable original: use the picture of the page
        const w = sp.w, h = sp.h;
        page = doc.addPage([w, h]);
        const jpg = await opts.pageImage(p);
        if (jpg) page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: w, height: h });
        g = { ox: 0, top: h, k: w / PAGE_W };
      }
      lastW = g.k * PAGE_W;
      await drawInk(page, pg, g);
      continue;
    }
    // homework page, or a page added on the tablet
    const wPt = a.kind === 'pdf' ? lastW : LETTER_W;
    const k = wPt / PAGE_W, hPt = p.h * k;
    const page = doc.addPage([wPt, hPt]);
    const g = { ox: 0, top: hPt, k };
    let fromY = 0;
    if (!p.local && opts.background) {
      const bg = await opts.background(p);
      if (bg) {
        const img = await doc.embedJpg(bg.jpg);
        page.drawImage(img, { x: 0, y: hPt - bg.bh * k, width: wPt, height: bg.bh * k });
        fromY = bg.bh + 24;
      }
    }
    drawTemplate(page, tpl, g, fromY, p.h);
    await drawInk(page, pg, g);
  }
  if (!list.length) doc.addPage([LETTER_W, 792]);
  return doc.save();
}
