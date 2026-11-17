// Homework Tablet — phone app (runs in Bluefy on iPhone, Chrome on Android/desktop).
import { db, newId } from './db.js?v=220';
import { TabletLink, MSG, PROTO } from './ble.js?v=220';
import { fileToPagesInfo, isPdfFile, pageBitmap, cropBox, canvasToBlob, scaledCanvas } from './images.js?v=220';
import { renderQuestion, renderHint, renderTextBox, toJpeg } from './cards.js?v=220';
import { parseHomework, getHint, listModels, DEFAULT_MODEL, onModelFallback } from './gemini.js?v=220';
import { decodePage, drawPage, pageHasWork, PAGE_W, PEN_COLORS, TEXT_SIZES, c565, rgbOf565, TPL, rotated } from './page.js?v=220';
import { pagesOf, manifestEntry, applyStatus, bgVersion, tplFor, styleFor, answeredCount, pagesWithWork, fnv, notesFromStatus } from './model.js?v=220';
import { fetchCanvas } from './canvas_ics.js?v=220';
import { decodeAdpcm, wavBytes, fmtDuration, ADPCM_BLOCK, ADPCM_SAMPLES } from './audio.js?v=220';
import { buildPdf } from './export_pdf.js?v=220';

const APP_VERSION = '2.2.0';
// AI (Gemini question reading + hints) is turned off for now. To bring it back,
// set this to true (or run localStorage.setItem('hw.enableAI', '1') in the browser).
const AI_ENABLED = localStorage.getItem('hw.enableAI') === '1';
const BG_CSS_W = 800, BG_PX_W = 1600, BG_FONT = 28;   // question pictures for the tablet (2 px per CSS px)
const PDF_BG_SHORT = 1600;                           // PDF pages: shorter side in pixels (1 px per page unit)
const $ = s => document.querySelector(s);

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  apiKey: '', model: DEFAULT_MODEL, pin: '', canvasFeed: '', canvasRelay: '',
  showOriginal: true, hintSeesWork: true, hintLanguage: 'English', canvasOnTablet: true, autoSync: true,
  textSize: 1, textColor: 0,
};
const settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('hw.settings') || '{}'));
const saveSettings = () => localStorage.setItem('hw.settings', JSON.stringify(settings));

// ------------------------------------------------------------------ state
let assignments = [];
let canvasEvents = [];
let canvasDismissed = new Set();
let route = { name: 'list' };
const link = new TabletLink();
let syncing = false, syncAgain = false;
const busy = new Set();            // record ids being read by AI
const readStatus = new Map();      // record id -> progress text while reading
onModelFallback(m => toast(`Used ${m} because the usual model was busy`, 4000));

// ------------------------------------------------------------------ dom helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let sheetOnClose = null;
function sheet(build, onDismiss) {
  const s = $('#sheet'), card = s.querySelector('.sheet-card');
  if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; f(); }
  card.innerHTML = '';
  const close = () => { s.hidden = true; sheetOnClose = null; };
  card.append(...[].concat(build(close)).flat(Infinity).filter(x => x !== null && x !== undefined && x !== false));
  s.hidden = false;
  sheetOnClose = onDismiss || null;
  s.onclick = e => { if (e.target === s) { const f = sheetOnClose; close(); if (f) f(); } };
  return close;
}

function ask(title, { placeholder = '', value = '', type = 'text', okText = 'OK' } = {}) {
  return new Promise(resolve => {
    let input;
    sheet(close => [
      h('h2', {}, title),
      input = h('input', { type, placeholder, value, inputmode: type === 'tel' ? 'numeric' : undefined }),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => { close(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { close(); resolve(input.value.trim()); } }, okText)),
    ], () => resolve(null));
    setTimeout(() => input.focus(), 50);
  });
}

function confirmBox(title, text, okText = 'OK', danger = false) {
  return new Promise(resolve => {
    sheet(close => [
      h('h2', {}, title), h('p', { class: 'muted' }, text),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => { close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { close(); resolve(true); } }, okText)),
    ], () => resolve(false));
  });
}

// ------------------------------------------------------------------ dates
function dueInfo(due) {
  if (!due) return { text: 'No due date', cls: '', group: 'No due date', order: 9 };
  const d = new Date(due), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  const time = (d.getHours() || d.getMinutes()) ? ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  if (diff < 0 || (diff === 0 && d < now)) return { text: `Overdue · was due ${date}${time}`, cls: 'over', group: 'Overdue', order: 0 };
  if (diff === 0) return { text: `Due today${time}`, cls: 'soon', group: 'Today', order: 1 };
  if (diff === 1) return { text: `Due tomorrow${time}`, cls: 'soon', group: 'Tomorrow', order: 2 };
  if (diff < 7) return { text: `Due ${date}${time}`, cls: '', group: 'This week', order: 3 };
  return { text: `Due ${date}${time}`, cls: '', group: 'Later', order: 4 };
}
const toLocalInput = ms => { if (!ms) return ''; const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

const SUBJ_COLORS = ['#2563EB', '#DC2626', '#16A34A', '#9333EA', '#EA580C', '#0891B2', '#DB2777', '#65A30D'];
function subjColor(s) { let x = 2166136261; for (const c of String(s || '').toLowerCase()) { x ^= c.charCodeAt(0) & 255; x = Math.imul(x, 16777619) >>> 0; } return SUBJ_COLORS[x % 8]; }

// ------------------------------------------------------------------ data
async function load() {
  assignments = (await db.allAssignments()) || [];
  for (const a of assignments) if (!a.kind) a.kind = 'hw';
  canvasEvents = (await db.get('canvasEvents', [])) || [];
  canvasDismissed = new Set((await db.get('canvasDismissed', [])) || []);
}
async function save(a, sync = true) {
  a.updated = Date.now();
  await db.putAssignment(a);
  const i = assignments.findIndex(x => x.id === a.id);
  if (i >= 0) assignments[i] = a; else assignments.push(a);
  if (sync) scheduleSync();
}
const findA = id => assignments.find(a => a.id === id);

async function getPageBitmap(a, n) {          // uploaded scan / photo, 1-based
  const pid = a.pages && a.pages[n - 1];
  if (!pid) return null;
  const blob = await db.getBlob(`page:${a.id}:${pid}`);
  return blob ? pageBitmap(`${a.id}:${pid}`, blob) : null;
}
async function srcBitmap(a, sp) {             // original page of an annotated PDF
  const blob = await db.getBlob(`page:${a.id}:${sp.id}`);
  return blob ? pageBitmap(`${a.id}:${sp.id}`, blob) : null;
}
async function getWork(a, pid) {
  const buf = await db.getBlob(`pg:${a.id}:${pid}`);
  return buf ? decodePage(buf) : null;
}
const pageOf = (a, pid) => pagesOf(a).find(p => p.id === pid);

// ------------------------------------------------------------------ page pictures
// Question picture for a homework page, for the tablet (1000 px wide JPEG).
async function questionCard(a, q, { scale = BG_PX_W / BG_CSS_W } = {}) {
  return renderQuestion(q, {
    width: BG_CSS_W, scale, fontSize: BG_FONT, showOriginal: settings.showOriginal, subtitle: a.title,
    getPage: n => getPageBitmap(a, n), maxFigH: 520, maxOrigH: 640,
  });
}

// Make sure the tablet picture for a page is rendered and cached.
async function prepareBg(a, page) {
  const v = bgVersion(a, page, settings.showOriginal);
  a.bg = a.bg || {};
  const have = a.bg[page.id];
  if (have && have.v === v && await db.getBlob(`bg:${a.id}:${page.id}`)) return have;
  let canvas;
  if (a.kind === 'pdf') {
    const bmp = await srcBitmap(a, page.src);
    if (!bmp) return null;
    const w = bmp.width <= bmp.height ? PDF_BG_SHORT : Math.round(PDF_BG_SHORT * bmp.width / bmp.height);
    canvas = scaledCanvas(bmp, w, 4400);
  } else {
    canvas = await questionCard(a, page.qObj);
  }
  const jpg = await toJpeg(canvas, 0.8);
  await db.putBlob(`bg:${a.id}:${page.id}`, jpg);
  const rec = { v, bh: Math.round(canvas.height * PAGE_W / canvas.width) };
  a.bg[page.id] = rec;
  return rec;
}

// Text box pictures (the phone keeps the text; the picture is re-made when needed).
async function textBoxImage(o, k, transparent) {
  const color = PEN_COLORS.reduce((best, c) => {
    const [r, g, b] = rgbOf565(c565(c)), [R, G, B] = rgbOf565(o.color);
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
    return d < best.d ? { c, d } : best;
  }, { c: PEN_COLORS[0], d: 1e9 }).c;
  const size = TEXT_SIZES[Math.min(2, o.size || 0)] || 48;
  const r = await renderTextBox(o.text || ' ', { sizeUnits: size, color, maxWUnits: Math.max(240, o.w + 8), k, transparent });
  return r.canvas;
}

// A page as the tablet shows it (for previews, hints and image-only exports).
async function renderPageCanvas(a, page, widthPx, { cropToWork = false, minUnits = 500, withBg = true } = {}) {
  const k = widthPx / PAGE_W;
  const pg = await getWork(a, page.id);
  let bg = null;
  if (withBg && !page.local) {
    if (a.kind === 'pdf') bg = rotated(await srcBitmap(a, page.src), page.rot || 0);
    else {
      const blob = await db.getBlob(`bg:${a.id}:${page.id}`);
      bg = blob && a.bg && a.bg[page.id] && a.bg[page.id].v === bgVersion(a, page, settings.showOriginal)
        ? await pageBitmap(`bg:${a.id}:${page.id}:${a.bg[page.id].v}`, blob) : await questionCard(a, page.qObj);
    }
  }
  const objImgs = new Map();
  if (pg) for (const o of pg.objs) objImgs.set(o, await textBoxImage(o, Math.max(0.4, k * 1.5), false));
  let units = page.h;
  if (cropToWork) {
    const bgUnits = bg ? bg.height * PAGE_W / bg.width : 0;
    units = Math.min(page.h, Math.max(minUnits, bgUnits + 60, (pg ? pg.bottom : 0) + 90));
  }
  const c = document.createElement('canvas');
  c.width = Math.round(widthPx); c.height = Math.max(1, Math.round(units * k));
  drawPage(c.getContext('2d'), pg, { k, bg, tpl: tplFor(a, page), pageH: page.h, noTemplate: a.kind === 'pdf' && !page.local,
    objImage: o => objImgs.get(o) });
  return c;
}

// ------------------------------------------------------------------ tablet connection
function updateChip() {
  const chip = $('#tabletChip');
  chip.classList.remove('on', 'wait');
  if (!link.supported) { chip.textContent = 'No Bluetooth here'; return; }
  if (link.connected) {
    const bat = link.info && link.info.bat >= 0 ? ` · ${link.info.bat}%` : '';
    chip.textContent = link.info && link.info.paired === false ? 'Tablet · not paired' : `Tablet ✓${bat}`;
    chip.classList.add(link.info && link.info.paired === false ? 'wait' : 'on');
  } else if (link.device) { chip.textContent = 'Reconnect tablet'; }
  else chip.textContent = 'Connect tablet';
}

async function connectTablet() {
  if (!link.supported) {
    sheet(close => [h('h2', {}, 'Bluetooth not available'),
      h('p', {}, 'Safari and Chrome on iPhone can\'t use Bluetooth from a web page. Open this page in the free ',
        h('b', {}, 'Bluefy'), ' browser app instead (search "Bluefy" in the App Store).'),
      h('button', { class: 'btn primary block', onclick: close }, 'OK')]);
    return;
  }
  try {
    if (link.device && !link.connected) await link.connect();
    else await link.choose();
    await afterConnect();
  } catch (e) {
    if (e && e.name === 'NotFoundError') return;   // user cancelled the chooser
    toast('Could not connect: ' + (e.message || e));
  }
  updateChip();
}

async function ensurePaired() {
  let info = await link.hello(settings.pin, APP_VERSION);
  updateChip();
  if ((info.proto || 1) < PROTO) throw new Error(`The tablet has older firmware (${info.fw}) than this app (${APP_VERSION}). Flash the matching firmware file.`);
  for (let tries = 0; !info.paired && tries < 3; tries++) {
    const code = await ask('Enter the pairing code shown on the tablet', { type: 'tel', placeholder: '4 digits', okText: 'Pair' });
    if (!code) throw new Error('Pairing cancelled');
    settings.pin = code; saveSettings();
    info = await link.hello(settings.pin, APP_VERSION);
    updateChip();
  }
  if (!info.paired) throw new Error('Wrong pairing code');
  return info;
}

async function afterConnect() {
  try { await ensurePaired(); toast('Tablet connected'); if (settings.autoSync) await sync(); }
  catch (e) { toast(e.message || String(e), 5000); }
}

link.addEventListener('state', () => updateChip());
link.addEventListener('reconnected', () => afterConnect());
link.addEventListener('message', ev => {
  const m = ev.detail;
  if (m.type === MSG.T_HINT_REQ) handleHintRequest(m.json);
  else if (m.type === MSG.T_TEXT_REQ) handleTextRequest(m.json);
  else if (m.type === MSG.T_ERROR && m.json.msg === 'not paired') toast('The tablet wants the pairing code again.');
  else if (m.type === MSG.T_ERROR && m.json.msg === 'bg offset') bgOffsetErrors.add(`${m.json.d}/${m.json.p}`);
  else if (m.type === MSG.T_ERROR && m.json.msg === 'storage full') toast('The tablet\'s storage is full', 5000);
  else if (m.type === MSG.T_CHANGED && settings.autoSync) scheduleSync(800);   // something new on the tablet
});
const bgOffsetErrors = new Set();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (link.connected) scheduleSync(500); else link.retryNow();
});

