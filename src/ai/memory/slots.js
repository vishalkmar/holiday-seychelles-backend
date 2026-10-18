/**
 * Slot memory rules (MEMORY-DESIGN.md §1): validation on write, expiry, the
 * "last shown" results with a 30-minute life, and ordinal references
 * ("the second one", "that hotel", "the cheapest"). Pure functions.
 */

const RESULTS_TTL_MS = 30 * 60 * 1000;

const ISLAND_SLUGS = {
  mahe: /^mah[eé]( island)?$/i,
  praslin: /^praslin( island)?$/i,
  'la-digue': /^la ?digue( island)?$/i,
  silhouette: /^silhouette( island)?$/i,
  curieuse: /^curieuse( island)?$/i,
  cousin: /^cousin( island)?$/i,
  aride: /^aride( island)?$/i,
  'bird-island': /^bird( island)?$/i,
  denis: /^denis( island)?$/i,
  fregate: /^fr[eé]gate( island)?$/i,
};

/** "Praslin Island" → "praslin" (for retrieval filters); unknown places stay as written. */
function islandSlug(name) {
  const s = String(name || '').trim();
  return Object.keys(ISLAND_SLUGS).find((k) => ISLAND_SLUGS[k].test(s)) || null;
}

/** Validate and normalise slots before they are stored. */
function clean(slots = {}, today) {
  const out = { ...slots };
  for (const k of ['checkIn', 'checkOut', 'date']) {
    if (out[k] && (!/^\d{4}-\d{2}-\d{2}$/.test(out[k]) || out[k] < today)) delete out[k];
  }
  if (out.checkIn && out.checkOut && out.checkOut <= out.checkIn) delete out.checkOut;
  if (out.adults !== undefined && !(Number.isInteger(out.adults) && out.adults >= 1 && out.adults <= 20)) delete out.adults;
  if (out.childAges && !Array.isArray(out.childAges)) delete out.childAges;
  if (out.destination) {
    const slug = islandSlug(out.destination);
    if (slug) out.island = slug;
  }
  // Never keep contact or payment details in slots.
  for (const k of Object.keys(out)) if (/email|phone|card|passport|password/i.test(k)) delete out[k];
  return out;
}

/** At the start of a new session: drop dates that have passed and stale results. */
function expire(slots = {}, today, now = Date.now()) {
  const out = clean(slots, today);
  if (out.lastResults && now - Date.parse(out.lastResults.at) > RESULTS_TTL_MS) delete out.lastResults;
  return out;
}

/** The cards shown this turn → lastResults (ids, labels and what's needed to open each). */
function resultsFrom(reply, now = new Date()) {
  const cards = (reply?.cards || []).filter((c) => c.title);
  if (!cards.length) return null;
  return {
    type: cards[0].type,
    at: now.toISOString(),
    items: cards.slice(0, 8).map((c, i) => ({ n: i + 1, id: c.id || null, title: c.title, price: c.price ?? null, currency: c.currency || null, url: c.url || null })),
  };
}

const ORDINALS = [
  [/\b(first|1st|top)\b|\bpehl[aei]\b|\bpremi[eè]re?\b|\berste[nrs]?\b|\bprim[oa]\b/i, 1],
  [/\b(second|2nd)\b|\bdoosr[aei]\b|\bdusr[aei]\b|\bdeuxi[eè]me\b|\bzweite[nrs]?\b|\bsecond[oa]\b/i, 2],
  [/\b(third|3rd)\b|\bteesr[aei]\b|\btisr[aei]\b|\btroisi[eè]me\b|\bdritte[nrs]?\b|\bterz[oa]\b/i, 3],
  [/\b(fourth|4th)\b|\bchauth[aei]\b/i, 4],
  [/\b(fifth|5th)\b/i, 5],
  [/\b(last|final)\b|\baakhri\b|\bdernier\b|\bletzte[nrs]?\b|\bultim[oa]\b/i, -1],
];

/**
 * "the second one", "show me the cheapest", "rooms at that hotel" → the item,
 * when results were shown in the last 30 minutes. Otherwise null.
 */
function resolveReference(message, lastResults, now = Date.now()) {
  if (!lastResults?.items?.length) return null;
  if (now - Date.parse(lastResults.at) > RESULTS_TTL_MS) return null;
  const m = String(message || '');
  const items = lastResults.items;
  // A number on its own like "no. 2" / "option 3" / "#2"
  const num = m.match(/(?:#|\bno\.?\s*|\bnumber\s+|\boption\s+)(\d)\b/i);
  if (num) return items[Number(num[1]) - 1] || null;
  for (const [re, n] of ORDINALS) if (re.test(m)) return n === -1 ? items[items.length - 1] : items[n - 1] || null;
  if (/\b(cheapest|lowest price|sabse sasta|moins cher|günstigste)\b/i.test(m)) {
    return items.filter((i) => i.price).sort((a, b) => a.price - b.price)[0] || null;
  }
  // A title mentioned by name ("the Raffles")
  const lower = m.toLowerCase();
  const byName = items.find((i) => i.title && i.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3).some((w) => lower.includes(w)));
  if (byName) return byName;
  if (/\b(that|this|it|its|the same) (one|hotel|trip|tour|transfer|option)\b|\bwahi\b|\busk[ai]\b/i.test(m) && items.length === 1) return items[0];
  return null;
}

/** Short lines for the prompt's memory section. */
function describe(slots = {}, now = Date.now()) {
  const lines = [];
  const known = Object.entries(slots).filter(([k]) => !['lastResults', 'island'].includes(k));
  if (known.length) lines.push(`Known trip details: ${known.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('; ')}`);
  const lr = slots.lastResults;
  if (lr && now - Date.parse(lr.at) <= RESULTS_TTL_MS) {
    lines.push(`Last shown (${lr.type}): ${lr.items.map((i) => `${i.n}. ${i.title}${i.price ? ` ${i.currency || ''} ${i.price}` : ''}`).join(' | ')}`);
  }
  return lines.join('\n');
}

module.exports = { clean, expire, resultsFrom, resolveReference, describe, islandSlug, RESULTS_TTL_MS };
