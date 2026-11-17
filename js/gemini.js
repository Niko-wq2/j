// Google Gemini API (free tier) — reading homework pages and giving hints.
// Called straight from the phone with your own API key.
import { blobToBase64 } from './images.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-flash-latest';

export class GeminiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

// One request to one model. Throws GeminiError with .status and .retryAfter (seconds) when known.
async function callOnce(key, model, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    const err = new GeminiError(e.name === 'AbortError' ? 'Gemini took too long to answer.' : 'Could not reach Gemini (check the internet connection).', 0);
    err.transient = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '', retryAfter = 0, perDay = false;
    try {
      const j = await res.json();
      detail = (j.error && j.error.message) || '';
      for (const d of (j.error && j.error.details) || []) {
        if (d.retryDelay) retryAfter = parseFloat(d.retryDelay) || 0;
        for (const v of d.violations || []) if (/PerDay/i.test(v.quotaId || '')) perDay = true;
      }
    } catch (e) { /* */ }
    let err;
    if (res.status === 429) {
      err = new GeminiError(perDay ? 'The free daily Gemini limit for this model is used up.' : 'Too many Gemini requests in a short time.', 429);
      err.perDay = perDay;
    } else if (res.status === 400 && /API key/i.test(detail)) err = new GeminiError('Gemini rejected the API key. Check it in Settings.', 400);
    else if (res.status === 403) err = new GeminiError('Gemini refused the request (403). Check that your API key is correct. ' + detail, 403);
    else if (res.status === 404) err = new GeminiError(`Model "${model}" is not available.`, 404);
    else if (res.status >= 500) { err = new GeminiError('Gemini is overloaded right now (high demand).', res.status); err.transient = true; }
    else err = new GeminiError(`Gemini error ${res.status}: ${detail || res.statusText}`, res.status);
    err.retryAfter = retryAfter;
    err.detail = detail;
    throw err;
  }
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const why = data.promptFeedback && data.promptFeedback.blockReason;
    throw new GeminiError(why ? `Gemini blocked the request (${why}).` : 'Gemini returned no answer.', 200);
  }
  const text = (cand.content && cand.content.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text) { const e = new GeminiError('Gemini returned an empty answer.', 200); e.transient = true; throw e; }
  return text;
}