// ------------------------------------------------------------------ sync
let syncTimer;
function scheduleSync(ms = 2500) {
  if (!settings.autoSync || !link.connected) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch(() => {}), ms);
}
const typing = () => { const e = document.activeElement; return !!(e && /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)); };
function fnvBytes(str) { let x = 2166136261; for (const b of new TextEncoder().encode(str)) { x ^= b; x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; }

function syncProgress(text, frac) {
  const bar = $('#syncbar');
  if (text === null) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#syncbarText').textContent = text;
  $('#syncbarFill').style.width = `${Math.round((frac || 0) * 100)}%`;
}

function canvasOnlyItems() {
  if (!settings.canvasOnTablet) return [];
  const linked = new Set(assignments.map(a => a.canvasUid).filter(Boolean));
  const now = Date.now(), until = now + 14 * 86400000;
  return canvasEvents.filter(e => e.isAssignment && e.due >= now - 86400000 && e.due <= until && !linked.has(e.uid) && !canvasDismissed.has(e.uid));
}

function buildManifest() {
  const list = assignments.filter(a => !a.done).map(a => manifestEntry(a, settings.showOriginal));
  for (const e of canvasOnlyItems()) {
    list.push({ id: 'c' + fnv(e.uid).toString(36), k: 'hw', subj: e.course, title: e.title, due: Math.floor(e.due / 1000), p: [] });
  }
  return { d: list };
}

const getStatus = () => link.request(MSG.GET_STATUS, {}, x => x.type === MSG.T_STATUS, { timeout: 20000 });

async function pullPage(a, pid) {
  const m = await link.request(MSG.GET_PAGE, { d: a.id, p: pid },
    x => x.type === MSG.T_PAGE && x.json.d === a.id && x.json.p === pid, { timeout: 30000 });
  const pg = m.blob.length ? decodePage(m.blob) : null;
  if (m.blob.length) await db.putBlob(`pg:${a.id}:${pid}`, m.blob.buffer.slice(m.blob.byteOffset, m.blob.byteOffset + m.blob.byteLength));
  else await db.deleteBlob(`pg:${a.id}:${pid}`);
  a.work = a.work || {}; a.ver = a.ver || {};
  a.work[pid] = pageHasWork(pg);
  a.ver[pid] = m.json.v || 0;
  return pg;
}

// Pull every page the tablet changed. Returns the number of pages pulled.
async function pullChanges(st, progress, sentTpl) {
  let n = 0;
  const todo = [];
  // notebooks started on the tablet
  const known = new Set(assignments.map(a => a.id).concat((await db.get('deletedIds', [])) || []));
  for (const rec of notesFromStatus(st, known)) { assignments.push(rec); await db.putAssignment(rec); }
  for (const a of assignments) {
    const r = applyStatus(a, st, sentTpl);
    if (st.rec) {   // recordings made on the tablet for this document
      const recs = st.rec.filter(x => x.d === a.id).map(x => ({ r: x.r, ms: x.ms, start: x.start }));
      if (JSON.stringify(recs) !== JSON.stringify(a.recs || [])) { a.recs = recs; r.changed = true; }
    }
    if (r.changed || r.pulls.length) todo.push([a, r]);
  }
  const total = todo.reduce((s, [, r]) => s + r.pulls.length, 0);
  for (const [a, r] of todo) {
    for (const pid of r.pulls) {
      if (progress) progress(`Getting your work (${n + 1}/${total})…`, n / Math.max(1, total));
      await pullPage(a, pid);
      n++;
    }
    await db.putAssignment(a);
  }
  return n;
}

async function sync() {
  if (!link.connected) { toast('Connect the tablet first'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; $('#syncBtn').classList.add('spin');
  let pulled = 0, sent = 0;
  try {
    await ensurePaired();
    // 1. Collect new work first (so nothing is lost if a record was removed).
    syncProgress('Checking the tablet…', 0.03);
    const st0 = (await getStatus()).json;
    pulled += await pullChanges(st0, (t, f) => syncProgress(t, 0.05 + 0.25 * f));

    // 2. Make the page pictures (needed for the list: the tablet lays pages out by them).
    const active = assignments.filter(a => !a.done);
    const pending = [];
    for (const a of active) for (const p of pagesOf(a)) {
      if (p.local) continue;
      const have = a.bg && a.bg[p.id];
      if (!have || have.v !== bgVersion(a, p, settings.showOriginal)) pending.push([a, p]);
    }
    for (let i = 0; i < pending.length; i++) {
      const [a, p] = pending[i];
      syncProgress(`Preparing pages (${i + 1}/${pending.length})…`, 0.3 + 0.15 * i / pending.length);
      try { await prepareBg(a, p); await db.putAssignment(a); } catch (e) { console.warn('page picture failed', e); }
    }

    // 3. Send the list.
    syncProgress('Sending the list…', 0.47);
    const manifest = buildManifest();
    const sentTpl = new Map();
    for (const d of manifest.d) for (const p of d.p) sentTpl.set(p.id, p.t);
    const same = st0.mh !== undefined && st0.mh === fnvBytes(JSON.stringify(manifest));
    if (!same) await link.send(MSG.MANIFEST, manifest);     // unchanged lists aren't sent again

    // 4. Send page pictures the tablet doesn't have yet (continuing any that were cut off).
    const st = same ? st0 : (await getStatus()).json;
    const partial = new Map((st.bgp || []).map(x => [`${x.d}/${x.p}`, x]));
    const sends = [];
    for (const it of st.pages || []) {
      const a = findA(it.d); if (!a || it.L) continue;
      const p = pageOf(a, it.p); if (!p) continue;
      const bg = a.bg && a.bg[p.id];
      if (bg && it.bg !== bg.v) sends.push([a, p, bg]);
    }
    for (let i = 0; i < sends.length; i++) {
      const [a, p, bg] = sends[i];
      syncProgress(`Sending pages (${i + 1}/${sends.length})…`, 0.5 + 0.45 * i / sends.length);
      const blob = await db.getBlob(`bg:${a.id}:${p.id}`);
      if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const key = `${a.id}/${p.id}`, part = partial.get(key);
      let off = part && part.v === bg.v && part.have < bytes.length ? part.have : 0;
      bgOffsetErrors.delete(key);
      const PIECE = 16384;
      while (off < bytes.length && !bgOffsetErrors.has(key)) {
        const n = Math.min(PIECE, bytes.length - off);
        await link.send(MSG.BG_PART, { d: a.id, p: p.id, v: bg.v, off, total: bytes.length }, bytes.subarray(off, off + n));
        off += n;
        syncProgress(`Sending pages (${i + 1}/${sends.length})…`, 0.5 + 0.45 * (i + off / bytes.length) / sends.length);
      }
      if (!bgOffsetErrors.has(key)) sent++;
    }
    // 5. Work written meanwhile, and the tablet's view of templates after the new list.
    pulled += await pullChanges(st, null, sentTpl);
    syncProgress(null);
    if (pulled || sent) toast(`Synced${pulled ? ` · ${pulled} page${pulled > 1 ? 's' : ''} of work saved` : ''}${sent ? ` · ${sent} page${sent > 1 ? 's' : ''} sent` : ''}`);
    await db.set('lastSync', Date.now());
    if ((pulled || sent || route.name === 'list') && !typing()) render();
  } catch (e) {
    syncProgress(null);
    toast('Sync stopped: ' + (e.message || e), 4000);
  } finally {
    syncing = false; $('#syncBtn').classList.remove('spin');
    if (syncAgain) { syncAgain = false; setTimeout(() => sync().catch(() => {}), 300); }
  }
}

// ------------------------------------------------------------------ hints
async function handleHintRequest({ d, p, level }) {
  const fail = msg => link.send(MSG.HINT_ERR, { d, p, msg }).catch(() => {});
  const a = findA(d), page = a && pageOf(a, p);
  if (!a || !page) return fail('That page is not on the phone anymore. Sync again.');
  if (!AI_ENABLED) return fail('AI hints are turned off in this version.');
  if (!settings.apiKey) return fail('Add your free Gemini API key in the phone app (Settings).');
  level = Math.min(3, Math.max(1, level || 1));
  const q = a.kind === 'pdf' ? null : page.qObj;
  const label = a.kind === 'pdf' ? `page ${page.n}` : `question ${page.n}`;
  toast(`Getting hint ${level} for ${label}…`);
  try {
    try { await pullPage(a, p); await db.putAssignment(a); } catch (e) { /* use what we have */ }
    let questionImage = null, workImage = null, questionText = '';
    if (a.kind === 'pdf') {
      const sp = page.local ? null : page.src;
      const bmp = sp ? await srcBitmap(a, sp) : null;
      if (bmp) questionImage = await canvasToBlob(scaledCanvas(bmp, 1200, 2400), 'image/jpeg', 0.85);
      questionText = 'The questions are on the worksheet page in the image. Help with the question the student is working on (look at their writing to see which one); if unclear, the first unfinished one.';
    } else if (q) {
      questionText = q.text || '';
      if (q.box) {
        const crop = cropBox(await getPageBitmap(a, q.page), q.box, 0.02);
        if (crop) questionImage = await canvasToBlob(crop, 'image/jpeg', 0.85);
      }
    }
    if (settings.hintSeesWork) {
      const pg = await getWork(a, p);
      if (pageHasWork(pg)) workImage = await canvasToBlob(await renderPageCanvas(a, page, 900, { cropToWork: true, withBg: a.kind === 'pdf' }), 'image/png');
    }
    let store = [];
    if (a.kind === 'pdf') { a.hints = a.hints || {}; store = a.hints[p] = a.hints[p] || []; }
    else if (q) store = q.hints = q.hints || [];
    const text = await getHint({
      key: settings.apiKey, model: settings.model || DEFAULT_MODEL, subject: a.subject, title: a.title,
      question: questionText, level, previous: store.map(x => x.text), questionImage, workImage,
      language: settings.hintLanguage, onStatus: t => toast(`Hint: ${t}`, 3000),
    });
    store.push({ level, text, at: Date.now() });
    await db.putAssignment(a);
    const img = await toJpeg(await renderHint(text, level, { width: 480, fontSize: 19 }), 0.82);
    await link.send(MSG.HINT, { d, p, level }, new Uint8Array(await img.arrayBuffer()));
    toast(`Hint sent to the tablet (${label})`);
    if (route.name === 'detail' && route.id === a.id) render();
  } catch (e) {
    fail(e.message || String(e));
    toast('Hint failed: ' + (e.message || e), 4000);
  }
}

// ------------------------------------------------------------------ typing text for the tablet
function handleTextRequest(req) {
  const a = findA(req.d);
  const editing = !!req.o;
  let size = editing ? Math.min(2, req.size || 0) : settings.textSize;
  let color = editing ? nearestPen(req.color) : settings.textColor;
  let ta;
  const cancel = () => link.send(MSG.TEXT_CANCEL, {}).catch(() => {});
  const sizeBtns = h('div', { class: 'seg' });
  const colorBtns = h('div', { class: 'swatches' });
  const paint = () => {
    sizeBtns.replaceChildren(...['Small', 'Medium', 'Large'].map((t, i) => h('button', { class: 'btn' + (i === size ? ' primary' : ''), onclick: () => { size = i; paint(); } }, t)));
    colorBtns.replaceChildren(...PEN_COLORS.slice(0, 12).map((c, i) => h('button', { class: 'sw' + (i === color ? ' on' : ''), style: `background:${c}`, 'aria-label': c, onclick: () => { color = i; paint(); } })));
    ta.style.fontSize = ['16px', '19px', '24px'][size]; ta.style.color = PEN_COLORS[color];
  };
  const close = sheet(close => [
    h('h2', {}, editing ? 'Edit text' : 'Type on the tablet'),
    h('p', { class: 'muted small' }, `${a ? a.title : ''} · goes where you tapped. Math: $x^2$, $$\\frac{a}{b}$$`),
    ta = h('textarea', { rows: 5, placeholder: 'Type here…' }, req.text || ''),
    sizeBtns, colorBtns,
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: () => { close(); cancel(); } }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const text = ta.value.replace(/\s+$/, '');
        close();
        if (!text) { cancel(); return; }
        settings.textSize = size; settings.textColor = color; saveSettings();
        try {
          const x = Math.max(0, req.x | 0), y = Math.max(0, req.y | 0);
          const r = await renderTextBox(text, { sizeUnits: TEXT_SIZES[size], color: PEN_COLORS[color], maxWUnits: Math.max(240, PAGE_W - 40 - x), k: 1.5 });
          const jpg = await toJpeg(r.canvas, 0.9);
          await link.send(MSG.OBJ, { d: req.d, p: req.p, o: req.o || newId('t'), x, y, w: r.wUnits, h: r.hUnits,
            size, color: c565(PEN_COLORS[color]), text }, new Uint8Array(await jpg.arrayBuffer()));
          toast('Text placed on the tablet');
        } catch (e) { toast('Could not send the text: ' + (e.message || e), 4000); }
      } }, editing ? 'Update' : 'Place')),
  ], cancel);
  paint();
  setTimeout(() => ta.focus(), 60);
}
function nearestPen(v) {
  const [R, G, B] = rgbOf565(v || 0);
  let best = 0, bd = 1e9;
  PEN_COLORS.forEach((c, i) => { const [r, g, b] = rgbOf565(c565(c)); const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}

// ------------------------------------------------------------------ adding homework / PDFs
async function pickFiles(camera, pdfOnly) {
  const input = camera ? $('#pickCamera') : $('#pickFiles');
  input.value = '';
  if (!camera) input.accept = pdfOnly ? 'application/pdf,.pdf,image/*' : 'image/*,application/pdf,.pdf';
  return new Promise(resolve => {
    input.onchange = () => resolve(Array.from(input.files || []));
    input.click();
  });
}

async function addPages(a, files) {
  if (!files.length) return;
  a.pages = a.pages || [];
  for (const f of files) {
    toast(`Adding ${f.name || 'photo'}…`, 6000);
    const info = await fileToPagesInfo(f, msg => toast(msg, 6000), 20);
    for (const pgi of info.pages) {
      const pid = newId('p');
      await db.putBlob(`page:${a.id}:${pid}`, pgi.blob);
      a.pages.push(pid);
    }
  }
  await save(a);
  toast(`${a.pages.length} page${a.pages.length > 1 ? 's' : ''} ready`);
}

const baseRecord = (kind, ev) => ({
  id: newId(kind === 'pdf' ? 'd' : 'a'), kind, title: ev ? ev.title : '', subject: ev ? ev.course : '',
  due: ev ? ev.due : null, style: 'auto', created: Date.now(), done: false,
  canvasUid: ev ? ev.uid : null, canvasUrl: ev ? ev.url : null,
  pages: [], questions: [], srcPages: [], extra: [], bg: {}, ver: {}, work: {}, hints: {}, tplSeen: {},
});

async function newHomework(camera, fromCanvas) {
  const files = await pickFiles(camera);
  if (!files.length && !fromCanvas) return;
  const a = baseRecord('hw', fromCanvas);
  await save(a);
  go({ name: 'detail', id: a.id });
  if (files.length) {
    await addPages(a, files);
    render();
    if (AI_ENABLED && settings.apiKey) readWithAI(a);
  }
}

// Annotate a PDF (or photos) directly: every page goes to the tablet as it is.
async function newAnnotate(fromCanvas, camera = false) {
  const files = await pickFiles(camera, true);
  if (!files.length) return;
  const a = baseRecord('pdf', fromCanvas);
  try {
    await addSourcePages(a, files);
  } catch (e) { toast('Could not open that file: ' + (e.message || e), 5000); return; }
  if (!a.title) a.title = isPdfFile(files[0]) ? (files[0].name || 'Document').replace(/\.pdf$/i, '')
    : `Worksheet ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  await save(a);
  go({ name: 'detail', id: a.id });
}

async function addSourcePages(a, files) {
  for (const f of files) {
    const info = await fileToPagesInfo(f, msg => toast(msg, 8000), 40);
    if (info.pdf && !a.srcPages.length && files.length === 1) await db.putBlob(`pdf:${a.id}`, info.pdf);
    else if (info.pdf || a.srcPages.length) await db.deleteBlob(`pdf:${a.id}`);   // mixed sources: picture pages only
    for (const pgi of info.pages) {
      const id = 'pg' + (a.srcPages.length + 1);
      await db.putBlob(`page:${a.id}:${id}`, pgi.blob);
      a.srcPages.push({ id, w: pgi.w, h: pgi.h, rot: info.pdf ? pgi.rot : 0, photo: !info.pdf });
    }
    if (info.skipped) toast(`Only the first ${info.pages.length} pages were added`, 5000);
  }
  toast(`${a.srcPages.length} page${a.srcPages.length > 1 ? 's' : ''} ready`);
}

// A homework that wasn't read by AI can be written on page by page instead.
async function convertToAnnotate(a) {
  a.kind = 'pdf'; a.srcPages = [];
  for (const pid of a.pages || []) {
    const blob = await db.getBlob(`page:${a.id}:${pid}`);
    if (!blob) continue;
    const bmp = await pageBitmap(`${a.id}:${pid}`, blob);
    const id = 'pg' + (a.srcPages.length + 1);
    await db.putBlob(`page:${a.id}:${id}`, blob);
    a.srcPages.push({ id, w: bmp.width, h: bmp.height, rot: 0, photo: true });
  }
  a.pages = []; a.questions = [];
  if (!a.title) a.title = 'Worksheet';
  await save(a); render();
}

async function readWithAI(a) {
  if (!AI_ENABLED) return;
  if (!settings.apiKey) { toast('Add your free Gemini API key in Settings first'); go({ name: 'settings' }); return; }
  if (!a.pages || !a.pages.length) { toast('Add photos or a PDF of the assignment first'); return; }
  if (answeredCount(a)) {
    const ok = await confirmBox('Read again?', 'This replaces the question list. Work you already wrote stays on questions whose number didn\'t change.', 'Read again');
    if (!ok) return;
  }
  busy.add(a.id); render();
  try {
    const pages = [];
    for (const pid of a.pages) pages.push(await db.getBlob(`page:${a.id}:${pid}`));
    const setStatus = t => {
      readStatus.set(a.id, t);
      const el = document.getElementById(`readStatus-${a.id}`);
      if (el) el.textContent = t;
    };
    setStatus(`Sending ${pages.length} page${pages.length > 1 ? 's' : ''} to Gemini…`);
    const r = await parseHomework({ key: settings.apiKey, model: settings.model || DEFAULT_MODEL, pages,
      hint: a.title ? `Assignment title: ${a.title}` : '', onStatus: setStatus });
    if (!r.questions.length) throw new Error('No questions were found. Try clearer photos.');
    const old = new Map((a.questions || []).map(q => [q.label, q]));
    a.questions = r.questions.map(q => {
      const prev = old.get(q.label);
      return Object.assign({ id: prev ? prev.id : newId('q'), hints: prev ? prev.hints : [] }, q);
    });
    if (!a.title) a.title = r.title || 'Homework';
    if (!a.subject) a.subject = r.subject || '';
    if (!a.due && r.due_date && /^\d{4}-\d{2}-\d{2}$/.test(r.due_date)) {
      const [Y, M, D] = r.due_date.split('-').map(Number);
      a.due = new Date(Y, M - 1, D, 23, 59).getTime();
    }
    await save(a);
    toast(`Found ${a.questions.length} question${a.questions.length > 1 ? 's' : ''}`);
  } catch (e) {
    toast(e.message || String(e), 5000);
  } finally {
    busy.delete(a.id); readStatus.delete(a.id); render();
  }
}

// ------------------------------------------------------------------ PDF export
async function pdfFor(a, attachments = []) {
  const pages = new Map();
  for (const p of pagesOf(a)) pages.set(p.id, await getWork(a, p.id));
  const pdfBytes = a.kind === 'pdf' ? await db.getBlob(`pdf:${a.id}`) : null;
  return buildPdf(a, {
    pages, attachments,
    pdfBytes: pdfBytes ? new Uint8Array(pdfBytes) : null,
    background: async p => {
      if (!p.qObj) return null;
      const c = await questionCard(a, p.qObj, { scale: 2.5 });
      const jpg = await toJpeg(c, 0.9);
      return { jpg: new Uint8Array(await jpg.arrayBuffer()), bh: c.height * PAGE_W / c.width };
    },
    pageImage: async p => {
      const blob = await db.getBlob(`page:${a.id}:${p.src.id}`);
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    },
    textImage: async o => {
      const c = await textBoxImage(o, 3, true);
      const png = await canvasToBlob(c, 'image/png');
      return new Uint8Array(await png.arrayBuffer());
    },
  });
}

// ------------------------------------------------------------------ recordings
const recName = (a, rec) => `Recording ${(a.recs || []).indexOf(rec) + 1}`;
const recFileName = (a, rec) => `${(a.title || 'Recording').replace(/[\\/:*?"<>|]+/g, '_')} - ${recName(a, rec)}.wav`;

// Gets a recording from the tablet (compressed blocks, continuing after a dropped connection).
async function fetchRecording(a, rec, onProgress) {
  const key = `aud:${a.id}:${rec.r}`;
  const done = await db.getBlob(key);
  if (done) return done;
  if (!link.connected) throw new Error('Connect the tablet to get this recording');
  await ensurePaired();
  a.audHave = a.audHave || {};
  let b = a.audHave[rec.r] || 0, nb = Infinity, rate = 16000, ms = rec.ms;
  while (b < nb) {
    const m = await link.request(MSG.GET_AUDIO, { d: a.id, r: rec.r, b, n: 24 },
      x => (x.type === MSG.T_AUDIO && x.json.d === a.id && x.json.r === rec.r && x.json.b === b) ||
           (x.type === MSG.T_ERROR && x.json.msg === 'no recording' && x.json.d === a.id && x.json.r === rec.r), { timeout: 30000 });
    if (m.type === MSG.T_ERROR) throw new Error('That recording isn\'t on the tablet any more');
    nb = m.json.nb; rate = m.json.rate || 16000; ms = m.json.ms || ms;
    const n = m.json.n || 0;
    if (!n) break;
    await db.putBlob(`audc:${a.id}:${rec.r}:${b}`, new Blob([m.blob]));
    b += n;
    a.audHave[rec.r] = b;
    await db.putAssignment(a);
    if (onProgress) onProgress(Math.min(1, b / Math.max(1, nb)));
  }
  // put the pieces together
  const parts = [];
  for (let at = 0; at < b;) {
    const piece = await db.getBlob(`audc:${a.id}:${rec.r}:${at}`);
    if (!piece) { a.audHave[rec.r] = 0; await db.putAssignment(a); throw new Error('Part of the recording went missing; try again'); }
    const u = new Uint8Array(await piece.arrayBuffer());
    parts.push(u); at += u.length / ADPCM_BLOCK;
  }
  const all = new Uint8Array(parts.reduce((t, u) => t + u.length, 0));
  let o = 0; for (const u of parts) { all.set(u, o); o += u.length; }
  const wav = new Blob([wavBytes(decodeAdpcm(all, Math.round(ms * rate / 1000)), rate)], { type: 'audio/wav' });
  await db.putBlob(key, wav);
  await db.deleteBlobsWithPrefix(`audc:${a.id}:${rec.r}:`);
  delete a.audHave[rec.r];
  await db.putAssignment(a);
  return wav;
}

function recordingsBlock(a) {
  const recs = a.recs || [];
  if (!recs.length) return null;
  const box = h('div', { class: 'card' }, h('b', {}, `Recordings (${recs.length})`),
    h('p', { class: 'muted small', style: 'margin:4px 0 8px' }, 'Made on the tablet (⋯ → Record audio). On the tablet, tap your writing while one plays to jump to the moment you wrote it. Exported PDFs carry the recordings as attachments.'));
  for (const rec of recs) {
    const row = h('div', { class: 'recrow' });
    const when = rec.start > 1.6e9 ? new Date(rec.start * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    const fill = async (blob) => {
      const url = URL.createObjectURL(blob);
      row.replaceChildren(h('div', { class: 'small' }, h('b', {}, recName(a, rec)), ` · ${fmtDuration(rec.ms)}${when ? ' · ' + when : ''}`),
        h('audio', { controls: true, src: url, preload: 'metadata', style: 'width:100%;margin-top:4px' }),
        h('button', { class: 'btn', style: 'margin-top:4px', onclick: async () => {
          const f = new File([blob], recFileName(a, rec), { type: 'audio/wav' });
          if (navigator.canShare && navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f] }); } catch (e) { /* cancelled */ } }
          else window.open(url, '_blank');
        } }, 'Share / save'));
    };
    db.getBlob(`aud:${a.id}:${rec.r}`).then(blob => {
      if (blob) { fill(blob); return; }
      const status = h('span', { class: 'muted small' });
      const btn = h('button', { class: 'btn', onclick: async () => {
        btn.disabled = true;
        try { fill(await fetchRecording(a, rec, f => { status.textContent = ` ${Math.round(f * 100)}%`; })); }
        catch (e) { btn.disabled = false; status.textContent = ' ' + (e.message || e); }
      } }, 'Get from tablet');
      row.replaceChildren(h('div', { class: 'small' }, h('b', {}, recName(a, rec)), ` · ${fmtDuration(rec.ms)}${when ? ' · ' + when : ''}`), btn, status);
    });
    box.append(row);
  }
  return box;
}

// ------------------------------------------------------------------ PDF export
// Built first, then shared from a fresh tap (iOS only lets a tap open the share sheet).
async function exportPdf(a) {
  toast('Making the PDF…', 60000);
  try {
    if (link.connected) {
      try { await pullChanges((await getStatus()).json); } catch (e) { /* export what we have */ }
    }
    // recordings go in as attachments (fetched from the tablet if needed)
    const recFiles = [], missing = [];
    for (const rec of a.recs || []) {
      try {
        const blob = await fetchRecording(a, rec, f => toast(`Getting ${recName(a, rec)} from the tablet… ${Math.round(f * 100)}%`, 60000));
        recFiles.push(new File([blob], recFileName(a, rec), { type: 'audio/wav' }));
      } catch (e) { missing.push(recName(a, rec)); }
    }
    toast('Making the PDF…', 60000);
    const attachments = [];
    for (const f of recFiles) attachments.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), mime: 'audio/wav' });
    const bytes = await pdfFor(a, attachments);
    const name = `${[a.subject, a.title].filter(Boolean).join(' - ') || 'Homework'}.pdf`.replace(/[\\/:*?"<>|]+/g, '_');
    const file = new File([bytes], name, { type: 'application/pdf' });
    const url = URL.createObjectURL(file);
    $('#toast').hidden = true;
    if (recFiles.length && route.name === 'detail' && route.id === a.id) render();   // recordings now playable here
    const shareFiles = async files => {
      if (navigator.canShare && navigator.canShare({ files })) {
        try { await navigator.share({ files, title: name }); return true; } catch (e) { return e.name === 'AbortError'; }
      }
      return false;
    };
    const size = bytes.length > 1048576 ? `${(bytes.length / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes.length / 1024))} KB`;
    sheet(close => [h('h2', {}, 'PDF ready'),
      h('p', { class: 'muted small' }, `${name} · ${size}${recFiles.length ? ` · ${recFiles.length} recording${recFiles.length > 1 ? 's' : ''} attached` : ''}`),
      missing.length ? h('p', { class: 'small', style: 'color:#b45309' }, `Not included (connect the tablet to add): ${missing.join(', ')}`) : null,
      h('button', { class: 'btn primary block', onclick: async () => {
        if (!(await shareFiles([file]))) window.open(url, '_blank');
      } }, '⬆︎ Save or share the PDF'),
      recFiles.length ? [h('div', { style: 'height:8px' }), h('button', { class: 'btn block', onclick: async () => {
        if (!(await shareFiles([file, ...recFiles]))) toast('This browser can\'t share several files at once; use the buttons above and in Recordings', 4000);
      } }, '⬆︎ Share the PDF and the recordings')] : [],
      h('div', { style: 'height:8px' }),
      h('button', { class: 'btn block', onclick: () => window.open(url, '_blank') }, 'Open the PDF'),
      h('a', { class: 'btn block', href: url, download: name, style: 'margin-top:8px;text-align:center' }, 'Download'),
      h('p', { class: 'muted small', style: 'margin-top:10px' }, 'In "Save or share": Save to Files keeps it on your phone; Print and Canvas uploads work from there too.'),
      h('button', { class: 'btn block', style: 'margin-top:8px', onclick: close }, 'Close')]);
  } catch (e) {
    toast('PDF failed: ' + (e.message || e), 6000);
  }
}

// ------------------------------------------------------------------ views
function go(r) { route = r; window.scrollTo(0, 0); render(); }

function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active',
    b.dataset.tab === (route.name === 'detail' ? 'list' : route.name)));
  const v = $('#view');
  v.innerHTML = '';
  document.querySelectorAll('.fab').forEach(f => f.remove());
  if (route.name === 'list') v.append(viewList());
  else if (route.name === 'detail') v.append(viewDetail());
  else if (route.name === 'canvas') v.append(viewCanvas());
  else if (route.name === 'settings') v.append(viewSettings());
  updateChip();
}

