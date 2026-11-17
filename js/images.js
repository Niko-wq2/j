// Turning photos and PDFs into page images, and cropping regions out of them.
let pdfjs = null;
async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export const MAX_PAGE_SIDE = 1800;

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Could not encode image'))), type, quality));
}

async function loadBitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (e) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  }
}

async function scaleToJpeg(source, w, h) {
  const s = Math.min(1, MAX_PAGE_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', 0.85);
}

export const isPdfFile = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

// File (photo or PDF) -> {pages: [{blob, w, h, rot}], pdf: Uint8Array|null}
// w/h are the page size in PDF points (photos: pixels), as shown (rotation applied).
export async function fileToPagesInfo(file, onProgress, maxPages = 40) {
  if (isPdfFile(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: bytes.slice() }).promise;
    const out = [];
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      if (onProgress) onProgress(`Reading PDF page ${i} of ${n}`);
      const page = await doc.getPage(i);
      const vp0 = page.getViewport({ scale: 1 });
      const scale = MAX_PAGE_SIDE / Math.max(vp0.width, vp0.height);
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push({ blob: await canvasToBlob(c, 'image/jpeg', 0.85), w: vp0.width, h: vp0.height, rot: page.rotate || 0 });
      page.cleanup();
    }
    const more = doc.numPages - n;
    doc.destroy();
    return { pages: out, pdf: bytes, skipped: more };
  }
  const bmp = await loadBitmap(file);
  return { pages: [{ blob: await scaleToJpeg(bmp, bmp.width, bmp.height), w: bmp.width, h: bmp.height, rot: 0 }], pdf: null, skipped: 0 };
}

export async function fileToPages(file, onProgress) {
  return (await fileToPagesInfo(file, onProgress, 20)).pages.map(p => p.blob);
}

// Any image/canvas scaled to `width` px wide (keeps aspect). Returns a canvas.
export function scaledCanvas(src, width, maxH = 4000) {
  const s = width / src.width;
  const c = document.createElement('canvas');
  c.width = Math.round(width); c.height = Math.min(maxH, Math.round(src.height * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, Math.round(src.height * s));
  return c;
}

const bitmapCache = new Map();
export async function pageBitmap(key, blob) {
  if (bitmapCache.has(key)) return bitmapCache.get(key);
  const b = await loadBitmap(blob);
  bitmapCache.set(key, b);
  if (bitmapCache.size > 12) bitmapCache.delete(bitmapCache.keys().next().value);
  return b;
}

// box = [ymin, xmin, ymax, xmax] in 0..1000. Returns a canvas or null.
export function cropBox(bitmap, box, pad = 0.015) {
  if (!bitmap || !Array.isArray(box) || box.length !== 4) return null;
  let [y0, x0, y1, x1] = box.map(v => Math.min(1000, Math.max(0, Number(v) || 0)) / 1000);
  if (y1 <= y0 || x1 <= x0) return null;
  y0 = Math.max(0, y0 - pad); x0 = Math.max(0, x0 - pad); y1 = Math.min(1, y1 + pad); x1 = Math.min(1, x1 + pad);
  const W = bitmap.width, H = bitmap.height;
  const sx = Math.round(x0 * W), sy = Math.round(y0 * H), sw = Math.round((x1 - x0) * W), sh = Math.round((y1 - y0) * H);
  if (sw < 8 || sh < 8) return null;
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  c.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

export { canvasToBlob };

export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
