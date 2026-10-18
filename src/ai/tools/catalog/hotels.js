/**
 * hotels.search / hotels.details on server-side TourVisio, with the website's
 * lessons kept (DESIGN.md §3.5):
 *  - stars can be fractional (3.5) — passed through as a number, never used as a count
 *  - offer rooms carry roomId '0' and no roomInfoId, so they are grouped to
 *    roomInfos by name-token matching (same rule as the website's hotel.js)
 */

const { links } = require('./site');

// ── Room name matching (mirror of holidays-seychelles/src/api/routes/hotel.js) ──
const ROOM_STOP = new Set([
  'with', 'the', 'and', 'a', 'an', 'of', 'in', 'on', 'for', 'or', 'only',
  'room', 'rooms', 'bed', 'beds', 'king', 'queen', 'twin', 'double', 'single', 'kingbed',
  'private', 'included', 'include', 'includes', 'ferry', 'transfer', 'transfers',
  'nonrefundable', 'refundable', 'promo', 'offer', 'special', 'rate',
]);
const ROOM_ALIASES = [
  [/\b2\s*bed\s*rooms?\b|\b2\s*bedrooms?\b|\btwo\s*bedrooms\b/g, 'two bedroom'],
  [/\b3\s*bedrooms?\b|\bthree\s*bedrooms\b/g, 'three bedroom'],
  [/\b1\s*bedrooms?\b|\bone\s*bedrooms\b/g, 'one bedroom'],
  [/\bsanctury\b/g, 'sanctuary'],
  [/\bvillas\b/g, 'villa'],
  [/\bsuites\b/g, 'suite'],
  [/\bviews\b/g, 'view'],
];

function roomTokens(name) {
  let t = String(name || '').toLowerCase();
  ROOM_ALIASES.forEach(([re, to]) => { t = t.replace(re, to); });
  return [...new Set(t.replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !ROOM_STOP.has(w) && !/^\d+$/.test(w)))];
}

function bestRoomInfo(name, infoList) {
  const tokens = roomTokens(name);
  if (!tokens.length || !infoList.length) return null;
  let best = null;
  let bestScore = 0;
  infoList.forEach(({ ri, tokens: it }) => {
    if (!it.length) return;
    const shared = tokens.filter((w) => it.includes(w)).length;
    if (!shared) return;
    const score = shared / new Set([...tokens, ...it]).size + (shared === it.length ? 0.01 : 0);
    if (score > bestScore) { bestScore = score; best = ri; }
  });
  return bestScore >= 0.5 ? best : null;
}

const pretty = (n) => {
  const s = String(n || '').trim();
  return s && s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s;
};
const clip = (t, n) => {
  const s = String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const stars = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(7, Math.round(n * 2) / 2) : null;
};
const nightsBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const todayYmd = () => new Date().toISOString().slice(0, 10);

/** Group getoffers rooms into real room types (photos, size, beds, from-price). */
function groupRooms(offers = [], roomInfos = []) {
  const infoList = roomInfos.map((ri) => ({ ri, tokens: roomTokens(ri.name) }));
  const groups = new Map();
  for (const offer of offers) {
    const price = Number(offer.price?.amount || 0);
    for (const room of offer.rooms || []) {
      const rawName = String(room.roomName || room.accomName || 'Room').replace(/\s+/g, ' ').trim();
      const info =
        roomInfos.find((ri) => (room.roomInfoId && (ri.id === room.roomInfoId || ri.name === room.roomInfoId)) || (room.roomId && room.roomId !== '0' && ri.id === room.roomId)) ||
        bestRoomInfo(rawName, infoList);
      const key = info ? `info:${info.id}` : `name:${roomTokens(rawName).join(' ') || rawName.toLowerCase()}`;
      if (!groups.has(key)) {
        const size = Number(String(info?.roomSize || '').replace(',', '.'));
        const images = (info?.mediaFiles || []).map((m) => m.urlFull || m.urlBig || m.url).filter(Boolean);
        groups.set(key, {
          name: info?.name ? pretty(info.name) : pretty(rawName),
          sizeM2: size > 0 ? size : null,
          beds: (info?.bedOptions || []).map((b) => String(typeof b === 'string' ? b : b?.name || b?.description || '').replace(/([a-z])([A-Z])/g, '$1 $2').trim()).filter(Boolean),
          maxPersons: info?.maxPerson || info?.maxOccupancy || null,
          image: images[0] || null,
          photos: images.length,
          fromPrice: null,
          currency: offer.price?.currency || null,
          boards: new Set(),
          offers: 0,
          refundable: false,
        });
      }
      const g = groups.get(key);
      if (price > 0 && (g.fromPrice === null || price < g.fromPrice)) { g.fromPrice = price; g.currency = offer.price?.currency || g.currency; }
      if (room.boardName) g.boards.add(pretty(room.boardName));
      g.offers += 1;
      g.refundable = g.refundable || Boolean(offer.isRefundable);
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, boards: [...g.boards] }))
    .sort((a, b) => (a.fromPrice ?? Infinity) - (b.fromPrice ?? Infinity));
}