function viewList() {
  const frag = document.createDocumentFragment();
  if (!link.supported) frag.append(h('div', { class: 'banner' }, 'To talk to the tablet, open this page in the ', h('b', {}, 'Bluefy'), ' browser app (free in the App Store).'));
  if (AI_ENABLED && !settings.apiKey) frag.append(h('div', { class: 'banner info' }, 'First step: add your free Gemini API key in ', h('a', { href: '#', onclick: e => { e.preventDefault(); go({ name: 'settings' }); } }, 'Settings'), '.'));

  const active = assignments.filter(a => !a.done);
  const done = assignments.filter(a => a.done);
  if (!active.length) {
    frag.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '📝'),
      h('p', {}, 'Nothing here yet.'), h('p', { class: 'small' }, AI_ENABLED ? 'Tap "+ New" to photograph an assignment, or pick a PDF to write on directly.' : 'Tap "+ New" to photograph a worksheet or pick a PDF, then write on it on the tablet.')));
  }
  const groups = new Map();
  active.sort((x, y) => (x.due || 9e15) - (y.due || 9e15)).forEach(a => {
    const g = dueInfo(a.due).group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(a);
  });
  for (const [g, list] of [...groups.entries()].sort((x, y) => dueInfo(x[1][0].due).order - dueInfo(y[1][0].due).order)) {
    frag.append(h('h3', {}, g));
    for (const a of list) frag.append(assignmentCard(a));
  }
  if (done.length) {
    const det = h('details', {}, h('summary', {}, `Finished (${done.length})`));
    for (const a of done) det.append(assignmentCard(a));
    frag.append(h('h3', {}, ''), det);
  }
  document.body.append(h('button', { class: 'fab', onclick: () => chooseSource() }, '+ New'));
  return frag;
}

