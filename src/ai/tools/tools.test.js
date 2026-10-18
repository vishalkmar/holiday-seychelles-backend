const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./schema');
const { makeSupplier } = require('./supplier');
const hotels = require('./catalog/hotels');
const excursions = require('./catalog/excursions');
const transfers = require('./catalog/transfers');
const content = require('./catalog/content');
const site = require('./catalog/site');

// The catalog loads ports, which creates (but never uses) the MySQL pool.
after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

const tool = (list, name) => list.tools.find((t) => t.name === name);
const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/** A fake TourVisio: routes by path, records the bodies it was sent. */
function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    configured: () => true,
    async call(path, body) {
      calls.push({ path, body });
      const h = routes[path];
      if (!h) throw new Error(`unexpected ${path}`);
      const r = typeof h === 'function' ? h(body, calls) : h;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const ok = (body) => ({ ok: true, status: 200, data: { header: { success: true }, body }, messages: [] });
const fail = (code, message = code, status = 200) => ({ ok: false, status, data: { header: { success: false, messages: [{ code, message }] } }, messages: [{ code, message }] });

test('schema: defaults, required, enum, dates, coercion from a query string', () => {
  const s = { type: 'object', additionalProperties: false, required: ['d'], properties: { d: { type: 'string', format: 'date' }, n: { type: 'integer', minimum: 1, default: 2 }, a: { type: 'array', items: { type: 'integer' } }, e: { type: 'string', enum: ['x', 'y'] }, b: { type: 'boolean' } } };
  assert.deepEqual(validate({ d: '2026-11-10' }, s), { d: '2026-11-10', n: 2 });
  assert.throws(() => validate({}, s), /d: is required/);
  assert.throws(() => validate({ d: '10/11/2026' }, s), /YYYY-MM-DD/);
  assert.throws(() => validate({ d: '2026-11-10', e: 'z' }, s), /one of x, y/);
  assert.throws(() => validate({ d: '2026-11-10', hack: 1 }, s), /unknown field hack/);
  assert.throws(() => validate({ d: '2026-11-10', n: 0 }, s), /at least 1/);
  assert.deepEqual(validate({ d: '2026-11-10', n: '3', a: '5,9', b: 'true' }, s, { coerce: true }), { d: '2026-11-10', n: 3, a: [5, 9], b: true });
  assert.throws(() => validate({ d: '2026-11-10', n: '3' }, s), /must be a number/, 'no coercion for JSON callers');
});

test('supplier: connection failure → SUPPLIER_DOWN, PriceNotFound → empty, currency retried', async () => {
  const down = makeSupplier(fakeClient({ '/productservice/getdepartures': new Error('ECONNRESET') }));
  await assert.rejects(down.call('/productservice/getdepartures', {}), (e) => e.code === 'SUPPLIER_DOWN');
  const http5 = makeSupplier(fakeClient({ '/productservice/getdepartures': fail('X', 'boom', 503) }));
  await assert.rejects(http5.call('/productservice/getdepartures', {}), (e) => e.code === 'SUPPLIER_DOWN');
  const none = makeSupplier(fakeClient({ '/productservice/pricesearch': fail('PriceNotFound') }));
  assert.equal((await none.priceSearch({})).empty, true);
  const client = fakeClient({ '/productservice/pricesearch': (b) => (b.currency === 'USD' ? ok({ hotels: [] }) : fail('CurrencyNotFound')) });
  const cur = makeSupplier(client);
  assert.equal((await cur.priceSearch({})).currency, 'USD');
  assert.deepEqual(client.calls.map((c) => c.body.currency), ['EUR', 'USD']);
  const other = makeSupplier(fakeClient({ '/productservice/pricesearch': fail('InvalidLocation', 'Bad location') }));
  await assert.rejects(other.priceSearch({}), (e) => e.code === 'SUPPLIER_ERROR' && /Bad location/.test(e.message));
});

test('rooms: offers grouped to roomInfos by name tokens (roomId "0", no roomInfoId)', () => {
  const roomInfos = [
    { id: 'R1', name: 'Garden Villa', roomSize: '85,5', mediaFiles: [{ urlFull: 'g1.jpg' }, { urlFull: 'g2.jpg' }], bedOptions: ['1 KingBed'] },
    { id: 'R2', name: 'Ocean View Suite', mediaFiles: [{ urlFull: 'o1.jpg' }] },
  ];
  const offers = [
    { price: { amount: 900, currency: 'EUR' }, rooms: [{ roomId: '0', roomName: 'GARDEN VILLA, KING BED', boardName: 'BED AND BREAKFAST' }] },
    { price: { amount: 800, currency: 'EUR' }, rooms: [{ roomId: '0', roomName: 'Villa - Garden', boardName: 'HALF BOARD' }] },
    { price: { amount: 1500, currency: 'EUR' }, rooms: [{ roomId: '0', roomName: 'Ocean Views Suites' }] },
    { price: { amount: 400, currency: 'EUR' }, rooms: [{ roomId: '0', roomName: 'Standard Room' }] },
  ];
  const g = hotels.groupRooms(offers, roomInfos);
  assert.equal(g.length, 3);
  const villa = g.find((r) => r.name === 'Garden Villa');
  assert.equal(villa.fromPrice, 800);
  assert.equal(villa.sizeM2, 85.5);
  assert.equal(villa.photos, 2);
  assert.deepEqual(villa.beds, ['1 King Bed']);
  assert.deepEqual(villa.boards.sort(), ['Bed And Breakfast', 'Half Board']);
  assert.equal(g.find((r) => r.name === 'Ocean View Suite').image, 'o1.jpg');
  assert.equal(g[0].name, 'Standard Room', 'cheapest first; unmatched keeps its own group');
});

test('hotels.search: location resolved, fractional stars kept, price per night, filters, links', async () => {
  const client = fakeClient({
    '/productservice/getarrivalautocomplete': ok({ items: [{ type: 2, hotel: { id: 9 }, city: { id: 'H' } }, { type: 1, city: { id: '55', name: 'Praslin' } }] }),
    '/productservice/pricesearch': ok({
      searchId: 'S1',
      hotels: [
        { id: 1, name: 'CHEAP INN', stars: 3.5, provider: 2, offers: [{ offerId: 'o1', price: { amount: 300, currency: 'EUR' }, rooms: [{ boardName: 'ROOM ONLY', roomName: 'DOUBLE' }] }] },
        { id: 2, name: 'Grand Resort', stars: 5, offers: [{ offerId: 'o2', price: { amount: 1500, currency: 'EUR' } }, { offerId: 'o3', price: { amount: 1200, currency: 'EUR' } }] },
      ],
    }),
  });
  const run = (input) => tool(hotels, 'hotels.search').run(validate(input, tool(hotels, 'hotels.search').schema), { supplier: makeSupplier(client) });
  const r = await run({ destination: 'Praslin Island', checkIn: future(30), checkOut: future(33) });
  const ps = client.calls.find((c) => c.path === '/productservice/pricesearch').body;
  assert.deepEqual(ps.arrivalLocations, [{ id: '55', type: 2 }]);
  assert.equal(ps.night, 3);
  assert.equal(r.items[0].name, 'Cheap Inn');
  assert.equal(r.items[0].stars, 3.5);
  assert.equal(r.items[0].pricePerNight, 100);
  assert.equal(r.items[1].price, 1200, 'cheapest offer of a hotel');
  assert.match(r.items[1].url, /^\/hotel-details\?hotelid=2&provider=2&searchId=S1&offerId=o3/);
  assert.match(r.url, /^\/hotel-listing\?.*locationId=55/);
  assert.deepEqual((await run({ destination: 'Praslin', checkIn: future(30), checkOut: future(33), minStars: 4 })).items.map((h) => h.id), ['2']);
  assert.equal((await run({ destination: 'Praslin', checkIn: future(30), checkOut: future(30) })).error, 'BAD_DATES');
  assert.equal((await run({ destination: 'Praslin', checkIn: '2020-01-01', checkOut: '2020-01-03' })).error, 'PAST_DATE');
});

test('excursions.search: whole catalogue over 30 days, derived categories, island filter, next date', async () => {
  const d0 = future(5);
  const d1 = future(9);
  const client = fakeClient({
    '/productservice/getarrivalautocomplete': ok({ items: [{ type: 6, excursion: { id: 'E1', name: 'SUN CHASER' } }, { type: 6, excursion: { id: 'E2', name: 'X' } }, { type: 1, city: { id: 'c' } }] }),
    '/productservice/pricesearch': ok({
      excursions: [
        { id: 'E1', name: 'Sunset Catamaran Cruise (Sun Chaser)', offers: [{ checkIn: `${d1}T00:00:00`, price: { amount: 120, currency: 'EUR' }, city: { name: 'MAHE ISLAND' } }] },
        { id: 'E2', name: 'Vallée de Mai Nature Walk', offers: [{ checkIn: d0, price: { amount: 60, currency: 'EUR' }, city: { name: 'PRASLIN' } }, { checkIn: d1, price: { amount: 65 } }] },
      ],
    }),
  });
  const t = tool(excursions, 'excursions.search');
  const run = (input) => t.run(validate(input, t.schema), { supplier: makeSupplier(client) });
  const r = await run({ date: d0 });
  const ps = client.calls.find((c) => c.path === '/productservice/pricesearch').body;
  assert.deepEqual(ps.products, ['E1', 'E2'], 'every product, not a city search');
  assert.equal(ps.checkIn, d0);
  assert.equal(Date.parse(ps.checkInTo) - Date.parse(ps.checkIn), 30 * 86400000);
  assert.equal(r.items[0].name, 'Vallée de Mai Nature Walk', 'runs on the day → first');
  assert.equal(r.items[0].category, 'Nature & Hiking');
  assert.equal(r.items[1].category, 'Cruises & Boat Trips');
  assert.equal(r.items[1].runsOnDate, false);
  assert.equal(r.items[1].nextDate, d1);
  assert.deepEqual((await run({ date: d0, island: 'Praslin Island' })).items.map((e) => e.id), ['E2']);
  assert.deepEqual((await run({ date: d0, name: 'sun chaser' })).items.map((e) => e.id), ['E1']);
  assert.deepEqual((await run({ date: d0, category: 'cruise' })).items.map((e) => e.id), ['E1']);
  assert.equal(client.calls.filter((c) => c.path === '/productservice/pricesearch').length, 1, 'catalogue cached across filters');
});

test('transfers: arrivals from getarrivals for the departure; return trip falls back to swapped forward', async () => {
  const client = fakeClient({
    '/productservice/getarrivals': (b) => ok({ arrivals: b.departureLocations[0].id === '84' ? [{ id: '7', name: 'BEAU VALLON', type: 4 }, { id: '8', name: 'VICTORIA', type: 4 }] : [] }),
    '/productservice/pricesearch': (b) => (b.direction === '2' ? fail('PriceNotFound') : ok({ transfers: [{ name: 'Private car', offers: [{ price: { amount: 45, currency: 'EUR' }, maximumPax: 3 }] }] })),
  });
  const s = makeSupplier(client);
  const arr = tool(transfers, 'transfers.arrivals');
  const a = await arr.run(validate({ departureId: '84', query: 'vallon' }, arr.schema), { supplier: s });
  assert.deepEqual(a.items.map((x) => x.name), ['BEAU VALLON']);
  assert.deepEqual(client.calls[0].body.departureLocations, [{ id: '84', type: 4 }]);
  const srch = tool(transfers, 'transfers.search');
  const r = await srch.run(validate({ departureId: '84', arrivalId: '7', date: future(10), direction: '2' }, srch.schema), { supplier: s });
  assert.equal(r.swappedForReturn, true);
  assert.equal(r.items[0].price, 45);
  const last = client.calls[client.calls.length - 1].body;
  assert.deepEqual([last.departureLocations[0].id, last.arrivalLocations[0].id, last.direction, last.includeSubLocations], ['7', '84', '1', true]);
});

test('bookings.mine: needs a user, owner by id or booking email', async () => {
  const t = tool(content, 'bookings.mine');
  await assert.rejects(t.run({ upcomingOnly: false }, {}), (e) => e.code === 'LOGIN_REQUIRED');
  const seen = [];
  const db = {
    async query(sql, params) {
      seen.push({ sql, params });
      if (/FROM users/.test(sql)) return { rows: [{ email: 'a@b.c' }] };
      return { rows: [{ booking_reference: 'HS1', product_title: 'Villa', booking_type: 'hotel', check_in_date: '2026-12-01', payment_amount: '500.00', currency: 'EUR', status: 'confirmed', payment_status: 'paid', supplier_reference: 'TV9' }] };
    },
  };
  const r = await t.run({ upcomingOnly: true }, { userId: 7, deps: { db } });
  assert.match(seen[1].sql, /\(user_id = \$1 OR lead_email = \$2\)/);
  assert.deepEqual(seen[1].params, [7, 'a@b.c']);
  assert.deepEqual(r.items[0], { reference: 'HS1', product: 'Villa', type: 'hotel', checkIn: '2026-12-01', checkOut: null, amount: 500, currency: 'EUR', status: 'confirmed', paid: true, confirmed: true });
});

test('site.link: same URLs the website builds', async () => {
  assert.equal(site.links.island({ slug: 'la-digue' }), '/islands/la-digue');
  assert.equal(site.links.transfers({ fromId: '84', fromType: 4, toId: '7', toType: 4, checkIn: '2026-11-10' }), '/transfer-listing?fromId=84&fromType=4&toId=7&toType=4&checkIn=2026-11-10&checkOut=2026-11-10&adults=2&direction=1');
  assert.equal(site.links.excursions({ checkIn: '2026-11-10', filterId: 'E1' }), '/excursions?checkIn=2026-11-10&adults=2&filterId=E1');
  assert.equal((await site.tools[0].run({ page: 'dashboard', tab: 'trips' })).url, '/dashboard?tab=trips');
});
