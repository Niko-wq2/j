// Renders questions and hints into images: text (any language) + LaTeX math
// (via MathJax SVG) + cropped figures. Used for the tablet (480 px wide JPEGs)
// and for the PDF export (high resolution).
import { cropBox, canvasToBlob } from './images.js';

const FONT = '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
const mathCache = new Map();

async function mathReady() {
  if (!window.MathJax) return false;
  try { await window.MathJax.startup.promise; return typeof window.MathJax.tex2svgPromise === 'function'; }
  catch (e) { return false; }
}

async function mathImage(tex, display, fontSize, scale) {
  const key = `${display ? 'D' : 'I'}|${fontSize}|${scale}|${tex}`;
  if (mathCache.has(key)) return mathCache.get(key);
  let result = null;
  if (await mathReady()) {
    try {
      const node = await window.MathJax.tex2svgPromise(tex, { display, em: fontSize, ex: fontSize / 2, containerWidth: 2000 });
      const svg = node.querySelector('svg');
      const exPx = fontSize / 2;
      const w = parseFloat(svg.getAttribute('width')) * exPx;
      const h = parseFloat(svg.getAttribute('height')) * exPx;
      const va = parseFloat((svg.style.verticalAlign || '0').replace('ex', '')) * exPx;  // <= 0
      svg.setAttribute('width', String(w * scale));
      svg.setAttribute('height', String(h * scale));
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('style', 'color:#111111');
      svg.removeAttribute('role'); svg.removeAttribute('focusable');
      const xml = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      await img.decode();
      result = { img, w, h, depth: -va };
    } catch (e) { result = null; }
  }
  mathCache.set(key, result);
  return result;
}

// Split text into paragraphs of tokens: {t:'text', s} | {t:'math', tex, display}
function tokenize(text) {
  const clean = String(text || '').replace(/\*\*/g, '').replace(/\r/g, '');
  const re = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
  const out = [];
  let last = 0, m;
  const pushText = s => { if (s) out.push({ t: 'text', s }); };
  while ((m = re.exec(clean))) {
    pushText(clean.slice(last, m.index));
    const raw = m[0];
    if (raw.startsWith('$$')) out.push({ t: 'math', tex: raw.slice(2, -2).trim(), display: true });
    else if (raw.startsWith('\\[')) out.push({ t: 'math', tex: raw.slice(2, -2).trim(), display: true });
    else if (raw.startsWith('\\(')) out.push({ t: 'math', tex: raw.slice(2, -2).trim(), display: false });
    else out.push({ t: 'math', tex: raw.slice(1, -1).trim(), display: false });
    last = m.index + raw.length;
  }
  pushText(clean.slice(last));
  return out;
}

// Lay out rich text in `maxW` css px. Returns {height, draw(ctx, x, y)}.
export async function layoutRich(ctx, text, { maxW, fontSize, color = '#111', bold = false, scale = 1, lineGap = 0.4 }) {
  const font = `${bold ? '600 ' : ''}${fontSize}px ${FONT}`;
  ctx.font = font;
  const asc = fontSize * 0.82, desc = fontSize * 0.26;
  const lines = [];
  let line = { items: [], w: 0, asc, desc, center: false };
  const newLine = (center = false) => { lines.push(line); line = { items: [], w: 0, asc, desc, center }; };
  const place = (item, w) => {
    if (line.w + w > maxW && line.items.length) {
      newLine();
      if (item.k === 'text' && /^\s+$/.test(item.s)) return;   // no leading spaces after wrap
    }
    item.x = line.w; line.items.push(item); line.w += w;
  };

  for (const tok of tokenize(text)) {
    if (tok.t === 'math') {
      const m = await mathImage(tok.tex, tok.display, fontSize, scale);
      if (!m) { // MathJax unavailable: show the TeX source
        for (const part of tok.tex.split(/(\s+)/)) if (part) place({ k: 'text', s: part }, ctx.measureText(part).width);
        continue;
      }
      let { w, h, depth } = m;
      let sc = 1;
      if (w > maxW) { sc = maxW / w; w *= sc; h *= sc; depth *= sc; }
      const item = { k: 'math', m, w, h, depth };
      if (tok.display) {
        if (line.items.length) newLine();
        line.center = true;
        item.x = 0; line.items.push(item); line.w = w;
        line.asc = Math.max(asc, h - depth) + fontSize * 0.2; line.desc = Math.max(desc, depth) + fontSize * 0.2;
        newLine();
      } else {
        place(item, w);
        line.asc = Math.max(line.asc, h - depth); line.desc = Math.max(line.desc, depth);
      }
      continue;
    }
    const paras = tok.s.split('\n');
    paras.forEach((para, pi) => {
      if (pi > 0) newLine();
      for (const part of para.split(/(\s+)/)) {
        if (!part) continue;
        let w = ctx.measureText(part).width;
        if (w > maxW) {  // very long word: break it by characters
          let chunk = '';
          for (const ch of part) {
            if (ctx.measureText(chunk + ch).width > maxW) { place({ k: 'text', s: chunk }, ctx.measureText(chunk).width); chunk = ''; }
            chunk += ch;
          }
          if (chunk) place({ k: 'text', s: chunk }, ctx.measureText(chunk).width);
          continue;
        }
        place({ k: 'text', s: part }, w);
      }
    });
  }
  if (line.items.length || !lines.length) lines.push(line);

  let height = 0, width = 0;
  for (const l of lines) { height += l.asc + l.desc + fontSize * lineGap; width = Math.max(width, l.w); }
  return {
    height, width,
    draw(c, x, y) {
      c.save(); c.font = font; c.fillStyle = color; c.textBaseline = 'alphabetic';
      let yy = y;
      for (const l of lines) {
        const base = yy + l.asc;
        const off = l.center ? (maxW - l.w) / 2 : 0;
        for (const it of l.items) {
          if (it.k === 'text') c.fillText(it.s, x + off + it.x, base);
          else c.drawImage(it.m.img, x + off + it.x, base - (it.h - it.depth), it.w, it.h);
        }
        yy += l.asc + l.desc + fontSize * lineGap;
      }
      c.restore();
    },
  };
}