function chooseSource(fromCanvas) {
  if (!AI_ENABLED) {
    sheet(close => [
      h('h2', {}, fromCanvas ? `Add "${fromCanvas.title}"` : 'New'),
      h('p', { class: 'muted small', style: 'margin:0 0 6px' }, 'The pages go to the tablet as they are, and you write straight on them. Export gives the pages back with your writing on them.'),
      h('button', { class: 'btn primary block', onclick: () => { close(); newAnnotate(fromCanvas, true); } }, '📷  Take a photo'),
      h('div', { style: 'height:8px' }),
      h('button', { class: 'btn block', onclick: () => { close(); newAnnotate(fromCanvas); } }, '📄  Pick a PDF or photos'),
      fromCanvas ? [h('div', { style: 'height:8px' }), h('button', { class: 'btn block', onclick: async () => { close(); await newHomeworkNoPages(fromCanvas); } }, 'Just track the due date for now')] : [],
    ]);
    return;
  }
  sheet(close => [
    h('h2', {}, fromCanvas ? `Add "${fromCanvas.title}"` : 'New'),
    h('p', { class: 'muted small', style: 'margin:0 0 6px' }, 'Homework: the AI finds each question and gives every question its own page to write on.'),
    h('button', { class: 'btn primary block', onclick: () => { close(); newHomework(true, fromCanvas); } }, '📷  Photograph homework'),
    h('div', { style: 'height:8px' }),
    h('button', { class: 'btn block', onclick: () => { close(); newHomework(false, fromCanvas); } }, '🖼️  Homework from photos or a PDF'),
    h('p', { class: 'muted small', style: 'margin:14px 0 6px' }, 'Worksheet: write straight on the pages, like Notability. Export gives back the same PDF with your writing on it.'),
    h('button', { class: 'btn block', onclick: () => { close(); newAnnotate(fromCanvas); } }, '📄  Annotate a PDF'),
    fromCanvas ? [h('div', { style: 'height:8px' }), h('button', { class: 'btn block', onclick: async () => { close(); await newHomeworkNoPages(fromCanvas); } }, 'Just track the due date for now')] : [],
  ]);
}

