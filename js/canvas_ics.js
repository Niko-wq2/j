// Canvas due dates via the personal calendar feed (.ics) that Canvas offers
// under Calendar -> "Calendar Feed". No Canvas login or token needed.
// Browsers may block reading the feed directly (CORS); then the optional
// Google Apps Script relay in /proxy is used.

function unfold(text) { return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }
function unescape(v) { return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1'); }

function parseDate(value, params) {
  // 20261118T045900Z | 20261118T235900 | 20261118 (VALUE=DATE)
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, Y, M, D, h, mi, s, z] = m;
  if (!h) return new Date(+Y, +M - 1, +D, 23, 59).getTime();           // all-day: end of that day
  if (z) return Date.UTC(+Y, +M - 1, +D, +h, +mi, +s);
  return new Date(+Y, +M - 1, +D, +h, +mi, +s).getTime();               // floating/TZID: treat as local
}

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [name, ...paramList] = line.slice(0, idx).split(';');
    const value = line.slice(idx + 1);
    const params = Object.fromEntries(paramList.map(p => p.split('=')));
    if (name === 'UID') cur.uid = value;
    else if (name === 'SUMMARY') cur.summary = unescape(value);
    else if (name === 'DTSTART') cur.start = parseDate(value, params);
    else if (name === 'DTEND') cur.end = parseDate(value, params);
    else if (name === 'URL') cur.url = value;
    else if (name === 'DESCRIPTION') cur.description = unescape(value);
  }
  return events.map(e => {
    const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(e.summary || '');
    return {
      uid: e.uid || e.summary,
      title: m ? m[1] : (e.summary || 'Untitled'),
      course: m ? m[2] : '',
      due: e.start || e.end || null,
      url: e.url || '',
      isAssignment: /assignment/i.test(e.uid || '') || /\/assignments\//.test(e.url || ''),
    };
  }).filter(e => e.due);
}

export async function fetchCanvas(feedUrl, proxyUrl) {
  if (!feedUrl) throw new Error('Add your Canvas calendar feed link in Settings first.');
  let text = null, firstErr = null;
  try {
    const r = await fetch(feedUrl, { cache: 'no-store' });
    if (r.ok) text = await r.text();
    else firstErr = new Error(`Canvas answered ${r.status}`);
  } catch (e) { firstErr = e; }
  if (text === null && proxyUrl) {
    const r = await fetch(`${proxyUrl}${proxyUrl.includes('?') ? '&' : '?'}url=${encodeURIComponent(feedUrl)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Relay answered ${r.status}`);
    text = await r.text();
  }
  if (text === null) {
    throw new Error('Your browser blocked reading the Canvas feed directly. Set up the free relay (see Settings → Canvas help).' +
      (firstErr ? ` (${firstErr.message})` : ''));
  }
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('That link did not return a calendar. Copy the "Calendar Feed" link from Canvas again.');
  return parseIcs(text);
}