/** Island/city name → TourVisio location id, via hotel autocomplete (cached). */
const locationCache = new Map();
async function resolveLocation(supplier, name) {
  const key = name.toLowerCase();
  const hit = locationCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.loc;
  const query = name.replace(/\b(island|isl\.?)\b/gi, '').trim() || name;
  const r = await supplier.call('/productservice/getarrivalautocomplete', { ProductType: 2, Query: query, Culture: 'en-US' });
  const items = r.body.items || [];
  const city = items.find((i) => i.type !== 2 && i.city?.id) || items.find((i) => i.city?.id);
  const loc = city ? { id: String(city.city.id), name: city.city.name } : null;
  locationCache.set(key, { at: Date.now(), loc });
  return loc;
}

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['destination', 'checkIn', 'checkOut'],
  properties: {
    destination: { type: 'string', minLength: 2, maxLength: 80, description: 'Island or area, e.g. Mahé, Praslin, La Digue' },
    checkIn: { type: 'string', format: 'date' },
    checkOut: { type: 'string', format: 'date' },
    adults: { type: 'integer', minimum: 1, maximum: 8, default: 2 },
    childAges: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 17 }, maxItems: 4, default: [] },
    maxPrice: { type: 'number', minimum: 0, description: 'Total stay budget in the result currency' },
    minStars: { type: 'number', minimum: 1, maximum: 5 },
    sort: { type: 'string', enum: ['price', 'stars'], default: 'price' },
  },
};