async function newHomeworkNoPages(ev) {
  const a = baseRecord('hw', ev);
  await save(a);
  go({ name: 'detail', id: a.id });
}

function assignmentCard(a) {
  const di = dueInfo(a.due);
  const isPdf = a.kind === 'pdf';
  const n = isPdf ? pagesOf(a).length : (a.questions || []).length;
  const done = isPdf ? pagesWithWork(a) : answeredCount(a);
  let badge = null;
  if (busy.has(a.id)) badge = h('span', { class: 'badge warn' }, h('span', { class: 'spinner' }), ' Reading');
  else if (a.note) badge = h('span', { class: 'badge' }, 'Notes');
  else if (isPdf) badge = h('span', { class: 'badge' }, 'PDF');
  else if (!a.pages || !a.pages.length) badge = h('span', { class: 'badge warn' }, 'Add pages');
  else if (!n) badge = h('span', { class: 'badge warn' }, 'Not read yet');
  else if (done === n) badge = h('span', { class: 'badge ok' }, 'All answered');
  return h('div', { class: 'card', onclick: () => go({ name: 'detail', id: a.id }) },
    h('div', { class: 'row' },
      h('span', { class: 'dot', style: `background:${subjColor(a.subject)}` }),
      h('span', { class: 'muted small grow' }, a.subject || (a.note ? 'Notes from the tablet' : (isPdf ? 'Worksheet' : 'No subject'))), badge),
    h('div', { class: 'title' }, a.title || 'Untitled'),
    h('div', { class: `due ${di.cls}` }, di.text),
    n ? h('div', {}, h('div', { class: 'muted small', style: 'margin-top:4px' }, isPdf ? `${n} page${n > 1 ? 's' : ''}${done ? ` · written on ${done}` : ''}` : `${done} of ${n} answered`),
      isPdf ? null : h('div', { class: 'progress' }, h('div', { style: `width:${Math.round(100 * done / n)}%` }))) : null);
}

