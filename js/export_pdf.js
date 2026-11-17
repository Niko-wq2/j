// Builds the finished PDF.
// - Homework: one Letter-width page per tablet page: the question at the top,
//   the paper (lines/grid/dots) below it, and the handwriting as vector lines.
// - Annotated PDF: the original PDF pages (still vector, still selectable text)
//   with the handwriting, highlighter and text boxes drawn on top; pages added on
//   the tablet become blank pages in the right place.
import { PAGE_W, TPL, SK_HIGHLIGHT, rgbOf565, curvePieces } from './page.js';
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
  const { PDFDocument, rgb, LineCapStyle, BlendMode, degrees } = L;
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

  // g: {X(u,v), Y(u,v)} page units (as shown on the tablet) -> PDF points; ws: points per unit;
  // rot: quarter turns the page is shown with (text boxes are drawn turned back so they read upright).
  // Paths use y-down coordinates with origin (0,0), so a PDF point (X, Y) is written as (X, -Y).
  const f2 = v => v.toFixed(2);
  const pathOf = (s, i0, i1, g) => {
    let d = `M ${f2(g.X(s.x[i0], s.y[i0]))} ${f2(-g.Y(s.x[i0], s.y[i0]))}`;
    if (i0 === i1) return d + ` L ${f2(g.X(s.x[i0], s.y[i0]) + 0.01)} ${f2(-g.Y(s.x[i0], s.y[i0]))}`;
    curvePieces(s, i0, i1, g.X, (u, v) => -g.Y(u, v), (c1x, c1y, c2x, c2y, x, y) => { d += ` C ${f2(c1x)} ${f2(c1y)} ${f2(c2x)} ${f2(c2y)} ${f2(x)} ${f2(y)}`; });
    return d;
  };

  const drawInk = async (page, pg, g) => {
    if (!pg) return;
    // text boxes first (under the ink), then highlighter (multiply), then pens
    for (const o of pg.objs) {
      const png = opts.textImage ? await opts.textImage(o) : null;
      if (!png) continue;
      const img = await doc.embedPng(png);
      // the box's bottom-left corner as shown, turned back into the PDF page
      page.drawImage(img, { x: g.X(o.x, o.y + o.h), y: g.Y(o.x, o.y + o.h), width: o.w * g.ws, height: o.h * g.ws, rotate: degrees(90 * (g.rot || 0)) });
    }
    for (const s of pg.strokes) {
      if (s.kind !== SK_HIGHLIGHT || !s.x.length) continue;
      page.drawSvgPath(pathOf(s, 0, s.x.length - 1, g), { x: 0, y: 0, borderColor: col(rgbOf565(s.color)),
        borderWidth: Math.max(1, s.w[0] / 4 * g.ws), borderLineCap: LineCapStyle.Round, blendMode: BlendMode.Multiply });
    }
    for (const s of pg.strokes) {
      if (s.kind === SK_HIGHLIGHT || !s.x.length) continue;
      const color = col(rgbOf565(s.color));
      const n = s.x.length;
      if (n === 1) { page.drawCircle({ x: g.X(s.x[0], s.y[0]), y: g.Y(s.x[0], s.y[0]), size: Math.max(0.3, s.w[0] / 8 * g.ws), color }); continue; }
      let i = 0;
      while (i < n - 1) {   // runs of (nearly) the same width -> one path each
        const w0 = s.w[i];
        let j = i + 1;
        while (j < n - 1 && Math.abs(s.w[j] - w0) <= Math.max(1, w0 * 0.08)) j++;
        page.drawSvgPath(pathOf(s, i, j, g), { x: 0, y: 0, borderColor: color,
          borderWidth: Math.max(0.3, (s.w[i] + s.w[j]) / 8 * g.ws), borderLineCap: LineCapStyle.Round });
        i = j;
      }
    }
  };

  // Mapping for a page shown upright: origin (ox, top) in points, k points per unit.
  const upright = (ox, top, k) => ({ X: (u) => ox + u * k, Y: (u, v) => top - v * k, ws: k, rot: 0 });
  // Mapping for a PDF page turned `rot` quarter turns clockwise on the tablet.
  // box: the page's crop box in points (unturned); h0: its height in units when upright.
  const turnedMap = (box, h0, rot) => {
    const k = box.width / PAGE_W, f = (rot & 1) ? h0 / PAGE_W : 1;
    const un = (u, v) => {   // shown units -> upright units
      switch (rot & 3) {
        case 0: return [u, v];
        case 1: return [v * f, h0 - u * f];
        case 2: return [PAGE_W - u, h0 - v];
        default: return [PAGE_W - v * f, u * f];
      }
    };
    return { X: (u, v) => box.x + un(u, v)[0] * k, Y: (u, v) => box.y + box.height - un(u, v)[1] * k, ws: k * f, rot: rot & 3 };
  };

  const list = pagesOf(a);
  let lastW = LETTER_W;
  for (const p of list) {
    const pg = opts.pages.get(p.id) || null;
    const tpl = tplFor(a, p);
    if (a.kind === 'pdf' && !p.local) {
      const sp = p.src;
      const idx = (a.srcPages || []).indexOf(sp);
      const rot = (p.rot || 0) & 3;
      let page = null, g;
      if (src && !sp.rot && idx >= 0 && idx < src.getPageCount()) {
        try {
          [page] = await doc.copyPages(src, [idx]);
          doc.addPage(page);
          const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
          g = turnedMap(box, PAGE_W * box.height / box.width, rot);
        } catch (e) { page = null; }
      }
      if (!page) {   // picture pages, rotated or unreadable originals: use the picture of the page
        const w = sp.w, h = sp.h;
        page = doc.addPage([w, h]);
        const jpg = await opts.pageImage(p);
        if (jpg) page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: w, height: h });
        g = turnedMap({ x: 0, y: 0, width: w, height: h }, PAGE_W * h / w, rot);
      }
      if (rot) page.setRotation(degrees(90 * rot));
      lastW = (rot & 1) ? sp.h : sp.w;
      await drawInk(page, pg, g);
      continue;
    }
    // homework page, or a page added on the tablet
    const wPt = a.kind === 'pdf' ? lastW : LETTER_W;
    const k = wPt / PAGE_W, hPt = p.h * k;
    const page = doc.addPage([wPt, hPt]);
    const g = upright(0, hPt, k);
    let fromY = 0;
    if (!p.local && opts.background) {
      const bg = await opts.background(p);
      if (bg) {
        const img = await doc.embedJpg(bg.jpg);
        page.drawImage(img, { x: 0, y: hPt - bg.bh * k, width: wPt, height: bg.bh * k });
        fromY = bg.bh + 24;
      }
    }
    drawTemplate(page, tpl, { ox: 0, top: hPt, k }, fromY, p.h);
    await drawInk(page, pg, g);
  }
  if (!list.length) doc.addPage([LETTER_W, 792]);
  return doc.save();
}
