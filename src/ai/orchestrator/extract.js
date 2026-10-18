/**
 * Intent and slot extraction: one short LLM call that must answer JSON, merged
 * with the rules pre-pass (dates and guest counts from rules win — they are
 * exact) and with the slots already known in this conversation.
 */

const INTENTS = ['knowledge', 'live_search', 'both', 'flow_entry', 'handoff', 'smalltalk', 'out_of_scope'];
const PRODUCTS = ['hotels', 'excursions', 'transfers'];
const TRIP_KINDS = [
  ['cruise', /\b(boat trips?|cruises?|catamaran|yacht|sailing|sunset cruise|semi[- ]?submarine|glass[- ]?bottom)\b/i],
  ['marine', /\b(snorkel\w*|marine parks?)\b/i],
  ['diving', /\b(scuba|diving|dives?)\b/i],
  ['fishing', /\bfishing\b/i],
  ['islands', /\bisland hopping\b/i],
  ['nature', /\b(hik(e|es|ing)|nature walks?|trails?|bird ?watching)\b/i],
  ['adventure', /\b(jet ?skis?|kayak\w*|parasail\w*|banana boat)\b/i],
];
const SLOT_KEYS = ['destination', 'checkIn', 'checkOut', 'nights', 'adults', 'childAges', 'budget', 'hotelName', 'excursionName', 'excursionCategory', 'transferFrom', 'transferTo', 'date'];

const INSTRUCTIONS = `You classify one message to a Seychelles travel assistant. Answer with ONE JSON object and nothing else:
{"intent": "...", "product": "...", "language": "...", "slots": {...}}

intent:
- "knowledge": a question answered from travel information (islands, beaches, best time, visas, ferries, tips, what to do)
- "live_search": wants live prices or availability of hotels, excursions or transfers (a taxi or pick-up from the airport/jetty is a transfer; "tour cost", "price of a trip" is excursions)
- "both": wants live prices AND advice (e.g. "which island is best for a honeymoon and what hotels are there in March")
- "flow_entry": wants to start booking/planning a product but gives no details ("I need a transfer", "book a hotel")
- "handoff": wants a human, a call, or to complain about a booking
- "smalltalk": greeting, thanks, chit-chat
- "out_of_scope": anything not about travel to Seychelles or this company (coding, politics, other countries, medical/legal). Questions about prices or costs of Seychelles places, tours or hotels are NOT out of scope.
product: "hotels" | "excursions" | "transfers" | null (for live_search, both, flow_entry)
language: ISO 639-1 code of the visitor's message (en, fr, de, it, hi, …). Hinglish counts as "hi".
slots (only what the visitor said or clearly meant; omit the rest; dates as YYYY-MM-DD, never in the past):
destination (island or area), checkIn, checkOut, nights, adults, childAges (array of ages), budget (number),
hotelName, excursionName, excursionCategory — one of: adventure (jet ski, kayak, parasailing), fishing, diving (scuba),
cruise (boat trips, catamaran, sunset cruise), islands (island hopping), marine (snorkelling, marine parks), nature (hiking, gardens, birds, tortoises),
culture (sightseeing, Creole, food, markets), tours (island tours, day trips), other,
transferFrom, transferTo, date (excursion or transfer day).
A follow-up like "and for 4 nights?" or "what about La Digue?" continues the previous product.`;

function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanSlots(raw = {}, today) {
  const out = {};
  for (const k of SLOT_KEYS) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') continue;
    if (['checkIn', 'checkOut', 'date'].includes(k)) {
      if (DATE.test(String(v)) && String(v) >= today) out[k] = String(v);
    } else if (['nights', 'adults', 'budget'].includes(k)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n < (k === 'budget' ? 1e7 : 60)) out[k] = k === 'budget' ? n : Math.round(n);
    } else if (k === 'childAges') {
      const a = (Array.isArray(v) ? v : [v]).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < 18);
      if (a.length) out[k] = a.slice(0, 6);
    } else {
      const s = String(v).trim().slice(0, 80);
      if (s) out[k] = s;
    }
  }
  return out;
}

/**
 * → { intent, product, language, slots (merged), extracted (this turn), via: 'llm'|'rules' }
 * llm: the gateway (injectable); history: last messages [{ role, content }].
 */
async function extract({ message, history = [], state = {}, rules, today, llm, model, sessionId }) {
  let parsed = null;
  let error = null;
  try {
    const r = await llm.chat({
      model,
      purpose: 'route',
      sessionId,
      temperature: 0,
      maxTokens: 600,
      messages: [
        { role: 'system', content: `${INSTRUCTIONS}\nToday is ${today}.${state.product ? ` The conversation so far is about ${state.product}.` : ''}${state.slots && Object.keys(state.slots).length ? ` Known slots: ${JSON.stringify(state.slots)}.` : ''}` },
        ...history.slice(-4).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 600) })),
        { role: 'user', content: String(message).slice(0, 1000) },
      ],
    });
    parsed = parseJson(r.text);
  } catch (err) {
    error = err;
  }

  const intent = INTENTS.includes(parsed?.intent) ? parsed.intent : null;
  const product = PRODUCTS.includes(parsed?.product) ? parsed.product : null;
  const extracted = cleanSlots(parsed?.slots, today);

  // Rules win for dates and counts.
  if (rules.dates[0]) {
    if (product === 'hotels' || (!product && state.product === 'hotels') || rules.dates.length > 1) {
      extracted.checkIn = rules.dates[0];
      if (rules.dates[1]) extracted.checkOut = rules.dates[1];
    } else {
      extracted.date = rules.dates[0];
      if (!extracted.checkIn) extracted.checkIn = rules.dates[0];
    }
  }
  for (const k of ['adults', 'nights', 'childAges']) if (rules.guests[k] !== undefined) extracted[k] = rules.guests[k];
  // The kind of trip, when the visitor's words say it and the router left it out
  // ("boat trips on Mahé" otherwise listed jet skis first).
  if (!extracted.excursionCategory && !extracted.excursionName) {
    const kind = TRIP_KINDS.find(([, re]) => re.test(message));
    if (kind) extracted.excursionCategory = kind[0];
  }

  const slots = { ...(state.slots || {}), ...extracted };
  if (slots.checkIn && slots.nights && !extracted.checkOut && (extracted.nights || extracted.checkIn)) {
    slots.checkOut = new Date(Date.parse(`${slots.checkIn}T00:00:00Z`) + slots.nights * 86400000).toISOString().slice(0, 10);
  }
  if (slots.checkOut && slots.checkIn && slots.checkOut <= slots.checkIn) delete slots.checkOut;

  return {
    intent: intent || (error ? null : 'knowledge'),
    product: product || (['live_search', 'both', 'flow_entry'].includes(intent) ? state.product || null : null),
    language: typeof parsed?.language === 'string' && /^[a-z]{2}$/.test(parsed.language) ? parsed.language : state.language || 'en',
    slots,
    extracted,
    via: parsed ? 'llm' : 'rules',
    error: error ? { code: error.code || 'ERROR', message: error.message } : null,
  };
}

module.exports = { extract, parseJson, cleanSlots, INTENTS, PRODUCTS };