// A preview of a tablet page, drawn lazily.
function pagePreview(a, page, { crop = true, label } = {}) {
  const box = h('div', { class: 'pgprev' }, label ? h('div', { class: 'muted small' }, label) : null,
    h('div', { class: 'muted small', style: 'padding:8px' }, h('span', { class: 'spinner' }), ' drawing…'));
  const w = Math.min(1100, Math.round((window.innerWidth || 390) * (window.devicePixelRatio || 2)));
  renderPageCanvas(a, page, w, { cropToWork: crop })
    .then(c => { c.className = 'cardimg'; box.lastChild.replaceWith(c); })
    .catch(e => { box.lastChild.textContent = 'Could not draw: ' + e.message; });
  return box;
}

function detailHeader(a) {
  const field = (label, input) => h('div', { class: 'field' }, h('label', {}, label), input);
  const saveField = (k, fn) => async e => { a[k] = fn ? fn(e.target.value) : e.target.value; await save(a); };
  const subjects = [...new Set(assignments.map(x => x.subject).filter(Boolean).concat(['Russian', 'Math', 'Physics', 'Chemistry', 'English', 'History']))];
  return h('div', { class: 'card' },
    field('Title', h('input', { value: a.title || '', placeholder: a.kind === 'pdf' ? 'Worksheet name' : 'e.g. Упражнение 5', onchange: saveField('title') })),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, field('Subject', h('input', { value: a.subject || '', list: 'subjList', placeholder: 'Subject', onchange: saveField('subject') }))),
      a.kind === 'pdf' ? null : h('div', { class: 'grow' }, field('Paper on tablet', h('select', { onchange: saveField('style') },
        ...[['auto', 'Automatic'], ['lines', 'Lined'], ['grid', 'Graph paper'], ['dots', 'Dotted'], ['blank', 'Blank']].map(([v, t]) => h('option', { value: v, selected: (a.style || 'auto') === v }, t)))))),
    field('Due', h('input', { type: 'datetime-local', value: toLocalInput(a.due), onchange: saveField('due', v => (v ? new Date(v).getTime() : null)) })),
    h('datalist', { id: 'subjList' }, ...subjects.map(s => h('option', { value: s }))),
    a.canvasUrl ? h('a', { href: a.canvasUrl, target: '_blank', class: 'small' }, 'Open in Canvas ↗') : null);
}

function detailActions(a, canExport) {
  return h('div', { class: 'card' },
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', disabled: !canExport, onclick: () => exportPdf(a) }, '📄 Export PDF'),
      h('button', { class: 'btn', onclick: () => (link.connected ? sync() : connectTablet()) }, '🔄 Send to tablet')),
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: async () => {
        if (!a.done && link.connected) await sync();   // save the latest work first
        else if (!a.done) {
          if (!(await confirmBox('Tablet not connected', 'Work on the tablet that hasn\'t been synced yet will be lost when it removes this. Mark finished anyway?', 'Mark finished'))) return;
        }
        a.done = !a.done; await save(a); toast(a.done ? 'Marked finished (removed from the tablet at next sync)' : 'Back on the list'); render(); } },
        a.done ? '↩︎ Not finished' : '✅ Mark finished'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmBox('Delete?', 'This deletes the pages and your work on this phone (and removes it from the tablet).', 'Delete', true))) return;
        await db.deleteAssignment(a.id);
        if (a.note) await db.set('deletedIds', ((await db.get('deletedIds', [])) || []).concat([a.id]).slice(-200));
        for (const pre of ['page', 'pg', 'bg', 'ink', 'aud', 'audc']) await db.deleteBlobsWithPrefix(`${pre}:${a.id}:`);
        await db.deleteBlob(`pdf:${a.id}`);
        assignments = assignments.filter(x => x.id !== a.id);
        if (link.connected) link.send(MSG.DELETE, { d: a.id }).catch(() => {});
        scheduleSync(); go({ name: 'list' }); } }, '🗑 Delete')));
}

