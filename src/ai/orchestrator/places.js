/**
 * Place names, answered without a model (fast and always the same):
 *
 *   "mahe", "Praslin?", "tell me about beau vallon", "la digue island",
 *   "anse lazio", "seychelles", a hotel area or hotel name from the website's
 *   hotel search ("anse royale", "kempinski")
 *
 * → a short intro from Destination Knowledge (admin → RAG → Destinations), and
 *   chips that start the guided flows with the place already filled in:
 *   Hotels in X · Things to do on <island> · Transfers · More about X.
 *
 * "More about X" (from the chip) answers with the place's other sections.
 * Typos within one or two letters are forgiven ("praslen", "mahee").
 *
 * Lookup order: built-in islands + Seychelles, published destinations, then the
 * live hotel-search autocomplete (tool hotels.locations: areas and hotels).
 */

const destinations = require('../knowledge/destinations');

const ISLAND_LABEL = {
  mahe: 'Mahé', praslin: 'Praslin', 'la-digue': 'La Digue', silhouette: 'Silhouette', curieuse: 'Curieuse',
  aride: 'Aride', cousin: 'Cousin', moyenne: 'Moyenne', 'bird-island': 'Bird Island', denis: 'Denis',
  fregate: 'Frégate', 'north-island': 'North Island', felicite: 'Félicité', 'outer-islands': 'the Outer Islands',
};
// Islands with their own hotel search and excursions filter.
const BOOKABLE_ISLANDS = new Set(['Mahé', 'Praslin', 'La Digue', 'Silhouette']);

// Fallback intros when an island has no published destination profile yet.
const BUILT_IN = {
  seychelles: {
    name: 'Seychelles',
    kind: 'country',
    tagline: '115 islands in the Indian Ocean',
    intro: 'Seychelles is an archipelago of 115 islands off East Africa, known for granite boulders, white-sand beaches, clear turquoise water and rare wildlife. Most visitors stay on Mahé, Praslin or La Digue and hop between them by ferry or short flight.',
  },
  mahe: { name: 'Mahé', kind: 'island', island: 'Mahé', tagline: 'Beaches, markets & Creole charm', intro: 'Mahé is the largest island and home to the capital, Victoria, and the international airport. Mountain forest, lively markets and very different bays make it a great base.' },
  praslin: { name: 'Praslin', kind: 'island', island: 'Praslin', tagline: 'Palm forests & famous bays', intro: 'Praslin is the second-largest island, home to the Vallée de Mai with its coco de mer palms and to beaches like Anse Lazio and Anse Georgette.' },
  'la-digue': { name: 'La Digue', kind: 'island', island: 'La Digue', tagline: 'Bikes, boulders & slow island life', intro: 'La Digue is a small, relaxed island best explored by bicycle, famous for the granite boulders of Anse Source d’Argent.' },
};

