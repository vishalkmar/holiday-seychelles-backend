/**
 * Product-name guard (extra track 1.3): hotels, excursions and transfers are
 * recommended only from our own live system. A sentence that names a hotel,
 * resort, tour operator or restaurant not found in this turn's tool results,
 * knowledge or the visitor's own words — or that sends the visitor to another
 * booking site — is removed before it reaches the visitor.
 */

// Other booking/review sites and search engines. A sentence that only says we
// don't use them ("I can't search booking.com…") is fine.
const SITES = /\b(booking\.com|expedia|airbnb|trip ?advisor|agoda|hotels\.com|trivago|kayak|get ?your ?guide|viator|klook|skyscanner|google)\b/i;
const NEGATION = /\b(not|n't|cannot|can't|only|instead|rather than|never|don't|doesn't)\b/i;

// Big hotel brands and well-known Seychelles resorts a model may "remember".
const BRANDS = [
  'four seasons', 'constance', 'hilton', 'raffles', 'kempinski', 'banyan tree', 'six senses', 'shangri-la', 'maia',
  'fregate island private', 'north island', 'savoy', 'le meridien', 'club med', 'anantara', 'waldorf astoria', 'ja enchanted',
  'paradise sun', 'lemuria', "l'archipel", 'denis private', 'carana', 'story seychelles', 'avani', 'mango house',
  'cheval blanc', 'zil pasyon', 'marriott', 'sheraton', 'hyatt', 'intercontinental', 'sofitel', 'novotel', 'radisson',
  'crowne plaza', 'st regis', 'ritz-carlton', 'mandarin oriental', 'one&only', 'anse chastanet', 'coral strand', 'berjaya',
  'kempinski', 'cerf island resort', 'h resort', 'hotel l\'archipel', 'domaine de la reserve', 'le domaine de l\'orangeraie',
];

// "Something Something Resort", "X Diving Centre", "Y Restaurant": title-case words before a product word.
const TYPE = "(?:Hotel|Hotels|Resort|Resorts|Lodge|Villas?|Residence|Residences|Guest ?House|Guesthouse|Chalets?|Apartments?|Spa|Retreat|Beach Club|Tours|Charters?|Divers|Dive Cent(?:er|re)|Diving Cent(?:er|re)|Boat Trips|Cruises|Restaurant|Café|Cafe|Bistro|Bar|Grill)";
const WORD = "[A-ZÀ-Ý][\\wÀ-ÿ'’&.-]*";
const NAMED = new RegExp(`(${WORD}(?:\\s+(?:${WORD}|de|du|la|le|les|of|d'|&))*)\\s+${TYPE}\\b`, 'g');
// Words that alone don't make a name: places, generic adjectives, our own name.
const GENERIC = /^(the|a|an|our|your|their|this|that|these|those|best|top|good|great|luxury|luxurious|cheap|budget|family|beach|island|islands|seychelles|holidays|mah[eé]|praslin|la|digue|silhouette|victoria|eden|sainte|anne|curieuse|private|small|local|boutique|live|many|some|several|other|all|any|which|what|most|five|four|three|5-star|4-star|3-star|star|new|popular|romantic|and|or|of|de|le|les|du|d'|&|in|on|at|for|with|from)$/i;

// Accents and the hyphen variants models use ("Semi‑Submarine") don't stop a match.
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‐-―−]/g, '-').toLowerCase().replace(/[’']/g, "'");

/** Sentences with their trailing space; a dot inside "booking.com" or "e.g." doesn't end one. */
function sentences(text) {
  const parts = String(text || '').split(/((?<=[.!?])\s+|\n+)/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) if (parts[i] || parts[i + 1]) out.push(parts[i] + (parts[i + 1] || ''));
  return out;
}

const BRAND_RES = BRANDS.map((b) => [b, new RegExp(`(^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`)]);
const brandsIn = (text) => { const f = fold(text); return BRAND_RES.filter(([, re]) => re.test(f)).map(([b]) => b); };

/** Names in a sentence that would need evidence. */
function namesIn(sentence) {
  const found = [];
  for (const m of sentence.matchAll(NAMED)) {
    const words = m[1].split(/\s+/).filter((w) => !GENERIC.test(w.replace(/[.,]$/, '')));
    if (words.length) found.push(m[0].trim());
  }
  return found.concat(brandsIn(sentence));
}

/**
 * known: evidence text (tool results JSON, knowledge, the visitor's message).
 * → { text, removed: [{ kind: 'name'|'site', value }] }
 */
function guardNames(text, known = '') {
  const evidence = fold(known);
  const removed = [];
  const kept = [];
  for (const s of sentences(text)) {
    const site = s.match(SITES);
    if (site && !NEGATION.test(s)) {
      removed.push({ kind: 'site', value: site[0] });
      continue;
    }
    const unknown = namesIn(s).filter((n) => {
      const key = fold(n).replace(/\s+(hotels?|resorts?|lodge|villas?|residences?|guest ?house|guesthouse|chalets?|apartments?|spa|retreat|beach club|tours|charters?|divers|(dive|diving) cent(er|re)|boat trips|cruises|restaurant|cafe|bistro|bar|grill)$/, '');
      return !(evidence.includes(fold(n)) || (key.length >= 4 && evidence.includes(key)));
    });
    if (unknown.length) {
      removed.push({ kind: 'name', value: unknown[0] });
      continue;
    }
    kept.push(s);
  }
  return { text: kept.join('').replace(/\s{2,}/g, ' ').trim(), removed };
}

/** A hotel brand or resort name in the visitor's message ("Is Four Seasons better than…"). */
const hasBrand = (text) => brandsIn(text).length > 0;

module.exports = { guardNames, namesIn, hasBrand, SITES };
