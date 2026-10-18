/**
 * Rules pre-pass (no LLM): the cheap, certain parts of understanding a message.
 *
 *  - smalltalk: greetings, thanks, goodbyes in the launch languages (D8: the
 *    visitor's own language), answered without a model call when that's all it is
 *  - handoff: "talk to a person / agent"
 *  - dates: ISO, "10 nov", "nov 10", "10/11", "10 to 13 november", "tomorrow",
 *    "next week" → YYYY-MM-DD, never in the past
 *  - guests: "2 adults", "for 3 people", "2 kids aged 5 and 8", "couple"
 *  - nights: "for 3 nights"
 *
 * Pure: `today` is passed in, so tests are deterministic.
 */

const MONTHS = {
  jan: 0, january: 0, janvier: 0, januar: 0, gennaio: 0,
  feb: 1, february: 1, fevrier: 1, février: 1, februar: 1, febbraio: 1,
  mar: 2, march: 2, mars: 2, marz: 2, märz: 2, marzo: 2,
  apr: 3, april: 3, avril: 3, aprile: 3,
  may: 4, mai: 4, maggio: 4,
  jun: 5, june: 5, juin: 5, juni: 5, giugno: 5,
  jul: 6, july: 6, juillet: 6, juli: 6, luglio: 6,
  aug: 7, august: 7, aout: 7, août: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, septembre: 8, settembre: 8,
  oct: 9, october: 9, octobre: 9, oktober: 9, ottobre: 9,
  nov: 10, november: 10, novembre: 10,
  dec: 11, december: 11, decembre: 11, décembre: 11, dezember: 11, dicembre: 11,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const GREETING = /^(hi+|hey+|hello+|hola|hallo|bonjour|bonsoir|salut|ciao|buongiorno|namaste|namaskar|good (morning|afternoon|evening)|yo|greetings)\b[\s!.,]*(there|team|ji)?[\s!.,]*$/i;
const THANKS = /^(thanks?|thank you|thx|ty|merci|danke|grazie|dhanyavad|shukriya|ok(ay)? thanks?|great,? thanks?)\b[\s!.,]*(a lot|so much|beaucoup)?[\s!.,]*$/i;
const BYE = /^(bye|goodbye|see you|ciao|au revoir|tschüss|tschuss|arrivederci|alvida)\b[\s!.,]*$/i;
const HANDOFF = /\b(talk|speak|chat|connect)\b.{0,20}\b(human|person|agent|someone|representative|staff|team|real person)\b|\b(call me|contact (you|your team)|customer (care|service|support)|whatsapp)\b/i;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const addDays = (s, n) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));

/** A day/month with no year → the next occurrence on or after today. */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function nextOccurrence(day, month, today) {
  const t = new Date(`${today}T00:00:00Z`);
  let d = utc(t.getUTCFullYear(), month, day);
  if (d.getUTCMonth() !== month) return null; // 31 Feb
  if (ymd(d) < today) d = utc(t.getUTCFullYear() + 1, month, day);
  return ymd(d);
}