function fitImage(src, maxW, maxH) {
  const s = Math.min(maxW / src.width, maxH / src.height, 1.6);
  return { w: src.width * s, h: src.height * s };
}

/**
 * Render a question card.
 * q: {label, text, page, box, figures:[{page, box}]}
 * opts: {width, scale, fontSize, showOriginal, subtitle, getPage(pageNumber1Based) -> bitmap|null, maxFigH}
 */
export async function renderQuestion(q, opts) {
  const width = opts.width || 480, scale = opts.scale || 1, fs = opts.fontSize || 19;
  const pad = Math.round(fs * 0.75), inner = width - 2 * pad;
  const meas = document.createElement('canvas').getContext('2d');

  const blocks = [];   // {h, draw(ctx, y)}
  // heading
  const head = await layoutRich(meas, `Question ${q.label || ''}`, { maxW: inner * 0.5, fontSize: fs * 0.85, bold: true, color: '#1f2937', scale });
  const sub = opts.subtitle ? await layoutRich(meas, opts.subtitle, { maxW: inner * 0.5, fontSize: fs * 0.7, color: '#6b7280', scale }) : null;
  blocks.push({
    h: Math.max(head.height, sub ? sub.height : 0) + fs * 0.3,
    draw(c, y) {
      head.draw(c, pad, y);
      if (sub) { c.save(); c.font = `${fs * 0.7}px ${FONT}`; const t = opts.subtitle; c.fillStyle = '#6b7280';
        c.textAlign = 'right'; c.textBaseline = 'top'; c.fillText(t.length > 48 ? t.slice(0, 47) + '…' : t, width - pad, y + 2); c.restore(); }
      c.save(); c.strokeStyle = '#e5e7eb'; c.lineWidth = 1; c.beginPath();
      c.moveTo(pad, y + this.h - fs * 0.15); c.lineTo(width - pad, y + this.h - fs * 0.15); c.stroke(); c.restore();
    },
  });

  const body = await layoutRich(meas, q.text || '(no text)', { maxW: inner, fontSize: fs, scale });
  blocks.push({ h: body.height + fs * 0.4, draw(c, y) { body.draw(c, pad, y + fs * 0.3); } });

  const addImage = async (canvas, label, maxH) => {
    if (!canvas) return;
    const lab = label ? await layoutRich(meas, label, { maxW: inner, fontSize: fs * 0.65, color: '#6b7280', scale }) : null;
    const { w, h } = fitImage(canvas, inner, maxH);
    blocks.push({
      h: (lab ? lab.height : 0) + h + fs * 0.6,
      draw(c, y) {
        let yy = y + fs * 0.2;
        if (lab) { lab.draw(c, pad, yy); yy += lab.height; }
        const x = pad + (inner - w) / 2;
        c.drawImage(canvas, x, yy, w, h);
        c.save(); c.strokeStyle = '#d1d5db'; c.lineWidth = 1; c.strokeRect(x - 0.5, yy - 0.5, w + 1, h + 1); c.restore();
      },
    });
  };

  if (opts.getPage) {
    for (const f of q.figures || []) {
      const bmp = await opts.getPage(f.page || q.page);
      await addImage(cropBox(bmp, f.box, 0.01), null, opts.maxFigH || 300);
    }
    if (opts.showOriginal && q.box) {
      const bmp = await opts.getPage(q.page);
      await addImage(cropBox(bmp, q.box, 0.02), 'Original (from your upload):', opts.maxOrigH || 420);
    }
  }

  const total = Math.ceil(blocks.reduce((s, b) => s + b.h, 0) + pad);
  const c = document.createElement('canvas');
  c.width = Math.round(width * scale); c.height = Math.min(Math.round(total * scale), 16000);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, total);
  let y = pad * 0.6;
  for (const b of blocks) { b.draw(ctx, y); y += b.h; }
  return c;
}

