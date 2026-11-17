// How the phone's homework / PDF records map onto the tablet's pages.
// Pure functions (no DOM) so they can be tested in Node.
import { PAGE_W, LETTER_H, TPL } from './page.js';

export const RENDER_VERSION = 3;     // bump to force every page background to re-send

export function fnv(s) { let x = 2166136261; for (const c of String(s)) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; }

// Paper style for a homework page ('lines' | 'grid' | 'dots' | 'blank').
export function styleFor(a, q) {
  if (a.style && a.style !== 'auto') return a.style;
  if (q && q.paper) return q.paper;
  return /math|alg|geom|calc|phys|chem|stat|trig/i.test(a.subject || '') ? 'grid' : 'lines';
}

// Version of the picture at the top of a page: changes whenever anything on it changes.
export function bgVersion(a, page, showOriginal) {
  if (page.local) return 0;
  if (a.kind === 'pdf') return (fnv(JSON.stringify([RENDER_VERSION, 'pdf', a.id, page.id])) & 0x7fffffff) || 1;
  const q = page.qObj;
  return (fnv(JSON.stringify([RENDER_VERSION, q.label, q.text, q.box, q.figures, q.page, a.title, !!showOriginal])) & 0x7fffffff) || 1;
}

// Template the tablet shows on a page. A template the student picked on the
// tablet (reported back in the status) wins over the phone's default.
export function defaultTpl(a, page) {
  if (page.local) return page.t !== undefined ? page.t : TPL.lines;
  if (a.kind === 'pdf') return TPL.blank;
  return TPL[styleFor(a, page.qObj)] ?? TPL.lines;
}

export function tplFor(a, page) {
  const def = defaultTpl(a, page);
  const seen = a.tplSeen && a.tplSeen[page.id];
  if (seen && seen.g !== seen.s) return seen.g;
  return def;
}

/**
 * The ordered list of tablet pages for a record:
 * {id, q (question id or ''), n (label), h (units), local, qObj?, src? (pdf page record)}
 */
export function pagesOf(a) {
  const out = [];
  if (a.kind === 'pdf') {
    (a.srcPages || []).forEach((sp, i) => {
      const h = Math.max(200, Math.round(PAGE_W * sp.h / sp.w));
      out.push({ id: sp.id, q: '', n: String(i + 1), h, local: false, src: sp });
    });
  } else {
    for (const q of a.questions || []) {
      const bg = a.bg && a.bg[q.id];
      const h = Math.max(LETTER_H, bg ? Math.ceil(bg.bh + 1000) : LETTER_H);
      out.push({ id: q.id, q: q.id, n: q.label, h, local: false, qObj: q });
    }
  }
  for (const x of a.extra || []) {
    const page = { id: x.id, q: x.q || '', n: x.n || '', h: x.h || LETTER_H, local: true, t: x.t };
    if (a.kind !== 'pdf') page.qObj = (a.questions || []).find(q => q.id === x.q);
    let at = x.after ? out.findIndex(p => p.id === x.after) : -1;
    if (x.after && at < 0) at = out.length - 1;   // anchor gone: keep it at the end
    out.splice(at + 1, 0, page);
  }
  return out;
}

// One record's entry in the manifest the tablet keeps.
export function manifestEntry(a, showOriginal) {
  return {
    id: a.id, k: a.kind === 'pdf' ? 'pdf' : 'hw', subj: a.subject || '', title: a.title || 'Untitled',
    due: a.due ? Math.floor(a.due / 1000) : 0,
    p: pagesOf(a).map(pg => {
      const e = { id: pg.id, q: pg.q, n: pg.n, h: pg.h, t: tplFor(a, pg) };
      if (pg.local) e.L = 1;
      else {
        const bg = a.bg && a.bg[pg.id];
        if (bg && bg.v === bgVersion(a, pg, showOriginal)) { e.b = bg.v; e.bh = bg.bh; }
      }
      return e;
    }),
  };
}

/**
 * Apply a tablet status to a record. Returns {pulls: [pageId], changed}.
 * status pages: {d,p,v,bg,t,(L,after,h,q,n)}, del: {d,p}
 */
export function applyStatus(a, st, sentTpl) {
  let changed = false;
  const pulls = [];
  a.extra = a.extra || [];
  a.ver = a.ver || {};
  a.tplSeen = a.tplSeen || {};
  for (const del of (st.del || []).filter(x => x.d === a.id)) {
    const i = a.extra.findIndex(x => x.id === del.p);
    if (i >= 0) { a.extra.splice(i, 1); changed = true; }
    if (a.ver[del.p] !== undefined) { delete a.ver[del.p]; changed = true; }
    if (a.work && a.work[del.p]) { delete a.work[del.p]; changed = true; }
  }
  for (const it of (st.pages || []).filter(x => x.d === a.id)) {
    if (it.L) {
      let x = a.extra.find(e => e.id === it.p);
      if (!x) { x = { id: it.p }; a.extra.push(x); changed = true; }
      for (const [k, v] of [['after', it.after || ''], ['h', it.h || LETTER_H], ['q', it.q || ''], ['n', it.n || ''], ['t', it.t]]) {
        if (x[k] !== v) { x[k] = v; changed = true; }
      }
    }
    let sent;
    if (sentTpl && sentTpl.has(it.p)) sent = sentTpl.get(it.p);
    else if (a.tplSeen[it.p]) sent = a.tplSeen[it.p].s;
    else { const pg = it.L ? null : pagesOf(a).find(x => x.id === it.p); sent = pg ? defaultTpl(a, pg) : it.t; }
    const prev = a.tplSeen[it.p];
    if (!prev || prev.s !== sent || prev.g !== it.t) { a.tplSeen[it.p] = { s: sent, g: it.t }; changed = true; }
    if ((it.v || 0) > (a.ver[it.p] || 0)) pulls.push(it.p);
  }
  // keep the local pages in the tablet's order
  const order = new Map((st.pages || []).filter(x => x.d === a.id).map((x, i) => [x.p, i]));
  a.extra.sort((x, y) => (order.get(x.id) ?? 1e9) - (order.get(y.id) ?? 1e9));
  return { pulls, changed };
}

// Questions with something written on their page(s).
export function answeredCount(a) {
  if (a.kind === 'pdf') return 0;
  const work = a.work || {};
  return (a.questions || []).filter(q => work[q.id] || (a.extra || []).some(x => x.q === q.id && work[x.id])).length;
}
export const pagesWithWork = a => Object.values(a.work || {}).filter(Boolean).length;
