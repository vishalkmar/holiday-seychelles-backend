/**
 * Grounding check (DESIGN.md §3.6 step 4): every price in the answer must be a
 * number that appears in this turn's tool results, and every specific travel
 * date must come from the tool results, the slots or the visitor's message.
 * Anything else is removed — the model may have invented it — and the reply
 * gets a "check live price" link instead.
 *
 * Pure: text + evidence in, { text, removed[] } out.
 */

const CUR = '(?:€|\\$|£|₹|eur|euros?|usd|dollars?|gbp|pounds?|scr|rupees?|rs\\.?|inr)';
const AMOUNT = '(\\d{1,3}(?:[,\\s.]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const PRICE_RE = new RegExp(`(?:${CUR}\\s?${AMOUNT}|${AMOUNT}\\s?${CUR})`, 'gi');

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DATE_RE = new RegExp(`\\b(\\d{4}-\\d{2}-\\d{2})\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})\\b|\\b(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');

function toNumber(s) {
  let t = String(s).replace(/\s/g, '');
  // 1.158,53 (European) vs 1,158.53
  if (/,\d{1,2}$/.test(t) && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/,\d{1,2}$/.test(t) && !t.includes('.')) t = t.replace(',', '.');
  else t = t.replace(/,/g, '');
  return Number(t);
}

/** Every number anywhere in the tool results. */
function numbersIn(value, out = new Set()) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'number' && Number.isFinite(value)) out.add(value);
  else if (typeof value === 'string') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) out.add(Number(value));
  } else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (typeof value === 'object') Object.entries(value).forEach(([k, v]) => { if (k !== 'url' && k !== 'thumbnail') numbersIn(v, out); });
  return out;
}

/** Every YYYY-MM-DD in the evidence, as "MM-DD" too (text often has no year). */
function datesIn(values) {
  const out = new Set();
  const s = JSON.stringify(values);
  for (const m of s.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    out.add(`${m[1]}-${m[2]}-${m[3]}`);
    out.add(`${m[2]}-${m[3]}`);
  }
  return out;
}

function priceAllowed(n, allowed) {
  for (const a of allowed) if (Math.abs(a - n) <= Math.max(1, a * 0.005)) return true;
  // A whole-euro rendering of an allowed price ("€1,159" for 1158.53).
  for (const a of allowed) if (Math.round(a) === Math.round(n)) return true;
  return false;
}

const { guardNames } = require('./names');

/**
 * evidence: { toolData: [...], slots, userText, dateTexts: [] }
 * → { text, removed: [{ kind, value }] }
 */
function ground(text, { toolData = [], slots = {}, userText = '', known = '', year } = {}) {
  const removed = [];
  // The visitor's own numbers (a budget of €600) may be repeated back to them.
  const allowed = numbersIn([toolData, slots]);
  for (const m of String(userText).matchAll(/\d+(?:[.,]\d+)?/g)) allowed.add(toNumber(m[0]));
  // Some models cite with full-width brackets: 【S1】 → [S1].
  let out = String(text || '').replace(/【\s*(S\d+)\s*】/g, '[$1]').replace(PRICE_RE, (match, a1, a2) => {
    const n = toNumber(a1 || a2);
    if (Number.isFinite(n) && priceAllowed(n, allowed)) return match;
    removed.push({ kind: 'price', value: match.trim() });
    return 'the live price';
  });

  const okDates = datesIn([toolData, slots]);
  const userLower = String(userText).toLowerCase();
  out = out.replace(DATE_RE, (match, iso, d1, m1, m2, d2) => {
    let key;
    if (iso) key = iso;
    else {
      const mon = MONTH_IDX[(m1 || m2).slice(0, 3).toLowerCase()];
      const day = Number(d1 || d2);
      if (!(day >= 1 && day <= 31)) return match;
      key = `${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    if (okDates.has(key) || userLower.includes(match.toLowerCase())) return match;
    removed.push({ kind: 'date', value: match.trim() });
    return 'a date shown on the website';
  });
  // Hotels, tours and restaurants only from our own data (extra track 1.3).
  const n = guardNames(out, `${JSON.stringify(toolData)} ${known} ${userText}`);
  out = n.text;
  removed.push(...n.removed);
  // Tidy what the replacements may leave: "from the live price per night" stays readable.
  out = out.replace(/\b(the live price)(\s*[-–—]\s*the live price)+/g, '$1').replace(/\s{2,}/g, ' ');
  return { text: out.trim(), removed, year };
}

/**
 * A model sometimes writes its tool call as the answer text
 * ({"tool": "Hotel search", "arguments": {...}}) — a visitor saw exactly that.
 * Such text is never shown.
 */
function looksLikeToolCall(text) {
  const s = String(text || '').trim();
  return /^[{[]/.test(s) && /"(tool|name|function|arguments|parameters)"\s*:/.test(s);
}

module.exports = { ground, numbersIn, toNumber, PRICE_RE, looksLikeToolCall };