/** All dates in the text, in order. */
function findDates(text, today) {
  const s = ` ${String(text).toLowerCase()} `;
  const found = [];
  const push = (date, at) => date && found.push({ date, at });
  let m;
  const iso = /\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/g;
  while ((m = iso.exec(s))) push(ymd(utc(+m[1], +m[2] - 1, +m[3])), m.index);
  // "10 to 13 november", "10-13 nov", "10th–13th of november"
  const range = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|till|until|au|bis|al)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_RE})\\b`, 'g');
  while ((m = range.exec(s))) {
    const mo = MONTHS[m[3]];
    push(nextOccurrence(+m[1], mo, today), m.index);
    push(nextOccurrence(+m[2], mo, today), m.index + 1);
  }
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_RE})\\b`, 'g');
  while ((m = dm.exec(s))) push(nextOccurrence(+m[1], MONTHS[m[2]], today), m.index);
  const md = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g');
  while ((m = md.exec(s))) push(nextOccurrence(+m[2], MONTHS[m[1]], today), m.index);
  // 10/11 or 10/11/2026 — day first (Seychelles, Europe, India)
  const slash = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/g;
  while ((m = slash.exec(s))) {
    const day = +m[1];
    const mon = +m[2] - 1;
    if (mon < 0 || mon > 11 || day < 1 || day > 31) continue;
    if (m[3]) push(ymd(utc(m[3].length === 2 ? 2000 + +m[3] : +m[3], mon, day)), m.index);
    else push(nextOccurrence(day, mon, today), m.index);
  }
  if (/\b(today|aaj|aujourd'hui|heute|oggi)\b/.test(s)) push(today, s.search(/\b(today|aaj|aujourd'hui|heute|oggi)\b/));
  if (/\b(tomorrow|kal|demain|morgen|domani)\b/.test(s)) push(addDays(today, 1), s.search(/\b(tomorrow|kal|demain|morgen|domani)\b/));
  if (/\bday after tomorrow\b/.test(s)) push(addDays(today, 2), s.indexOf('day after'));
  if (/\bnext week\b/.test(s)) push(addDays(today, 7), s.indexOf('next week'));
  // "next saturday", "this friday", "on monday": the coming one ("next" on the
  // same weekday means a week later). Left to the model, it guessed the date.
  const wd = /\b(next|this|coming|on)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g;
  while ((m = wd.exec(s))) {
    const want = WEEKDAYS.indexOf(m[2]);
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    const ahead = (want - dow + 7) % 7;
    push(addDays(today, ahead === 0 && m[1] === 'next' ? 7 : ahead), m.index);
  }
  if (/\bthis weekend\b/.test(s)) {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    push(addDays(today, (6 - dow + 7) % 7), s.indexOf('this weekend'));
  }
  // De-duplicate positions (a range also matches as day+month), keep text order.
  const seen = new Set();
  return found
    .sort((a, b) => a.at - b.at)
    .filter((f) => f.date >= today && !seen.has(f.date) && seen.add(f.date))
    .map((f) => f.date);
}

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, ek: 1, do: 2, teen: 3, char: 4 };
const num = (w) => (/^\d+$/.test(w) ? Number(w) : WORD_NUM[w]);
// Not the Hindi "do" (2): "what to do with kids" would read as 2 children.
const NUMBER = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|ek|teen|char)';

function findGuests(text) {
  const s = String(text).toLowerCase();
  const out = {};
  let m = s.match(new RegExp(`\\b${NUMBER}\\s*(adults?|grown[- ]?ups?|adultes?|erwachsene|adulti)\\b`));
  if (m) out.adults = num(m[1]);
  m = s.match(new RegExp(`\\b(?:for|we are|we're|party of|group of)\\s+${NUMBER}\\s*(people|persons?|pax|guests?|of us|travellers|travelers)?\\b`));
  if (!out.adults && m && (m[2] || /we are|we're|party|group/.test(m[0]))) out.adults = num(m[1]);
  if (!out.adults && /\b(couple|honeymoon|my (wife|husband|partner)|two of us|both of us)\b/.test(s)) out.adults = 2;
  if (!out.adults && /\b(solo|alone|just me|myself)\b/.test(s)) out.adults = 1;
  m = s.match(new RegExp(`\\b${NUMBER}\\s*(kids?|child(ren)?|enfants?|kinder|bambini|bachche)\\b`));
  if (m) out.children = num(m[1]);
  m = s.match(/\b(?:aged?|ages?)\s+((?:\d{1,2}(?:\s*(?:,|and|&)\s*)?)+)/);
  if (m) {
    out.childAges = m[1].split(/\s*(?:,|and|&)\s*/).map(Number).filter((n) => Number.isInteger(n) && n < 18);
    if (!out.children) out.children = out.childAges.length;
  }
  m = s.match(new RegExp(`\\b${NUMBER}\\s*(nights?|nuits?|nächte|notti|raat)\\b`));
  if (m) out.nights = num(m[1]);
  return out;
}

/** → { kind: 'greeting'|'thanks'|'bye'|'handoff'|null, dates: [], guests: {} } */
function prepass(message, { today }) {
  const t = String(message || '').trim();
  let kind = null;
  if (GREETING.test(t)) kind = 'greeting';
  else if (THANKS.test(t)) kind = 'thanks';
  else if (BYE.test(t)) kind = 'bye';
  else if (HANDOFF.test(t)) kind = 'handoff';
  return { kind, dates: findDates(t, today), guests: findGuests(t) };
}

module.exports = { prepass, findDates, findGuests, addDays };