export async function renderHint(text, level, opts = {}) {
  const width = opts.width || 480, scale = opts.scale || 1, fs = opts.fontSize || 19;
  const pad = Math.round(fs * 0.8), inner = width - 2 * pad;
  const meas = document.createElement('canvas').getContext('2d');
  const head = await layoutRich(meas, `Hint ${level} of 3`, { maxW: inner, fontSize: fs * 0.85, bold: true, color: '#92400e', scale });
  const body = await layoutRich(meas, text, { maxW: inner, fontSize: fs, scale });
  const total = Math.ceil(pad + head.height + fs * 0.5 + body.height + pad);
  const c = document.createElement('canvas');
  c.width = Math.round(width * scale); c.height = Math.round(total * scale);
  const ctx = c.getContext('2d'); ctx.scale(scale, scale);
  ctx.fillStyle = '#FFFBEB'; ctx.fillRect(0, 0, width, total);
  head.draw(ctx, pad, pad * 0.8);
  body.draw(ctx, pad, pad * 0.8 + head.height + fs * 0.5);
  return c;
}

// Title block for the first page of the PDF.
export async function renderPdfHeader(a, { width = 640, scale = 2.5 } = {}) {
  const meas = document.createElement('canvas').getContext('2d');
  const title = await layoutRich(meas, a.title || 'Homework', { maxW: width - 200, fontSize: 24, bold: true, scale });
  const dueStr = a.due ? new Date(a.due).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const line2 = [a.subject, dueStr && `Due ${dueStr}`].filter(Boolean).join('   ·   ');
  const sub = await layoutRich(meas, line2 || ' ', { maxW: width - 200, fontSize: 13, color: '#4b5563', scale });
  const h = Math.ceil(title.height + sub.height + 26);
  const c = document.createElement('canvas');
  c.width = Math.round(width * scale); c.height = Math.round(h * scale);
  const ctx = c.getContext('2d'); ctx.scale(scale, scale);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, h);
  title.draw(ctx, 0, 4);
  sub.draw(ctx, 0, 8 + title.height);
  ctx.font = `13px ${FONT}`; ctx.fillStyle = '#111'; ctx.textBaseline = 'top'; ctx.textAlign = 'right';
  ctx.fillText('Name: ______________________', width, 10);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(0, h - 4); ctx.lineTo(width, h - 4); ctx.stroke();
  return c;
}

/**
 * A typed text box for the tablet: text (with $math$) on white, so the tablet's
 * multiply blend makes the background disappear. Sizes are in page units;
 * `k` = pixels per unit. Returns {canvas, wUnits, hUnits}.
 */
export async function renderTextBox(text, { sizeUnits = 48, color = '#111111', maxWUnits = 1400, k = 0.75, transparent = false }) {
  const meas = document.createElement('canvas').getContext('2d');
  const fs = sizeUnits * k;
  const lay = await layoutRich(meas, text, { maxW: maxWUnits * k, fontSize: fs, color, scale: 1, lineGap: 0.25 });
  const pad = Math.round(fs * 0.15);
  const w = Math.max(8, Math.ceil(lay.width + 2 * pad)), hgt = Math.max(8, Math.ceil(lay.height + pad));
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const ctx = c.getContext('2d');
  if (!transparent) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, hgt); }
  lay.draw(ctx, pad, pad * 0.5);
  return { canvas: c, wUnits: Math.round(w / k), hUnits: Math.round(hgt / k) };
}

export function toJpeg(canvas, q = 0.82) { return canvasToBlob(canvas, 'image/jpeg', q); }
export function toPng(canvas) { return canvasToBlob(canvas, 'image/png'); }
