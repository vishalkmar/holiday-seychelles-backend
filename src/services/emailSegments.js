/**
 * Who a bulk email goes to.
 *
 * A segment is stored as a description, never as a list of addresses, and is
 * resolved at send time. A campaign scheduled for next Tuesday therefore
 * reaches the people who match next Tuesday — which is the whole point of an
 * occasion campaign, where "whose birthday is today" is only true on the day.
 *
 * Recipients come from two places and are merged by email address:
 *
 *   - `users`    — registered accounts
 *   - `bookings` — the lead guest on a booking, who very often never registered
 *
 * Leaving guests out would exclude most of this business's actual customers.
 */

const { pool } = require('../config/db');

const AUDIENCES = {
  all: 'Everyone we hold an address for',
  registered: 'Registered accounts only',
  guests: 'Guest checkouts with no account',
  booked: 'Has booked at least once (paid)',
  never_booked: 'Registered but never booked',
  upcoming: 'Has a trip coming up',
  past_guests: 'Has travelled with us already',
  abandoned: 'Started a checkout and never paid',
};

const OCCASIONS = {
  birthday: 'Birthday is today',
  anniversary: 'Anniversary is today',
};

function normalise(segment = {}) {
  return {
    audience: AUDIENCES[segment.audience] ? segment.audience : 'all',
    occasion: OCCASIONS[segment.occasion] ? segment.occasion : null,
    country: segment.country || null,
    status: segment.status || null,
    minSpend: Number(segment.minSpend) > 0 ? Number(segment.minSpend) : null,
    bookedSince: segment.bookedSince || null,
    emails: Array.isArray(segment.emails) ? segment.emails.filter(Boolean) : null,
  };
}

/** A human sentence describing the segment, shown next to the recipient count. */
function describe(segment) {
  const s = normalise(segment);
  if (s.emails?.length) return `${s.emails.length} address${s.emails.length === 1 ? '' : 'es'} entered by hand`;

  const parts = [AUDIENCES[s.audience]];
  if (s.occasion) parts.push(OCCASIONS[s.occasion].toLowerCase());
  if (s.country) parts.push(`in ${s.country}`);
  if (s.status) parts.push(`account ${s.status}`);
  if (s.minSpend) parts.push(`spent at least EUR ${s.minSpend}`);
  if (s.bookedSince) parts.push(`booked since ${s.bookedSince}`);
  return parts.join(' · ');
}

/**
 * Resolve a segment to its recipients.
 *
 * Marketing suppression is applied here with a LEFT JOIN rather than filtered
 * in JavaScript afterwards, so the count an operator is shown before sending is
 * the count that will actually be sent.
 */