function viewDetail() {
  const a = findA(route.id);
  if (!a) { setTimeout(() => go({ name: 'list' }), 0); return document.createDocumentFragment(); }
  const frag = document.createDocumentFragment();
  frag.append(h('button', { class: 'btn', style: 'margin-bottom:10px', onclick: () => go({ name: 'list' }) }, '‹ All homework'));
  frag.append(detailHeader(a));
  if (a.kind === 'pdf') return viewPdfDetail(a, frag);

  // uploaded pages
  const pagesBox = h('div', { class: 'pages' });
  (a.pages || []).forEach(async (pid, i) => {
    const blob = await db.getBlob(`page:${a.id}:${pid}`);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    pagesBox.append(h('div', { class: 'pg' }, h('img', { src: url, alt: `Page ${i + 1}` }),
      h('button', { class: 'x', onclick: async ev => { ev.stopPropagation();
        if (!(await confirmBox('Remove page?', `Remove page ${i + 1}? Read with AI again afterwards.`, 'Remove', true))) return;
        a.pages = a.pages.filter(x => x !== pid); await db.deleteBlob(`page:${a.id}:${pid}`); await save(a); render(); } }, '×')));
  });
  const reading = busy.has(a.id);
  const qs = a.questions || [];
  frag.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('b', { class: 'grow' }, `Pages (${(a.pages || []).length})`)),
    pagesBox,
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: async () => { await addPages(a, await pickFiles(true)); render(); } }, '📷 Photo'),
      h('button', { class: 'btn', onclick: async () => { await addPages(a, await pickFiles(false)); render(); } }, '🖼️ Photos / PDF')),
    AI_ENABLED ? h('button', { class: 'btn primary block', style: 'margin-top:10px', disabled: reading || !(a.pages || []).length, onclick: () => readWithAI(a) },
      reading ? [h('span', { class: 'spinner' }), ' Reading the pages…'] : (qs.length ? '✨ Read with AI again' : '✨ Read with AI')) : null,
    reading ? h('div', { id: `readStatus-${a.id}`, class: 'muted small', style: 'margin-top:6px;text-align:center' }, readStatus.get(a.id) || 'Working…') : null,
    !qs.length && (a.pages || []).length && !reading ? h('button', { class: AI_ENABLED ? 'btn block' : 'btn primary block', style: 'margin-top:8px', onclick: () => convertToAnnotate(a) }, AI_ENABLED ? '📄 Write on these pages directly instead' : '📄 Write on these pages') : null));

  if (qs.length) frag.append(h('h3', {}, `Questions (${answeredCount(a)}/${qs.length} answered)`));
  const all = pagesOf(a);
  qs.forEach((q, idx) => frag.append(questionBlock(a, q, idx, all.filter(p => p.q === q.id))));
  if (a.pages && a.pages.length) frag.append(h('button', { class: 'btn block', style: 'margin:6px 0 10px', onclick: async () => {
    a.questions = qs.concat([{ id: newId('q'), label: String(qs.length + 1), text: '', page: 1, box: null, figures: [], paper: null, hints: [] }]);
    await save(a); render(); } }, '+ Add a question by hand'));
  const rb = recordingsBlock(a);
  if (rb) frag.append(rb);
  frag.append(detailActions(a, qs.length > 0));
  return frag;
}

function viewPdfDetail(a, frag) {
  const pages = pagesOf(a);
  frag.append(h('h3', {}, `${pages.length} page${pages.length === 1 ? '' : 's'}${pagesWithWork(a) ? ` · written on ${pagesWithWork(a)}` : ''}`));
  const grid = h('div', { class: 'pdfgrid' });
  for (const p of pages) {
    const hints = (a.hints || {})[p.id] || [];
    const cell = h('div', { class: 'card pdfpage' },
      pagePreview(a, p, { crop: false }),
      h('div', { class: 'muted small' }, a.note ? `Page ${pages.indexOf(p) + 1}` : (p.local ? `Added page (after ${p.n || 'start'})` : `Page ${p.n}${p.rot ? ' (turned)' : ''}`)),
      hints.length ? h('details', { class: 'hints' }, h('summary', {}, `${hints.length} hint${hints.length > 1 ? 's' : ''}`),
        ...hints.map(x => h('p', {}, h('b', {}, `Hint ${x.level}: `), x.text))) : null);
    grid.append(cell);
  }
  frag.append(grid);
  if (!a.note) frag.append(h('div', { class: 'btns', style: 'margin:8px 0' },
    h('button', { class: 'btn', onclick: async () => {
      const files = await pickFiles(true); if (!files.length) return;
      await addSourcePages(a, files); await save(a); render(); } }, '📷 Add a photo'),
    h('button', { class: 'btn', onclick: async () => {
      const files = await pickFiles(false, true); if (!files.length) return;
      await addSourcePages(a, files); await save(a); render(); } }, '+ Add pages')));
  const rb = recordingsBlock(a);
  if (rb) frag.append(rb);
  frag.append(detailActions(a, pages.length > 0));
  return frag;
}

function questionBlock(a, q, idx, pages) {
  const box = h('div', { class: 'card q' });
  const answered = pages.some(p => (a.work || {})[p.id]);
  const head = h('div', { class: 'qhead' },
    h('b', { class: 'grow' }, `Question ${q.label}`),
    answered ? h('span', { class: 'badge ok' }, 'Answered') : null,
    (q.hints || []).length ? h('span', { class: 'badge warn' }, `${q.hints.length} hint${q.hints.length > 1 ? 's' : ''}`) : null,
    h('button', { class: 'btn', style: 'padding:6px 12px', onclick: () => edit() }, 'Edit'));
  box.append(head);
  if (answered) {
    for (const p of pages) if ((a.work || {})[p.id]) box.append(pagePreview(a, p, { crop: true, label: p.local ? 'Extra page' : null }));
  } else {
    const imgHolder = h('div', {}, h('div', { class: 'muted small', style: 'padding:10px 14px' }, h('span', { class: 'spinner' }), ' drawing…'));
    box.append(imgHolder);
    renderQuestion(q, { width: 480, scale: 2, fontSize: 19, showOriginal: settings.showOriginal, getPage: n => getPageBitmap(a, n), maxFigH: 300, maxOrigH: 420 })
      .then(c => { c.className = 'cardimg'; imgHolder.replaceChildren(c); })
      .catch(e => { imgHolder.replaceChildren(h('div', { class: 'muted small', style: 'padding:10px 14px' }, 'Could not draw: ' + e.message)); });
  }
  if ((q.hints || []).length) {
    box.append(h('details', { class: 'hints' }, h('summary', {}, 'Hints you got'),
      ...q.hints.map(x => h('p', {}, h('b', {}, `Hint ${x.level}: `), x.text))));
  }

  function edit() {
    const label = h('input', { value: q.label });
    const text = h('textarea', { rows: 8 }, q.text || '');
    const paper = h('select', {}, ...[['', 'Same as homework'], ['lines', 'Lined'], ['grid', 'Graph paper'], ['dots', 'Dotted'], ['blank', 'Blank']]
      .map(([v, t]) => h('option', { value: v, selected: (q.paper || '') === v }, t)));
    const editor = h('div', { class: 'editor' },
      h('div', { class: 'field' }, h('label', {}, 'Number / label'), label),
      h('div', { class: 'field' }, h('label', {}, 'Question text (math: $x^2$, $$\\frac{a}{b}$$)'), text),
      h('div', { class: 'field' }, h('label', {}, 'Paper'), paper),
      h('div', { class: 'btns' },
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmBox('Delete question?', 'Its page on the tablet (and what you wrote there) will be removed at the next sync.', 'Delete', true))) return;
          a.questions = a.questions.filter(z => z !== q); await save(a); render(); } }, 'Delete'),
        h('button', { class: 'btn', onclick: () => render() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          q.label = label.value.trim() || String(idx + 1); q.text = text.value; q.paper = paper.value || null;
          await save(a); render(); } }, 'Save')));
    box.replaceChildren(head, editor);
  }
  return box;
}

function viewCanvas() {
  const frag = document.createDocumentFragment();
  frag.append(h('h2', {}, 'Canvas due dates'));
  if (!settings.canvasFeed) {
    frag.append(h('div', { class: 'card' },
      h('p', {}, 'Connect your Canvas calendar to see due dates here and on the tablet.'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Open Canvas in a browser and go to ', h('b', {}, 'Calendar'), '.'),
        h('li', {}, 'At the bottom right, tap ', h('b', {}, 'Calendar Feed'), ' and copy the link.'),
        h('li', {}, 'Paste it in ', h('a', { href: '#', onclick: e => { e.preventDefault(); go({ name: 'settings' }); } }, 'Settings → Canvas'), '.'))));
    return frag;
  }
  const status = h('div', { class: 'muted small' });
  frag.append(h('div', { class: 'row', style: 'margin-bottom:10px' }, h('div', { class: 'grow' }, status),
    h('button', { class: 'btn', onclick: () => refreshCanvas(true) }, '↻ Refresh')));
  db.get('canvasFetched').then(t => { status.textContent = t ? `Updated ${new Date(t).toLocaleString()}` : 'Not loaded yet'; });

  const linked = new Map(assignments.filter(a => a.canvasUid).map(a => [a.canvasUid, a]));
  const now = Date.now();
  const upcoming = canvasEvents.filter(e => e.due >= now - 2 * 86400000 && e.due <= now + 45 * 86400000 && !canvasDismissed.has(e.uid))
    .sort((x, y) => x.due - y.due);
  if (!upcoming.length) frag.append(h('div', { class: 'empty' }, h('p', {}, 'Nothing due in the next 45 days. 🎉')));
  let lastGroup = '';
  for (const e of upcoming) {
    const di = dueInfo(e.due);
    if (di.group !== lastGroup) { frag.append(h('h3', {}, di.group)); lastGroup = di.group; }
    const a = linked.get(e.uid);
    frag.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'dot', style: `background:${subjColor(e.course)}` }), h('span', { class: 'muted small grow' }, e.course || 'Canvas'),
        a ? null : h('button', { class: 'muted', style: 'font-size:18px', 'aria-label': 'Hide', onclick: async () => { canvasDismissed.add(e.uid); await db.set('canvasDismissed', [...canvasDismissed]); scheduleSync(); render(); } }, '×')),
      h('div', { class: 'title' }, e.title),
      h('div', { class: `due ${di.cls}` }, di.text),
      h('div', { class: 'btns' },
        a ? h('button', { class: 'btn', onclick: () => go({ name: 'detail', id: a.id }) }, 'Open') :
          h('button', { class: 'btn primary', onclick: () => chooseSource(e) }, '+ Add'),
        e.url ? h('a', { class: 'btn', href: e.url, target: '_blank' }, 'Canvas ↗') : null)));
  }
  return frag;
}

