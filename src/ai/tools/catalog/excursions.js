/**
 * excursions.search on server-side TourVisio, with the website's lessons kept:
 *  - excursions run on particular days, so the whole catalogue is priced over a
 *    30-day window (a single-day search found 32 of 81 and missed some on every day)
 *  - city search answers PriceNotFound, so the island filter is applied here
 *  - TourVisio has no categories; they are derived from the name (same list as
 *    the website's EXCURSION_CATEGORIES)
 */

const { links } = require('./site');

const WINDOW_DAYS = 30;

const CATEGORIES = [
  { id: 'adventure', name: 'Water & Adventure', test: /jet ?ski|kayak|paddle|pedallo|banana boat|parachute|parasail|zip ?lin|sky ?diving|belly board|surf\b(?! &)|quad|segway/i },
  { id: 'fishing', name: 'Fishing', test: /fishing|angling/i },
  { id: 'diving', name: 'Diving', test: /diving|\bdive\b|scuba/i },
  { id: 'cruise', name: 'Cruises & Boat Trips', test: /cruise|catamaran|yacht|semi[- ]?submarine|\bsail|glass[- ]?bottom/i },
  { id: 'islands', name: 'Island Hopping', test: /islands\b|island hopping/i },
  { id: 'marine', name: 'Marine Parks & Snorkelling', test: /snorkel|marine park/i },
  { id: 'nature', name: 'Nature & Hiking', test: /hike|hiking|trail|nature|garden|vall[eé]e|reserve|forest|mountain|morne|bird|tortoise|national park/i },
  { id: 'culture', name: 'Culture & Sightseeing', test: /sightseeing|creole|culture|moutya|cooking|food|rum|tea|market|heritage|craft|museum|distill/i },
  { id: 'tours', name: 'Island Tours', test: /tour|day trip|boat & bike|wild south|discover|safari|bike|cycling|jeep/i },
];
const OTHER = { id: 'other', name: 'Other Experiences' };
const categorize = (name) => CATEGORIES.find((c) => c.test.test(name || '')) || OTHER;

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));
const pretty = (n) => {
  const s = String(n || '').trim();
  return s && s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s;
};
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const catalogCache = new Map();
async function catalogue(supplier, { from, adults, childAges }) {
  const key = JSON.stringify([from, adults, childAges]);
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.value;
  const ac = await supplier.call('/productservice/getarrivalautocomplete', { productType: 4, query: '', culture: 'en-US' });
  const products = (ac.body.items || []).filter((i) => i.type === 6 && i.excursion?.id).map((i) => String(i.excursion.id));
  if (!products.length) return { list: [], currency: null, total: 0 };
  const to = addDays(from, WINDOW_DAYS);
  const r = await supplier.priceSearch({ productType: 4, culture: 'en-US', getOnlyBestOffers: true, nationality: 'SC', adult: adults, childAges, checkIn: from, checkInTo: to, products });
  const raw = r.empty ? [] : r.body.excursions || r.body.hotels || r.body.items || [];
  const list = raw
    .map((e) => {
      const offers = (e.offers || [])
        .filter((o) => o && o.isAvailable !== false && o.availability !== 0 && o.checkIn)
        .map((o) => ({ date: String(o.checkIn).slice(0, 10), price: Number(o.price?.amount || 0), currency: o.price?.currency || r.currency, city: o.city, refundable: Boolean(o.isRefundable) }))
        .sort((a, b) => a.date.localeCompare(b.date));
      if (!offers.length) return null;
      const cat = categorize(e.name);
      const city = offers.find((o) => o.city?.name)?.city || {};
      const prices = offers.map((o) => o.price).filter((p) => p > 0);
      return {
        id: String(e.id || e.code || ''),
        name: pretty(e.name),
        category: cat.name,
        categoryId: cat.id,
        island: pretty(city.name),
        fromPrice: prices.length ? Math.min(...prices) : null,
        currency: offers[0].currency,
        dates: offers.map((o) => o.date),
        offers,
        thumbnail: e.thumbnailFull || e.thumbnail || null,
        description: String(e.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    })
    .filter(Boolean);
  const value = { list, currency: r.currency, total: products.length, windowTo: to };
  catalogCache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = {
  categorize,
  CATEGORIES: [...CATEGORIES, OTHER].map(({ id, name }) => ({ id, name })),
  tools: [
    {
      name: 'excursions.search',
      title: 'Excursion search',
      description: 'Live excursions and tours (boat trips, snorkelling, diving, island tours, nature walks…) with prices per person and the dates they run in the next 30 days from the chosen date. Filter by name, category or island.',
      permission: 'public',
      timeoutMs: 40000,
      cacheSec: 300,
      maxResults: 10,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', format: 'date', description: 'Preferred day; defaults to today' },
          adults: { type: 'integer', minimum: 1, maximum: 12, default: 2 },
          childAges: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 17 }, maxItems: 6, default: [] },
          name: { type: 'string', maxLength: 80, description: 'Words from the excursion name, e.g. "Sun Chaser" or "catamaran"' },
          category: { type: 'string', enum: [...CATEGORIES.map((c) => c.id), OTHER.id] },
          island: { type: 'string', maxLength: 60, description: 'e.g. Mahé, Praslin, La Digue' },
          maxPrice: { type: 'number', minimum: 0 },
        },
      },
      async run(input, ctx) {
        const today = ymd(new Date());
        const from = input.date && input.date > today ? input.date : today;
        const cat = await catalogue(ctx.supplier, { from, adults: input.adults, childAges: input.childAges });
        let items = cat.list;
        if (input.name) {
          const words = fold(input.name).split(/\s+/).filter(Boolean);
          items = items.filter((e) => words.every((w) => fold(`${e.name} ${e.description}`).includes(w)));
        }
        if (input.category) items = items.filter((e) => e.categoryId === input.category);
        if (input.island) {
          const want = fold(input.island).replace(/-/g, ' ').replace(/\s*island$/, '');
          items = items.filter((e) => fold(e.island).includes(want));
        }
        if (input.maxPrice) items = items.filter((e) => e.fromPrice !== null && e.fromPrice <= input.maxPrice);
        const out = items
          .map((e) => {
            const onDay = e.offers.find((o) => o.date === from);
            const next = onDay || e.offers[0];
            return {
              id: e.id,
              name: e.name,
              category: e.category,
              island: e.island || null,
              price: next.price || e.fromPrice,
              currency: e.currency,
              priceNote: 'total for the group searched',
              runsOnDate: Boolean(onDay),
              nextDate: next.date,
              upcomingDates: e.dates.slice(0, 6),
              refundable: next.refundable,
              description: e.description,
              thumbnail: e.thumbnail,
              url: links.excursions({ checkIn: next.date, adults: input.adults, childAges: input.childAges, filterId: e.id, currency: e.currency }),
            };
          })
          .sort((a, b) => Number(b.runsOnDate) - Number(a.runsOnDate) || a.nextDate.localeCompare(b.nextDate) || (a.price || 0) - (b.price || 0));
        return {
          from,
          to: cat.windowTo || null,
          total: out.length,
          items: out,
          categories: module.exports.CATEGORIES,
          url: links.excursions({ checkIn: from, adults: input.adults, childAges: input.childAges, filterName: input.name, filterCategoryId: input.category }),
        };
      },
    },
  ],
};