module.exports = {
  roomTokens,
  bestRoomInfo,
  groupRooms,
  tools: [
    {
      name: 'hotels.search',
      title: 'Hotel search',
      description: 'Live hotel availability and prices for an island and dates (one room). Returns hotels with stars, board, the cheapest total price for the stay, and links to book on the website.',
      permission: 'public',
      timeoutMs: 45000, // TourVisio hotel searches take 15–40 s
      cacheSec: 180,
      maxResults: 8,
      schema: SEARCH_SCHEMA,
      async run(input, ctx) {
        const { destination, checkIn, checkOut, adults, childAges } = input;
        const nights = nightsBetween(checkIn, checkOut);
        if (checkIn < todayYmd()) return { error: 'PAST_DATE', message: 'Check-in is in the past.' };
        if (nights < 1 || nights > 30) return { error: 'BAD_DATES', message: 'Check-out must be 1–30 nights after check-in.' };
        const loc = await resolveLocation(ctx.supplier, destination);
        if (!loc) return { items: [], total: 0, message: `No hotel area found for “${destination}”.` };
        const r = await ctx.supplier.priceSearch({
          checkAllotment: true,
          checkStopSale: true,
          getOnlyDiscountedPrice: false,
          getOnlyBestOffers: true,
          productType: 2,
          arrivalLocations: [{ id: loc.id, type: 2 }],
          roomCriteria: [{ adult: adults, childAges }],
          nationality: 'SC',
          checkIn,
          night: nights,
          culture: 'en-US',
        });
        const listUrl = links.hotels({ location: loc.name, locationId: loc.id, checkIn, checkOut, adults, childAges, currency: r.currency });
        if (r.empty) return { items: [], total: 0, location: loc.name, nights, url: listUrl, message: 'No hotels available for these dates.' };
        let items = (r.body.hotels || []).map((h) => {
          const offer = (h.offers || []).slice().sort((a, b) => (a.price?.amount || 0) - (b.price?.amount || 0))[0] || {};
          const price = Number(offer.price?.amount || 0);
          return {
            id: String(h.id),
            name: pretty(h.name),
            stars: stars(h.stars),
            area: pretty(h.city?.name || h.location?.name || ''),
            price: price > 0 ? price : null,
            pricePerNight: price > 0 ? Math.round((price / nights) * 100) / 100 : null,
            currency: offer.price?.currency || r.currency,
            board: pretty(offer.rooms?.[0]?.boardName || h.boards?.[0]?.name || ''),
            room: pretty(offer.rooms?.[0]?.roomName || ''),
            refundable: Boolean(offer.isRefundable),
            thumbnail: h.thumbnailFull || h.thumbnail || null,
            url: links.hotel({ hotelId: h.id, provider: h.provider || 2, searchId: r.body.searchId, offerId: offer.offerId || offer.id, location: loc.name, locationId: loc.id, checkIn, checkOut, adults, childAges }),
          };
        });
        if (input.minStars) items = items.filter((h) => (h.stars || 0) >= input.minStars);
        if (input.maxPrice) items = items.filter((h) => h.price !== null && h.price <= input.maxPrice);
        items.sort(input.sort === 'stars' ? (a, b) => (b.stars || 0) - (a.stars || 0) || (a.price ?? Infinity) - (b.price ?? Infinity) : (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
        return { location: loc.name, checkIn, checkOut, nights, adults, children: childAges.length, currency: r.currency, total: items.length, items, url: listUrl };
      },
    },
    {
      name: 'hotels.details',
      title: 'Hotel details',
      description: 'One hotel: description, facilities, location and its room types (size, beds, photos). With searchId and offerId from hotels.search it also returns live prices per room type.',
      permission: 'public',
      timeoutMs: 25000,
      cacheSec: 300,
      maxResults: 12,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hotelId'],
        properties: {
          hotelId: { type: 'string', maxLength: 40 },
          provider: { type: 'integer', minimum: 0, maximum: 999, default: 2 },
          searchId: { type: 'string', maxLength: 200 },
          offerId: { type: 'string', maxLength: 400 },
        },
      },
      async run({ hotelId, provider, searchId, offerId }, ctx) {
        const info = await ctx.supplier.call('/productservice/getproductinfo', { productType: 2, ownerProvider: provider, product: hotelId, culture: 'en-US' });
        const h = info.body.hotel;
        if (!h) return { found: false, hotelId };
        const season = h.seasons?.[0] || {};
        const texts = season.textCategories || [];
        const textOf = (re) => {
          const c = texts.find((t) => re.test(t?.name || ''));
          return c ? (c.presentations || []).map((p) => p?.text).filter(Boolean).join(' ') : '';
        };
        const anyText = texts.find((t) => t.presentations?.some((p) => p.text && String(p.text).length > 10));
        let rooms = [];
        let live = false;
        if (searchId && offerId) {
          try {
            const o = await ctx.supplier.call('/productservice/getoffers', { searchId, offerId, productType: 2, productId: hotelId, culture: 'en-US', getRoomInfo: true });
            rooms = groupRooms(o.body.offers || [], o.body.roomInfos || []);
            live = rooms.length > 0;
          } catch (err) {
            if (err.code === 'SUPPLIER_DOWN') throw err;
            // An expired search: fall back to the product's room list below.
          }
        }
        if (!rooms.length) {
          rooms = (season.rooms || h.rooms || []).map((ri) => ({
            name: pretty(ri.name),
            sizeM2: Number(String(ri.roomSize || '').replace(',', '.')) || null,
            beds: (ri.bedOptions || []).map((b) => String(typeof b === 'string' ? b : b?.name || '')).filter(Boolean),
            maxPersons: ri.maxPerson || null,
            image: (ri.mediaFiles || [])[0]?.urlFull || null,
            photos: (ri.mediaFiles || []).length,
            fromPrice: null,
          }));
        }
        return {
          found: true,
          id: String(h.id || hotelId),
          name: pretty(h.name),
          stars: stars(h.stars),
          address: clip(h.address?.addressLines?.join(', ') || h.address || '', 200),
          area: pretty(h.city?.name || ''),
          description: clip(anyText ? anyText.presentations.map((p) => p.text).join(' ') : h.description, 900),
          location: clip(textOf(/location/i), 400),
          facilities: (season.facilityCategories || []).flatMap((c) => (c.facilities || []).map((f) => f.name)).filter(Boolean).slice(0, 25),
          photos: (season.mediaFiles || []).length,
          livePrices: live,
          rooms,
          url: links.hotel({ hotelId, provider, searchId, offerId }),
        };
      },
    },
  ],
};