async function refreshCanvas(showToast) {
  if (!settings.canvasFeed) return;
  try {
    canvasEvents = await fetchCanvas(settings.canvasFeed, settings.canvasRelay);
    await db.set('canvasEvents', canvasEvents);
    await db.set('canvasFetched', Date.now());
    for (const a of assignments) {
      const e = a.canvasUid && canvasEvents.find(x => x.uid === a.canvasUid);
      if (e && e.due !== a.due) { a.due = e.due; await db.putAssignment(a); }
    }
    if (showToast) toast(`Canvas: ${canvasEvents.filter(e => e.isAssignment).length} assignments loaded`);
    scheduleSync();
    if (route.name === 'canvas' || route.name === 'list') render();
  } catch (e) {
    if (showToast) toast(e.message || String(e), 5000);
  }
}

function viewSettings() {
  const frag = document.createDocumentFragment();
  const field = (label, input, help) => h('div', { class: 'field' }, h('label', {}, label), input, help ? h('div', { class: 'muted small', style: 'margin-top:4px' }, help) : null);
  const bind = (k, el, conv = v => v) => { el.addEventListener('change', () => { settings[k] = conv(el.type === 'checkbox' ? el.checked : el.value.trim()); saveSettings(); scheduleSync(); }); return el; };
  const toggle = (k, label) => h('label', { class: 'toggle' }, h('span', {}, label), bind(k, h('input', { type: 'checkbox', checked: !!settings[k] })));

  frag.append(h('h2', {}, 'Settings'));
  const modelSel = h('select', {}, h('option', { value: settings.model }, settings.model));
  bind('model', modelSel);
  const keyInput = bind('apiKey', h('input', { type: 'password', value: settings.apiKey, placeholder: 'AIza…', autocomplete: 'off' }));
  const keyStatus = h('div', { class: 'muted small' });
  if (AI_ENABLED) frag.append(h('h3', {}, 'AI (Google Gemini, free)'), h('div', { class: 'card' },
    field('Gemini API key', keyInput, h('span', {}, 'Free key: ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank' }, 'aistudio.google.com/apikey'),
      ' → "Create API key". Stored only on this phone. Free-tier requests may be used by Google to improve its products, so don\'t upload anything private.')),
    field('Model', modelSel, 'gemini-flash-latest always points at Google\'s current fast model. If you hit the free limit, try a "flash-lite" model.'),
    h('button', { class: 'btn', onclick: async () => {
      keyStatus.textContent = 'Checking…';
      try {
        const models = await listModels(settings.apiKey);
        modelSel.replaceChildren(...[...new Set([settings.model, DEFAULT_MODEL, ...models])].map(m => h('option', { value: m, selected: m === settings.model }, m)));
        keyStatus.textContent = `✓ Key works. ${models.length} models available.`;
      } catch (e) { keyStatus.textContent = '✗ ' + e.message; }
    } }, 'Check key & list models'), keyStatus,
    toggle('hintSeesWork', 'Hints can look at my handwriting'),
    field('Hint language', bind('hintLanguage', h('select', {}, ...['English', 'Russian', 'Spanish', 'French', 'German', 'Chinese']
      .map(l => h('option', { value: l, selected: settings.hintLanguage === l }, l)))))));

  frag.append(h('h3', {}, 'Tablet'), h('div', { class: 'card' },
    field('Pairing code', bind('pin', h('input', { type: 'tel', inputmode: 'numeric', value: settings.pin, placeholder: 'shown on the tablet (Settings ⚙︎)' }))),
    toggle('autoSync', 'Sync automatically'),
    AI_ENABLED ? toggle('showOriginal', 'Show the original scan under each question') : null,
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: () => connectTablet() }, link.connected ? 'Reconnect' : 'Connect tablet'),
      link.connected ? h('button', { class: 'btn', onclick: () => { link.disconnect(); updateChip(); render(); } }, 'Disconnect') : null),
    link.info ? h('p', { class: 'muted small' }, `Tablet firmware ${link.info.fw} · storage: ${link.info.store}${link.info.audio ? ' · audio recording ready' : ''}`) : null));

  frag.append(h('h3', {}, 'Canvas'), h('div', { class: 'card' },
    field('Calendar feed link', bind('canvasFeed', h('input', { type: 'url', value: settings.canvasFeed, placeholder: 'https://…/feeds/calendars/user_….ics' })),
      'Canvas → Calendar → "Calendar Feed" (bottom right) → copy the link.'),
    field('Relay URL (only if needed)', bind('canvasRelay', h('input', { type: 'url', value: settings.canvasRelay, placeholder: 'https://script.google.com/macros/s/…/exec' }))),
    h('details', {}, h('summary', {}, 'What is the relay?'),
      h('p', { class: 'small' }, 'Canvas often blocks web pages from reading the calendar feed. The relay is a 10-line Google Apps Script you run on your own Google account for free. The code and steps are in proxy/canvas-relay.gs in this project.')),
    toggle('canvasOnTablet', 'Show Canvas due dates on the tablet'),
    h('button', { class: 'btn', onclick: () => refreshCanvas(true) }, 'Load Canvas now')));

  frag.append(h('h3', {}, 'About'), h('div', { class: 'card small muted' },
    h('p', {}, `Homework Tablet app ${APP_VERSION}. Your homework, work and keys stay on this phone and the tablet.`),
    h('p', {}, AI_ENABLED ? 'Your writing is never sent to the AI unless you ask for a hint (and "Hints can look at my handwriting" is on).' : 'AI features are turned off: nothing is sent anywhere except to your tablet (and Canvas, if you set it up).'),
    h('p', {}, 'Audio recordings stay on the tablet\'s microSD card (folder /rec).')));
  return frag;
}

// ------------------------------------------------------------------ boot
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => go({ name: b.dataset.tab })));
$('#tabletChip').addEventListener('click', () => {
  if (link.connected) {
    sheet(close => [h('h2', {}, 'Tablet'),
      h('p', { class: 'muted' }, link.info ? `Battery ${link.info.bat >= 0 ? link.info.bat + '%' : 'n/a'} · firmware ${link.info.fw}` : 'Connected'),
      h('button', { class: 'btn primary block', onclick: () => { close(); sync(); } }, 'Sync now'),
      h('div', { style: 'height:8px' }),
      h('button', { class: 'btn block', onclick: () => { close(); link.disconnect(); updateChip(); } }, 'Disconnect')]);
  } else connectTablet();
});
$('#syncBtn').addEventListener('click', () => (link.connected ? sync() : connectTablet()));

window.__hwBooted = true;   // the start-up watchdog in index.html checks this
if (window.__hwBootCheck) window.__hwBootCheck();   // report files that failed to load

(async () => {
  try { await load(); }
  catch (e) {
    render();
    $('#view').prepend(h('div', { class: 'banner' }, 'Could not open the phone\'s storage: ' + (e.message || e) +
      ' Homework you add now may not be saved. Try reloading the page.'));
    return;
  }
  render();
  if (settings.canvasFeed) {
    const last = await db.get('canvasFetched', 0);
    if (Date.now() - last > 3 * 3600 * 1000) refreshCanvas(false);
  }
  try { if (navigator.wakeLock) document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') navigator.wakeLock.request('screen').catch(() => {}); }); } catch (e) { /* */ }
})();

// For automated tests
window.__hw = {
  settings, link, buildManifest, AI_ENABLED, refreshCanvas, findA: id => findA(id), pagesOf, sync,
  get assignments() { return assignments; },
  pdfBytes: id => pdfFor(findA(id)),
  tplOf: (id, i) => { const a = findA(id); return tplFor(a, pagesOf(a)[i]); },
  recording: (id, r) => { const a = findA(id); return fetchRecording(a, a.recs.find(x => x.r === r)); },
  async pdfWithRecordings(id) {
    const a = findA(id), att = [];
    for (const rec of a.recs || []) att.push({ name: recFileName(a, rec), bytes: new Uint8Array(await (await fetchRecording(a, rec)).arrayBuffer()), mime: 'audio/wav' });
    return pdfFor(a, att);
  },
  async renderPage(id, pid, w = 800) { const a = findA(id); return (await renderPageCanvas(a, pageOf(a, pid), w)).toDataURL('image/png'); },
};