// Models to fall back to when the chosen one is overloaded or out of free quota.
let fallbackCache = null;
async function fallbackModels(key, primary) {
  if (!fallbackCache) {
    let listed = [];
    try { listed = await listModels(key); } catch (e) { /* use the built-in list */ }
    // stable "flash"/"flash-lite" models, newest first (skip previews/experiments)
    const stable = listed.filter(n => /^gemini-[\d.]+-flash(-lite)?$/.test(n));
    fallbackCache = ['gemini-flash-latest', 'gemini-flash-lite-latest', ...stable];
  }
  return [...new Set([primary, ...fallbackCache])].slice(0, 5);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Calls Gemini with automatic retries and model fallback.
 * opts: { budgetMs: give up after this long, timeoutMs: per request, onStatus(text) }
 */
async function call(key, model, body, { budgetMs = 180000, timeoutMs = 90000, onStatus } = {}) {
  const deadline = Date.now() + budgetMs;
  const say = t => { if (onStatus) onStatus(t); };
  const models = await fallbackModels(key, model);
  let last = null;
  for (let mi = 0; mi < models.length; mi++) {
    const m = models[mi];
    if (mi > 0) say(`Trying another Gemini model (${m})…`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const left = deadline - Date.now();
      if (left < 5000) break;
      try {
        const text = await callOnce(key, m, body, Math.min(timeoutMs, left));
        if (m !== model) rememberWorkingModel(m);
        return text;
      } catch (e) {
        last = e;
        if (e.status === 403 || (e.status === 400 && /API key/i.test(e.message))) throw e;  // key problem: retrying won't help
        if (e.status === 400) break;                                   // this model can't take the request: next one
        if (e.status === 404 || (e.status === 429 && e.perDay)) break; // try the next model
        if (e.status === 429 || e.transient) {
          if (attempt === 2) break;                                    // this model keeps failing: next one
          const wait = Math.min(Math.max(e.retryAfter || [4, 10][attempt], 2), 30) * 1000;
          if (Date.now() + wait > deadline - 5000) break;
          for (let t = Math.ceil(wait / 1000); t > 0; t--) {
            say(`${e.status === 429 ? 'Gemini rate limit' : 'Gemini is busy'} — retrying in ${t} s…`);
            await sleep(1000);
          }
          say('Asking Gemini again…');
          continue;
        }
        throw e;
      }
    }
  }
  if (last && last.status === 429 && last.perDay) throw new GeminiError('The free Gemini limits are used up for today. They reset at midnight Pacific time.', 429);
  if (last && (last.transient || last.status === 429))
    throw new GeminiError("Google's free AI is overloaded right now. Wait a few minutes and try again.", last.status);
  throw last || new GeminiError('Gemini did not answer.');
}

// If a fallback model worked, the app can switch to it (set by app.js).
let rememberWorkingModel = () => {};
export function onModelFallback(fn) { rememberWorkingModel = fn; }

// Lists models usable with generateContent, preferring "flash" ones.
export async function listModels(key) {
  const res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) {
    let d = ''; try { d = (await res.json()).error.message; } catch (e) { /* */ }
    throw new GeminiError(`Key check failed (${res.status}). ${d}`, res.status);
  }
  const j = await res.json();
  const names = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /gemini/.test(n) && !/(tts|image|embedding|audio|live|robotics|computer-use|veo|imagen)/.test(n));
  const score = n => (/flash-latest$/.test(n) ? 0 : /flash-lite-latest$/.test(n) ? 1 : /flash/.test(n) && !/lite/.test(n) ? 2 : /flash-lite/.test(n) ? 3 : 4);
  return names.sort((a, b) => score(a) - score(b) || b.localeCompare(a));
}

