/**
 * site.link — deep links into the website, where browsing, booking and payment
 * happen. The URLs mirror what the website's own search bars build, so a link
 * opens the same results the visitor would get by searching there.
 */

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

const links = {
  hotels: ({ location, locationId, checkIn, checkOut, rooms = 1, adults = 2, childAges = [], currency = 'EUR', hotelId }) =>
    `/hotel-listing?${qs({ location, locationId, hotelId, checkIn, checkOut, rooms, adults, children: childAges.length || 0, childAges: childAges.join(','), currency })}`,
  hotel: ({ hotelId, provider = 2, searchId, offerId, location, locationId, checkIn, checkOut, adults = 2, childAges = [] }) =>
    `/hotel-details?${qs({
      hotelid: hotelId,
      provider,
      searchId,
      offerId,
      query: checkIn ? JSON.stringify({ location, locationId, startDate: checkIn, endDate: checkOut, guests: [{ adults, children: childAges.length, childAges }], rooms: 1 }) : undefined,
    })}`,
  excursions: ({ checkIn, adults = 2, childAges = [], filterName, filterId, filterCategoryId, currency }) =>
    `/excursions?${qs({ checkIn, adults, childAges: childAges.join(','), filterName, filterId, filterCategoryId, currency })}`,
  transfers: ({ fromId, fromType, fromName, toId, toType, toName, checkIn, checkOut, adults = 2, direction = '1' }) =>
    `/transfer-listing?${qs({ fromId, fromType, fromName, toId, toType, toName, checkIn, checkOut: checkOut || checkIn, adults, direction })}`,
  island: ({ slug }) => `/islands/${encodeURIComponent(slug || '')}`,
  dashboard: ({ tab }) => `/dashboard${tab ? `?${qs({ tab })}` : ''}`,
  home: () => '/',
};

module.exports = {
  links,
  tools: [
    {
      name: 'site.link',
      title: 'Website link',
      description: 'Build a link to a page on the Holidays Seychelles website (hotel search, a hotel, excursions, transfers, an island page, or the customer dashboard), so the visitor can see live prices and book there.',
      permission: 'public',
      timeoutMs: 1000,
      cacheSec: 0,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['page'],
        properties: {
          page: { type: 'string', enum: Object.keys(links), description: 'Which page' },
          slug: { type: 'string', maxLength: 160, description: 'Island page slug (page=island)' },
          location: { type: 'string', maxLength: 120 },
          locationId: { type: 'string', maxLength: 40 },
          hotelId: { type: 'string', maxLength: 40 },
          checkIn: { type: 'string', format: 'date' },
          checkOut: { type: 'string', format: 'date' },
          adults: { type: 'integer', minimum: 1, maximum: 12 },
          childAges: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 17 }, maxItems: 6 },
          filterName: { type: 'string', maxLength: 120 },
          tab: { type: 'string', enum: ['trips', 'profile', 'queries', 'wishlist'] },
        },
      },
      async run(input) {
        return { url: links[input.page](input) };
      },
    },
  ],
};
