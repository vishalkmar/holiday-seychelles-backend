/**
 * Tools over the website's own data: island pages and the visitor's bookings.
 */

const { destinations, db } = require('../../ports');
const { ToolError } = require('../supplier');

const clip = (t, n) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const summary = (d) => ({ slug: d.slug, name: d.name, region: d.region || null, tagline: d.tagline || null, url: `/islands/${d.slug}` });

module.exports = {
  tools: [
    {
      name: 'destinations.list',
      title: 'Islands & places',
      description: 'List the islands, beaches and places that have a page on the website (name, region, short tagline, link).',
      permission: 'public',
      timeoutMs: 5000,
      cacheSec: 300,
      maxResults: 40,
      schema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', maxLength: 80, description: 'Optional name filter' } } },
      async run({ query }, ctx) {
        const all = await (ctx.deps?.destinations || destinations).list(false);
        const q = String(query || '').toLowerCase();
        const items = all.map(summary).filter((d) => !q || `${d.name} ${d.region}`.toLowerCase().includes(q));
        return { items, total: items.length };
      },
    },
    {
      name: 'destinations.get',
      title: 'Island page',
      description: 'The website page for one island or place: descriptions, best time, things to do, where to stay, food, tips.',
      permission: 'public',
      timeoutMs: 5000,
      cacheSec: 300,
      schema: { type: 'object', additionalProperties: false, required: ['slug'], properties: { slug: { type: 'string', maxLength: 160, description: 'Page slug, e.g. praslin' } } },
      async run({ slug }, ctx) {
        const d = await (ctx.deps?.destinations || destinations).get(slug);
        if (!d) return { found: false, slug };
        return {
          found: true,
          ...summary(d),
          shortDescription: clip(d.shortDescription, 400),
          description: clip(d.longDescription, 1200),
          bestTime: clip(d.bestTime, 400),
          thingsToDo: (d.thingsToDo || []).slice(0, 10).map((x) => clip(typeof x === 'string' ? x : x.title || x.name || x.text, 120)),
          whereToStay: (d.whereToStay || []).slice(0, 6).map((x) => ({ area: x.area, description: clip(x.description, 160) })),
          food: clip(d.food, 300),
          couples: clip(d.couples, 300),
        };
      },
    },
    {
      name: 'bookings.mine',
      title: 'My bookings',
      description: "The signed-in visitor's own bookings (upcoming and recent), with reference, product, dates and status. Only works when the visitor is logged in.",
      permission: 'user',
      minPermission: 'user',
      timeoutMs: 6000,
      cacheSec: 0,
      maxResults: 10,
      schema: { type: 'object', additionalProperties: false, properties: { upcomingOnly: { type: 'boolean', default: false } } },
      async run({ upcomingOnly }, ctx) {
        if (!ctx.userId) throw new ToolError('LOGIN_REQUIRED', 'Please log in to see your bookings.');
        const q = ctx.deps?.db || db;
        const { rows: u } = await q.query('SELECT email FROM users WHERE id = $1', [ctx.userId]);
        const email = u[0]?.email || null;
        // Owner by user id, or by the email they booked with (a checkout started before logging in is still theirs).
        const who = email ? '(user_id = $1 OR lead_email = $2)' : 'user_id = $1';
        const params = email ? [ctx.userId, email] : [ctx.userId];
        const { rows } = await q.query(
          `SELECT booking_reference, product_title, booking_type, check_in_date, check_out_date, travel_date,
                  payment_amount, currency, status, payment_status, supplier_reference
             FROM bookings WHERE ${who}
             ${upcomingOnly ? "AND DATE(COALESCE(check_in_date, travel_date)) >= CURDATE() AND status NOT IN ('cancelled', 'refunded')" : ''}
            ORDER BY COALESCE(check_in_date, travel_date) DESC LIMIT 20`,
          params
        );
        const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
        const items = rows.map((r) => ({
          reference: r.booking_reference,
          product: r.product_title,
          type: r.booking_type,
          checkIn: day(r.check_in_date || r.travel_date),
          checkOut: day(r.check_out_date),
          amount: Number(r.payment_amount || 0),
          currency: r.currency,
          status: r.status,
          paid: r.payment_status === 'paid',
          confirmed: Boolean(r.supplier_reference),
        }));
        return { items, total: items.length, url: '/dashboard?tab=trips' };
      },
    },
  ],
};