// Words around a place name that don't change what's asked.
const FILLER = /^(please\s+)?(tell me (more )?about|more about|what about|how about|info(rmation)? (on|about)|details (of|about|on)|about|explore|exploring|visit(ing)?|going to|trip to|travel(l?ing)? to|i (want|wanna|would like) to (go|visit|travel)( to)?|i am going to|i'?m going to|show me|what is|what's|where is|where's|kya hai|ke baare mein|ke bare me)\s+/i;
const TRAILING = /\s+(island|isl\.?|ke baare mein|ke bare me|ke bare mai|ke baare me|batao|bataiye|please)$/i;
// Booking or question words mean it's not a bare place name: the flows / AI handle those.
const NOT_A_PLACE = /\b(hotels?|stay|resorts?|villas?|rooms?|excursions?|tours?|trips?|transfers?|taxi|ferry|flights?|price|cost|cheap|book|best|which|when|how|why|weather|time|visa|money|food|beach(es)? (near|in)|nights?|adults?|kids?|\d)\b/i;

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
const close = (q, name) => q === name || (q.length >= 4 && distance(q, name) <= (q.length >= 8 ? 2 : 1));

/** The place part of a message, or null when the message is more than a place name. */
function placeQuery(message) {
  let t = String(message || '').trim().replace(/[?!.]+$/g, '').trim();
  if (!t || t.length > 60) return null;
  const more = /^(more about|tell me more about)\s+/i.test(t);
  for (let i = 0; i < 2; i += 1) t = t.replace(FILLER, '').trim();
  for (let i = 0; i < 2; i += 1) t = t.replace(TRAILING, '').trim();
  if (!t || NOT_A_PLACE.test(t)) return null;
  const words = t.split(/\s+/);
  if (words.length > 5) return null;
  return { query: t, more };
}

// ── Known places (built-in + published destinations), cached ───────────────
let cache = { at: 0, list: null };
async function knownPlaces() {
  if (cache.list && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  const list = [
    { key: 'seychelles', names: ['seychelles', 'the seychelles', 'seychelle', 'sez'], ...BUILT_IN.seychelles },
  ];
  let published = [];
  try {
    published = await destinations.listPublished();
  } catch {
    published = [];
  }
  const islandsWithProfile = new Set();
  for (const d of published) {
    const island = ISLAND_LABEL[d.island] || null;
    const isIsland = d.slug === d.island;
    if (isIsland) islandsWithProfile.add(d.slug);
    const base = norm(d.name).replace(/ island$/, '');
    const names = new Set([norm(d.name), base, norm(d.slug.replace(/-/g, ' '))]);
    if (base === 'la digue') names.add('ladigue');
    if (base === 'vallee de mai') names.add('valle de mai');
    list.push({ key: d.slug, slug: d.slug, names: [...names], name: isIsland ? island || d.name : d.name, kind: isIsland ? 'island' : 'area', island });
  }
  for (const [slug, p] of Object.entries(BUILT_IN)) {
    if (slug === 'seychelles' || islandsWithProfile.has(slug)) continue;
    list.push({ key: slug, names: [norm(p.name), norm(slug.replace(/-/g, ' '))], ...p });
  }
  cache = { at: Date.now(), list };
  return list;
}

function findKnown(list, q) {
  const n = norm(q);
  return list.find((p) => p.names.includes(n)) || list.find((p) => p.names.some((x) => close(n, x))) || null;
}

/** Tagline + first paragraphs of a destination's overview (or another section). */
function excerpt(text, maxChars = 480) {
  const parts = String(text || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { tagline: '', body: '' };
  let tagline = '';
  if (parts[0].length < 80 && !/[.!?]$/.test(parts[0])) tagline = parts.shift();
  let body = '';
  for (const p of parts) {
    if (body && body.length + p.length > maxChars) break;
    body = body ? `${body}\n\n${p}` : p;
  }
  if (body.length > maxChars + 200) body = `${body.slice(0, maxChars).replace(/\s+\S*$/, '')}…`;
  return { tagline, body };
}

async function sectionsFor(place) {
  if (!place.slug) return null;
  try {
    return (await destinations.getBySlug(place.slug))?.sections || null;
  } catch {
    return null;
  }
}

// ── Chips ──────────────────────────────────────────────────────────────────
function chipsFor(place, { more = true } = {}) {
  const chips = [];
  const island = place.island && BOOKABLE_ISLANDS.has(place.island) ? place.island : null;
  // Hotels: an area or hotel goes to the hotel search as typed on the website
  // ("Beau Vallon Bay"); a beach or sight without hotels of its own uses its island.
  const hotelPlace = place.hotelArea || (place.kind === 'island' ? place.island || place.name : island);
  if (place.kind === 'country') {
    chips.push({ label: '🏨 Hotels', action: { type: 'flow', flow: 'hotels', label: 'Hotels' } });
    chips.push({ label: '🏝 Excursions', action: { type: 'flow', flow: 'excursions', label: 'Excursions' } });
    chips.push({ label: '🚐 Transfers', action: { type: 'flow', flow: 'transfers', label: 'Transfers' } });
    chips.push({ label: '🗺 Explore islands', action: { type: 'flow', flow: 'islands', label: 'Explore islands' } });
    return chips;
  }
  if (place.kind === 'hotel') {
    chips.push({ label: `🏨 Check prices at ${place.name}`, action: { type: 'flow', flow: 'hotels', label: 'Hotels', vars: { island: place.hotelArea || place.area } } });
  } else if (hotelPlace) {
    chips.push({ label: `🏨 Hotels in ${place.kind === 'area' && place.hotelArea ? place.name : hotelPlace}`, action: { type: 'flow', flow: 'hotels', label: 'Hotels', vars: { island: hotelPlace } } });
  } else {
    chips.push({ label: '🏨 Hotels', action: { type: 'flow', flow: 'hotels', label: 'Hotels' } });
  }
  chips.push(island
    ? { label: `🏝 Things to do on ${island}`, action: { type: 'flow', flow: 'excursions', label: 'Excursions', vars: { island } } }
    : { label: '🏝 Excursions', action: { type: 'flow', flow: 'excursions', label: 'Excursions' } });
  chips.push({ label: '🚐 Transfers', action: { type: 'flow', flow: 'transfers', label: 'Transfers' } });
  if (more && place.slug) chips.push({ label: `📖 More about ${place.name}`, action: { type: 'message', text: `More about ${place.name}` } });
  return chips;
}

// ── Answers ────────────────────────────────────────────────────────────────
async function introReply(place) {
  if (place.kind === 'hotel') {
    const where = [place.area, place.island].filter(Boolean).join(', ');
    return {
      text: `**${place.name}** is a hotel${where ? ` in ${where}` : ''}, Seychelles.\n\nTell me your dates and I'll show you live room prices — or pick another option below.`,
      chips: chipsFor(place, { more: false }),
    };
  }
  const sections = await sectionsFor(place);
  const ex = sections?.overview ? excerpt(sections.overview) : { tagline: place.tagline || '', body: place.intro || '' };
  let body = ex.body;
  if (!body && place.kind === 'area') body = `${place.name} is${place.island ? ` on ${place.island},` : ' in'} Seychelles.`;
  const head = `**${place.name}**${ex.tagline ? ` — ${ex.tagline}` : ''}`;
  const what = place.kind === 'country' ? 'What would you like to plan?' : `What would you like to do${place.kind === 'island' ? ' on' : ' in'} ${place.name}?`;
  return { text: `${head}\n\n${body}\n\n${what}`, chips: chipsFor(place) };
}

async function moreReply(place) {
  const sections = await sectionsFor(place);
  if (!sections) return introReply(place);
  const pick = [
    ['thingsToDo', 'Things to do'],
    ['bestTime', 'Best time to visit'],
    ['whereToStay', 'Where to stay'],
  ];
  const parts = pick
    .filter(([k]) => sections[k])
    .map(([k, label]) => `**${label}**\n${excerpt(sections[k], 320).body}`);
  if (!parts.length) return introReply(place);
  return { text: `${parts.join('\n\n')}\n\nShall I find hotels or things to do?`, chips: chipsFor(place, { more: false }) };
}

/**
 * → null (not a place) or { reply: { text, chips }, place }
 * deps.tools: the tool runner (for the live hotel-search autocomplete).
 */
async function answer(message, { tools } = {}) {
  const pq = placeQuery(message);
  if (!pq) return null;
  const list = await knownPlaces();
  let place = findKnown(list, pq.query);

  // Not in our knowledge: ask the website's hotel search (areas and hotels).
  if (!place && tools && norm(pq.query).length >= 3) {
    const r = await tools.run('hotels.locations', { query: pq.query }, { audience: 'public' }).catch(() => null);
    const items = r?.ok ? r.data.items : [];
    const n = norm(pq.query);
    const like = (name) => norm(name).includes(n) || close(n, norm(name));
    // An area may only appear as the area of its hotels ("Anse Royal").
    const viaHotel = items.find((i) => i.kind === 'hotel' && like(i.area));
    const area = items.find((i) => i.kind === 'area' && like(i.name)) || (viaHotel && { ...viaHotel, kind: 'area', id: viaHotel.areaId, name: viaHotel.area });
    const hotel = items.find((i) => i.kind === 'hotel' && norm(i.name).includes(n));
    const hit = area || hotel;
    if (hit) {
      // An area or hotel on an island we have a profile for: use that island's chips.
      place = { key: `tv-${hit.id}`, name: hit.name, kind: hit.kind, area: hit.area, hotelArea: hit.area, island: hit.island };
    }
  }
  if (!place) return null;

  // A beach or sight from our knowledge: does the hotel search know it as an area?
  if (place.kind === 'area' && !place.hotelArea && tools) {
    const r = await tools.run('hotels.locations', { query: place.name }, { audience: 'public' }).catch(() => null);
    const n = norm(place.name);
    const area = r?.ok ? r.data.items.find((i) => i.kind === 'area' && (norm(i.name).startsWith(n) || n.startsWith(norm(i.name)))) : null;
    if (area) place = { ...place, hotelArea: area.name };
  }

  const reply = pq.more ? await moreReply(place) : await introReply(place);
  return { reply: { text: reply.text, cards: [], chips: reply.chips, sources: [], followUps: [] }, place };
}

module.exports = { answer, placeQuery, findKnown, knownPlaces, excerpt, chipsFor, _reset: () => { cache = { at: 0, list: null }; } };