function parseJson(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (e) { /* try to cut out the object */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new GeminiError('Could not understand Gemini\'s reply. Try "Read with AI" again.');
}

const PARSE_PROMPT = `You are helping a student turn photos/scans of homework into a list of questions they will answer by hand on a small tablet.
The images are the pages of ONE assignment, in order (Page 1, Page 2, ...).

Return ONLY JSON in exactly this shape:
{
  "title": "short title in the original language, e.g. 'Упражнение 5' or 'Physics HW 7: Kinematics'",
  "subject": "one or two words in English, e.g. Russian, Math, Physics, Chemistry, English, History",
  "due_date": "YYYY-MM-DD if a due date is written on the pages, otherwise null",
  "questions": [
    {
      "label": "the question's printed number/letter, e.g. '1', '2b', 'Упр. 3'; number them yourself if there is none",
      "text": "the complete task exactly as the student must see it, in the ORIGINAL language (never translate)",
      "paper": "lines | grid | blank",
      "page": 1,
      "box": [ymin, xmin, ymax, xmax],
      "figures": [ { "page": 1, "box": [ymin, xmin, ymax, xmax] } ]
    }
  ]
}

Rules:
- One entry per item that needs its own written answer. If an exercise has numbered sub-items that each need an answer (for example 8 sentences to complete), make each sub-item its own question and start its text with a short version of the shared instruction.
- "text" must contain everything needed to answer without the page: the instruction, the sentence/word list/data, given values, and table contents (as simple lines). Keep blanks as "____". Use \\n for line breaks.
- Write ALL math in LaTeX: inline as $...$ and displayed equations as $$...$$ (e.g. $v_0 = 12\\ \\text{m/s}$, $\\frac{1}{2}at^2$). Units and Greek letters in LaTeX too.
- Read Cyrillic and handwriting carefully. Keep stress marks, ё, punctuation and capitalization exactly.
- "paper": "lines" for language/written answers, "grid" for math, physics and chemistry work, "blank" when the student must draw.
- "page" is the 1-based page where the question is. "box" is the bounding box of the whole question on that page, as integers normalized to 0-1000 (ymin, xmin, ymax, xmax).
- "figures": every diagram, graph, picture, circuit or table image the student needs to look at to answer, with its page and box. Use [] if none.
- Do NOT solve, answer, translate, or hint at anything. Only copy the tasks.
- Skip page headers, page numbers, answer keys and examples that are already solved.`;

/**
 * pages: array of JPEG Blobs. Returns {title, subject, due_date, questions[]}.
 */
export async function parseHomework({ key, model, pages, hint, onStatus }) {
  const parts = [{ text: PARSE_PROMPT + (hint ? `\n\nExtra context from the student: ${hint}` : '') }];
  for (let i = 0; i < pages.length; i++) {
    parts.push({ text: `Page ${i + 1}:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await blobToBase64(pages[i]) } });
  }
  const text = await call(key, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
  }, { budgetMs: 240000, timeoutMs: 120000, onStatus });
  const j = parseJson(text);
  const qs = Array.isArray(j.questions) ? j.questions : [];
  return {
    title: String(j.title || '').slice(0, 120),
    subject: String(j.subject || '').slice(0, 40),
    due_date: j.due_date || null,
    questions: qs.map((q, i) => ({
      label: String(q.label || i + 1).slice(0, 12),
      text: String(q.text || ''),
      paper: ['lines', 'grid', 'blank'].includes(q.paper) ? q.paper : null,
      page: Math.max(1, Math.min(pages.length, parseInt(q.page, 10) || 1)),
      box: Array.isArray(q.box) && q.box.length === 4 ? q.box.map(Number) : null,
      figures: (Array.isArray(q.figures) ? q.figures : [])
        .filter(f => f && Array.isArray(f.box) && f.box.length === 4)
        .map(f => ({ page: Math.max(1, Math.min(pages.length, parseInt(f.page, 10) || parseInt(q.page, 10) || 1)), box: f.box.map(Number) })),
    })),
  };
}

const HINT_RULES = `You are a patient tutor. You give HINTS ONLY — never answers.
Strict rules:
- Never state the final answer, a final number, the completed word/sentence/translation, or a full solution.
- Never finish the student's work for them. For language homework, explain the relevant rule or give a DIFFERENT example word — not the word they must write.
- For math/physics, you may name the formula or principle and say what to substitute, but stop before computing results.
- If the student's work so far contains a mistake, say WHERE to look (which step/line) and what kind of mistake to check for, without giving the correction.
- Hint levels: 1 = a small nudge or guiding question; 2 = name the concept, rule or formula and how it applies here; 3 = set up the first concrete step, then stop.
- At most 80 words. Plain text, no headings or bullet lists. Write math in LaTeX between $...$.`;

/**
 * Returns hint text. images: {question: canvas|Blob|null, work: Blob|null}
 */
export async function getHint({ key, model, subject, title, question, level, previous, questionImage, workImage, language, onStatus }) {
  const parts = [{
    text: `${HINT_RULES}\n- Write the hint in ${language || 'English'} (quote words from the homework in their original language when needed).\n\n` +
      `Subject: ${subject || 'unknown'}\nAssignment: ${title || ''}\nHint level requested: ${level} of 3\n\n` +
      `The question (original language):\n${question}`,
  }];
  if (questionImage) {
    parts.push({ text: 'Image of the question as printed:' });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await blobToBase64(questionImage) } });
  }
  if (workImage) {
    parts.push({ text: "The student's handwritten work so far (may be incomplete or empty):" });
    parts.push({ inline_data: { mime_type: 'image/png', data: await blobToBase64(workImage) } });
  }
  if (previous && previous.length) {
    parts.push({ text: 'Hints already given (do not repeat them; go one step further):\n' + previous.map((h, i) => `${i + 1}. ${h}`).join('\n') });
  }
  const text = await call(key, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.4 },
  }, { budgetMs: 62000, timeoutMs: 40000, onStatus });   // the tablet waits 75 s for a hint
  return text.replace(/^#+\s*/gm, '').trim();
}