async function resolveSegment(segment = {}, { limit = 5000 } = {}) {
  const s = normalise(segment);

  if (s.emails?.length) {
    const placeholders = s.emails.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `SELECT u.email,
              TRIM(CONCAT(COALESCE(u.first_middle_name, ''), ' ', COALESCE(u.last_name, ''))) AS name,
              u.id AS user_id
         FROM users u WHERE u.email IN (${placeholders})`,
      s.emails
    );
    const known = new Map(rows.map((r) => [r.email.toLowerCase(), r]));
    return s.emails.map((email) => {
      const hit = known.get(String(email).toLowerCase());
      return { email, name: hit?.name || null, user_id: hit?.user_id || null };
    });
  }

  const params = [];
  const p = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const userConditions = ['u.email IS NOT NULL', "u.email <> ''"];
  const guestConditions = ["b.lead_email IS NOT NULL", "b.lead_email <> ''"];

  if (s.status) userConditions.push(`u.status = ${p(s.status)}`);
  if (s.country) userConditions.push(`u.country = ${p(s.country)}`);

  if (s.occasion === 'birthday') {
    userConditions.push('DATE_FORMAT(u.date_of_birth, \'%m-%d\') = DATE_FORMAT(CURDATE(), \'%m-%d\')');
  }
  if (s.occasion === 'anniversary') {
    userConditions.push('DATE_FORMAT(u.anniversary, \'%m-%d\') = DATE_FORMAT(CURDATE(), \'%m-%d\')');
  }

  // The users source is ALWAYS included, even when the audience is "guests
  // only". It is what makes `registered` true for an address, and without it a
  // registered customer who booked would be counted as a guest - which is how
  // this first went wrong.
  const sources = [
    `
      SELECT u.email AS email,
             TRIM(CONCAT(COALESCE(u.first_middle_name, ''), ' ', COALESCE(u.last_name, ''))) AS name,
             u.id AS user_id
        FROM users u
       WHERE ${userConditions.join(' AND ')}`,
  ];

  // An occasion, an account status and a country only exist on a user record,
  // so once one of those is set the segment cannot contain a non-user address.
  const userOnly = Boolean(s.occasion || s.status || s.country);

  if (!userOnly && ['all', 'guests', 'booked', 'upcoming', 'past_guests'].includes(s.audience)) {
    sources.push(`
      SELECT b.lead_email AS email,
             TRIM(CONCAT(COALESCE(b.lead_first_name, ''), ' ', COALESCE(b.lead_last_name, ''))) AS name,
             NULL AS user_id
        FROM bookings b
       WHERE ${guestConditions.join(' AND ')}`);
  }

  // Someone who abandoned a checkout may never have booked and never have
  // registered, so their address exists only on the order.
  if (!userOnly && ['all', 'guests', 'abandoned'].includes(s.audience)) {
    sources.push(`
      SELECT o.lead_email AS email,
             TRIM(CONCAT(COALESCE(o.lead_first_name, ''), ' ', COALESCE(o.lead_last_name, ''))) AS name,
             NULL AS user_id
        FROM payment_orders o
       WHERE o.lead_email IS NOT NULL AND o.lead_email <> ''`);
  }

  // Booking-history filters are applied to the merged set, because a person's
  // history lives on bookings whether or not they ever created an account.
  const having = [];
  if (s.audience === 'booked') having.push('paid_bookings > 0');
  if (s.audience === 'never_booked') having.push('total_bookings = 0');
  if (s.audience === 'guests') having.push('registered = 0');
  if (s.audience === 'registered') having.push('registered = 1');
  if (s.audience === 'upcoming') having.push('upcoming_trips > 0');
  if (s.audience === 'past_guests') having.push('past_trips > 0');
  if (s.audience === 'abandoned') having.push('abandoned_orders > 0');
  if (s.minSpend) having.push(`lifetime_spend >= ${p(s.minSpend)}`);
  if (s.bookedSince) having.push(`last_booking_at >= ${p(s.bookedSince)}`);

  const sql = `
    SELECT c.email,
           MAX(c.name) AS name,
           MAX(c.user_id) AS user_id,
           MAX(CASE WHEN c.user_id IS NOT NULL THEN 1 ELSE 0 END) AS registered,
           COUNT(b.id) AS total_bookings,
           SUM(CASE WHEN b.payment_status = 'paid' THEN 1 ELSE 0 END) AS paid_bookings,
           COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0) AS lifetime_spend,
           SUM(CASE WHEN b.payment_status = 'paid'
                     AND COALESCE(b.check_in_date, b.travel_date) >= CURDATE() THEN 1 ELSE 0 END) AS upcoming_trips,
           SUM(CASE WHEN b.payment_status = 'paid'
                     AND COALESCE(b.check_out_date, b.check_in_date, b.travel_date) < CURDATE() THEN 1 ELSE 0 END) AS past_trips,
           MAX(b.created_at) AS last_booking_at,
           COALESCE(MAX(o.abandoned), 0) AS abandoned_orders
      FROM ( ${sources.join(' UNION ALL ')} ) AS c
      LEFT JOIN bookings b ON b.lead_email = c.email
      LEFT JOIN (
        SELECT lead_email, COUNT(*) AS abandoned
          FROM payment_orders
         WHERE status IN ('created', 'redirected')
         GROUP BY lead_email
      ) AS o ON o.lead_email = c.email
      LEFT JOIN email_unsubscribes un ON un.email = c.email
     WHERE un.id IS NULL
     GROUP BY c.email
     ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
     ORDER BY lifetime_spend DESC
     LIMIT ${Math.max(1, Math.min(Number(limit) || 5000, 20000))}`;

  const { rows } = await pool.query(sql, params);

  return rows.map((r) => ({
    email: r.email,
    name: r.name || null,
    user_id: r.user_id || null,
    bookings: Number(r.total_bookings || 0),
    lifetimeSpend: Number(r.lifetime_spend || 0),
  }));
}

module.exports = { AUDIENCES, OCCASIONS, normalise, describe, resolveSegment };
