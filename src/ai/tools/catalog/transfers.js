/**
 * Transfers on server-side TourVisio, with the website's lessons kept:
 *  - arrivals come only from getarrivals for the chosen departure (free-text
 *    arrival autocomplete returns places with no transfer → "Price not found")
 *  - pricesearch needs includeSubLocations:true, direction as a string
 *  - a return trip falls back to the forward product with the ends swapped
 */

const { links } = require('./site');

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function listOf(body, keys) {
  for (const k of keys) if (Array.isArray(body?.[k]) && body[k].length) return body[k];
  return Array.isArray(body) ? body : [];
}
const place = (l) => ({
  id: String(l.id ?? l.Id ?? l.locationId ?? ''),
  name: l.name ?? l.Name ?? l.locationName ?? '',
  type: Number(l.type ?? l.Type ?? l.locationType ?? 0),
  parentId: l.parentId != null ? String(l.parentId) : null,
});
// Airports and jetties are where most transfers start: list them first.
const HUB = /airport|jetty|harbour|harbor/i;
function filterPlaces(items, query, max) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hits = (words.length ? items.filter((l) => words.every((w) => fold(l.name).includes(w))) : items.slice())
    .sort((a, b) => Number(HUB.test(b.name)) - Number(HUB.test(a.name)));
  return { items: hits.slice(0, max), total: hits.length };
}

const DIRECTION = { type: 'string', enum: ['1', '2'], default: '1', description: '1 = one way (e.g. airport → hotel), 2 = the way back' };

function shapeTransfer(t, currency) {
  const offer = (t.offers || [])[0] || {};
  const raw = offer.price ?? t.price ?? 0;
  const price = typeof raw === 'object' ? Number(raw.amount ?? 0) : Number(raw);
  return {
    name: t.name || t.transferName || t.type?.name || 'Transfer',
    vehicle: t.type?.name || t.transferType?.name || t.code || null,
    maxPax: Number(offer.maximumPax || offer.maxPax || 0) || null,
    price: price > 0 ? price : null,
    currency: (typeof raw === 'object' && raw.currency) || currency,
    refundable: Boolean(offer.isRefundable || t.isRefundable),
    duration: t.duration || offer.duration || null,
    from: (offer.departure || t.departure || {}).name || null,
    to: (offer.arrival || t.arrival || {}).name || null,
  };
}

module.exports = {
  tools: [
    {
      name: 'transfers.departures',
      title: 'Transfer pick-up points',
      description: 'Places a transfer can start from (airport, jetties, hotels). Use the id and type with transfers.arrivals.',
      permission: 'public',
      timeoutMs: 15000,
      cacheSec: 300,
      maxResults: 30,
      schema: { type: 'object', additionalProperties: false, properties: { direction: DIRECTION, query: { type: 'string', maxLength: 80, description: 'Filter by name, e.g. airport' } } },
      async run({ direction, query }, ctx) {
        const r = await ctx.supplier.call('/productservice/getdepartures', { productType: 5, direction });
        const all = listOf(r.body, ['departures', 'Departures', 'locations', 'Locations']).map(place).filter((l) => l.id && l.name);
        return filterPlaces(all, query, 200);
      },
    },
    {
      name: 'transfers.arrivals',
      title: 'Transfer drop-off points',
      description: 'Where a transfer can go from one departure point (only places with a real transfer). Filter by name, e.g. a hotel.',
      permission: 'public',
      timeoutMs: 15000,
      cacheSec: 300,
      maxResults: 30,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['departureId'],
        properties: {
          departureId: { type: 'string', maxLength: 40 },
          departureType: { type: 'integer', minimum: 0, maximum: 20, default: 4 },
          direction: DIRECTION,
          query: { type: 'string', maxLength: 80 },
        },
      },
      async run({ departureId, departureType, direction, query }, ctx) {
        const r = await ctx.supplier.call('/productservice/getarrivals', { productType: 5, direction, departureLocations: [{ id: departureId, type: departureType }] });
        const all = listOf(r.body, ['arrivals', 'Arrivals', 'locations', 'Locations']).map(place).filter((l) => l.id && l.name);
        return filterPlaces(all, query, 200);
      },
    },
    {
      name: 'transfers.search',
      title: 'Transfer prices',
      description: 'Live transfer options and prices between a departure and an arrival (ids from transfers.departures / transfers.arrivals) on a date.',
      permission: 'public',
      timeoutMs: 30000,
      cacheSec: 180,
      maxResults: 8,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['departureId', 'arrivalId', 'date'],
        properties: {
          departureId: { type: 'string', maxLength: 40 },
          departureType: { type: 'integer', minimum: 0, maximum: 20, default: 4 },
          departureName: { type: 'string', maxLength: 120 },
          arrivalId: { type: 'string', maxLength: 40 },
          arrivalType: { type: 'integer', minimum: 0, maximum: 20, default: 2 },
          arrivalName: { type: 'string', maxLength: 120 },
          date: { type: 'string', format: 'date' },
          adults: { type: 'integer', minimum: 1, maximum: 20, default: 2 },
          childAges: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 17 }, maxItems: 8, default: [] },
          direction: DIRECTION,
        },
      },
      async run(input, ctx) {
        const body = (dep, arr, direction) => ({
          productType: 5,
          culture: 'en-US',
          direction,
          departureLocations: [dep],
          arrivalLocations: [arr],
          checkIn: input.date,
          checkOut: input.date,
          adult: input.adults,
          childAges: input.childAges,
          includeSubLocations: true,
          additionalParameters: { getCountry: false, getTransferLocation: true },
        });
        const dep = { id: input.departureId, type: input.departureType };
        const arr = { id: input.arrivalId, type: input.arrivalType };
        let r = await ctx.supplier.priceSearch(body(dep, arr, input.direction));
        let swapped = false;
        if (input.direction === '2' && (r.empty || !(r.body.transfers || r.body.items || []).length)) {
          r = await ctx.supplier.priceSearch(body(arr, dep, '1'));
          swapped = true;
        }
        const raw = r.empty ? [] : r.body.transfers || r.body.transferList || r.body.items || [];
        const items = raw.map((t) => shapeTransfer(t, r.currency)).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
        return {
          date: input.date,
          adults: input.adults,
          total: items.length,
          items,
          swappedForReturn: swapped,
          message: items.length ? undefined : 'No transfer is available between these points on that date.',
          url: links.transfers({ fromId: input.departureId, fromType: input.departureType, fromName: input.departureName, toId: input.arrivalId, toType: input.arrivalType, toName: input.arrivalName, checkIn: input.date, adults: input.adults, direction: input.direction }),
        };
      },
    },
  ],
};
