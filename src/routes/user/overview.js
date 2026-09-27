/**
 * Everything the dashboard home screen needs, in one round trip.
 *
 * The figures are deliberately computed here rather than derived in the browser
 * from a list: the dashboard shows lifetime totals, and shipping every booking
 * to the client just to count them would get slower every year.
 */

const express = require('express');
const { pool } = require('../../config/db');
const userAuth = require('../../middleware/userAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const { runLimited } = require('../../utils/concurrency');

const router = express.Router();

/**
 * Orders and bookings belong to the user by id, or by the email they booked
 * with - a checkout started before logging in is still theirs.
 */
async function owner(userId) {
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = rows[0]?.email || null;
  return {
    orders: email
      ? { sql: '(user_id = $1 OR lead_email = $2)', params: [userId, email] }
      : { sql: 'user_id = $1', params: [userId] },
    bookings: email
      ? { sql: '(user_id = $1 OR lead_email = $2)', params: [userId, email] }
      : { sql: 'user_id = $1', params: [userId] },
  };
}

router.get('/', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;
    const scope = await owner(userId);
    const p = scope.orders.params;

    const [
      orderStats,
      bookingStats,
      upcoming,
      recentOrders,
      recentBookings,
      monthly,
      queries,
      travelled,
      momCounts,
      queryCounts,
      profileRow,
      // Bounded, not Promise.all: this host times out when asked for a burst of
      // new connections, and ten at once against a six-connection pool is how
      // the admin analytics screens used to fail.
    ] = await runLimited([
        () => pool.query(
          `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
             FROM payment_orders WHERE ${scope.orders.sql} GROUP BY status`,
          p
        ),
        () => pool.query(
          `SELECT status, payment_status, COUNT(*) AS count,
                  COALESCE(SUM(payment_amount), 0) AS total,
                  COALESCE(SUM(refund_amount), 0) AS refunded
             FROM bookings WHERE ${scope.bookings.sql}
            GROUP BY status, payment_status`,
          p
        ),
        () => pool.query(
          `SELECT id, booking_reference, product_title, booking_type, check_in_date,
                  check_out_date, travel_date, payment_amount, currency, status,
                  supplier_reference, supplier_status
             FROM bookings
            WHERE ${scope.bookings.sql}
              AND payment_status = 'paid'
              AND status NOT IN ('cancelled', 'refunded')
              AND DATE(COALESCE(check_in_date, travel_date)) >= CURDATE()
            ORDER BY COALESCE(check_in_date, travel_date) ASC
            LIMIT 5`,
          p
        ),
        () => pool.query(
          `SELECT order_reference, status, amount, currency, product_title,
                  booking_type, created_at, gateway_reference, booking_id
             FROM payment_orders WHERE ${scope.orders.sql}
            ORDER BY created_at DESC LIMIT 5`,
          p
        ),
        () => pool.query(
          `SELECT booking_reference, product_title, booking_type, payment_amount,
                  currency, status, created_at, check_in_date
             FROM bookings WHERE ${scope.bookings.sql}
            ORDER BY created_at DESC LIMIT 5`,
          p
        ),
        // Twelve-month spend trend for the chart.
        () => pool.query(
          `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
                  COUNT(*) AS bookings,
                  COALESCE(SUM(payment_amount), 0) AS total
             FROM bookings
            WHERE ${scope.bookings.sql}
              AND payment_status = 'paid'
              AND created_at >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
            GROUP BY month ORDER BY month ASC`,
          p
        ),
        () => pool.query(
          `SELECT status, COUNT(*) AS count FROM queries WHERE user_id = $1 GROUP BY status`,
          [userId]
        ),
        // Trips already taken: paid, not cancelled, and the stay has ended.
        () => pool.query(
          `SELECT COUNT(*) AS total FROM bookings
            WHERE ${scope.bookings.sql}
              AND payment_status = 'paid'
              AND status NOT IN ('cancelled', 'refunded')
              AND COALESCE(check_out_date, check_in_date, travel_date) < CURDATE()`,
          p
        ),
        // This month against last month, so the dashboard's change badges are a
        // measurement rather than a decoration. A month with nothing before it
        // has no percentage, and the UI says "no history" instead of inventing one.
        () => pool.query(
          `SELECT
             SUM(CASE WHEN created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN 1 ELSE 0 END) AS bookings_this,
             SUM(CASE WHEN created_at >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')
                       AND created_at <  DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN 1 ELSE 0 END) AS bookings_last,
             -- Trips that FINISHED in each month, which is a flow and so can be
             -- compared. "Upcoming" is a state at a point in time and cannot,
             -- so no month-over-month figure is produced for it.
             SUM(CASE WHEN payment_status = 'paid' AND status NOT IN ('cancelled','refunded')
                       AND COALESCE(check_out_date, check_in_date, travel_date) >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                       AND COALESCE(check_out_date, check_in_date, travel_date) < CURDATE()
                      THEN 1 ELSE 0 END) AS completed_this,
             SUM(CASE WHEN payment_status = 'paid' AND status NOT IN ('cancelled','refunded')
                       AND COALESCE(check_out_date, check_in_date, travel_date) >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')
                       AND COALESCE(check_out_date, check_in_date, travel_date) < DATE_FORMAT(CURDATE(), '%Y-%m-01')
                      THEN 1 ELSE 0 END) AS completed_last
           FROM bookings WHERE ${scope.bookings.sql}`,
          p
        ),
        () => pool.query(
          `SELECT
             SUM(CASE WHEN created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN 1 ELSE 0 END) AS queries_this,
             SUM(CASE WHEN created_at >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')
                       AND created_at <  DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN 1 ELSE 0 END) AS queries_last
           FROM queries WHERE user_id = $1`,
          [userId]
        ),
        () => pool.query(
          `SELECT first_middle_name, last_name, email, mobile_number, mobile_country_code,
                  country, date_of_birth, nationality, passport_no, passport_expiry,
                  city_of_residence, profile_image
             FROM users WHERE id = $1`,
          [userId]
        ),
      ]);

    // ── Transaction buckets, same mapping the Transactions tab uses ──────────
    const buckets = { completed: 0, pending: 0, cancelled: 0 };
    let totalSpent = 0;
    let pendingValue = 0;

    for (const row of orderStats.rows) {
      const count = Number(row.count);
      const total = Number(row.total);
      if (row.status === 'paid') {
        buckets.completed += count;
        totalSpent += total;
      } else if (['created', 'redirected'].includes(row.status)) {
        buckets.pending += count;
        pendingValue += total;
      } else {
        buckets.cancelled += count;
      }
    }

    // ── Booking states ───────────────────────────────────────────────────────
    const bookings = { total: 0, confirmed: 0, pendingSupplier: 0, cancelled: 0, refunded: 0 };
    let refundedValue = 0;

    for (const row of bookingStats.rows) {
      const count = Number(row.count);
      bookings.total += count;
      refundedValue += Number(row.refunded || 0);
      if (row.status === 'cancelled') bookings.cancelled += count;
      else if (row.status === 'refunded') bookings.refunded += count;
      else if (row.status === 'pending_supplier') bookings.pendingSupplier += count;
      else bookings.confirmed += count;
    }

    const openQueries = queries.rows
      .filter((q) => q.status !== 'closed')
      .reduce((sum, q) => sum + Number(q.count), 0);

    // ── Profile completeness ────────────────────────────────────────────────
    // A named checklist rather than a bare number, so "88%" is something the
    // customer can act on instead of a score they cannot move.
    const u = profileRow.rows[0] || {};
    const CHECKLIST = [
      {
        key: 'contact',
        label: 'Complete contact and travel details',
        done: Boolean(u.first_middle_name && u.last_name && u.mobile_number && u.country),
      },
      {
        key: 'passport',
        label: 'Add passport details for faster booking',
        done: Boolean(u.passport_no && u.passport_expiry && u.nationality),
      },
      {
        key: 'personal',
        label: 'Keep your profile updated for better offers',
        done: Boolean(u.date_of_birth && u.city_of_residence),
      },
    ];
    const fields = [
      u.first_middle_name, u.last_name, u.email, u.mobile_number, u.country,
      u.date_of_birth, u.nationality, u.passport_no, u.passport_expiry, u.city_of_residence,
    ];
    const filled = fields.filter((f) => f !== null && f !== undefined && String(f).trim() !== '').length;

    // ── Month over month ────────────────────────────────────────────────────
    // A percentage needs something to divide by. With no previous month there
    // is no change to report, and `null` is how the dashboard is told to say
    // "no history yet" instead of printing a number nobody can justify.
    const change = (now, before) => ({
      thisMonth: now,
      lastMonth: before,
      delta: before > 0 ? Number((((now - before) / before) * 100).toFixed(0)) : null,
    });

    const m = momCounts.rows[0] || {};
    const q = queryCounts.rows[0] || {};
    const momentum = {
      bookings: change(Number(m.bookings_this || 0), Number(m.bookings_last || 0)),
      completed: change(Number(m.completed_this || 0), Number(m.completed_last || 0)),
      queries: change(Number(q.queries_this || 0), Number(q.queries_last || 0)),
    };

    const nextTrip = upcoming.rows[0] || null;
    const daysToNextTrip = nextTrip
      ? Math.ceil(
          (new Date(nextTrip.check_in_date || nextTrip.travel_date).setHours(0, 0, 0, 0) -
            new Date().setHours(0, 0, 0, 0)) /
            86400000
        )
      : null;

    sendSuccess(
      res,
      {
        currency: recentOrders.rows[0]?.currency || 'EUR',
        stats: {
          totalSpent: Number(totalSpent.toFixed(2)),
          pendingValue: Number(pendingValue.toFixed(2)),
          refundedValue: Number(refundedValue.toFixed(2)),
          transactions: { ...buckets, all: buckets.completed + buckets.pending + buckets.cancelled },
          bookings,
          upcomingCount: upcoming.rows.length,
          completedTrips: Number(travelled.rows[0]?.total || 0),
          openQueries,
          averageBooking:
            buckets.completed > 0 ? Number((totalSpent / buckets.completed).toFixed(2)) : 0,
        },
        // `delta` is null when there is no previous month to compare against.
        // The dashboard shows "no history yet" rather than a made-up percentage.
        momentum,
        profile: {
          name: [u.first_middle_name, u.last_name].filter(Boolean).join(' ').trim() || null,
          email: u.email || null,
          mobile: [u.mobile_country_code, u.mobile_number].filter(Boolean).join(' ').trim() || null,
          country: u.country || null,
          image: u.profile_image || null,
          completion: Math.round((filled / fields.length) * 100),
          checklist: CHECKLIST,
        },
        nextTrip: nextTrip ? { ...nextTrip, daysToGo: daysToNextTrip } : null,
        upcoming: upcoming.rows,
        recentTransactions: recentOrders.rows,
        recentBookings: recentBookings.rows,
        monthlySpend: monthly.rows.map((m) => ({
          month: m.month,
          bookings: Number(m.bookings),
          total: Number(m.total),
        })),
      },
      'Overview retrieved'
    );
  } catch (err) {
    console.error('user overview error:', err);
    sendError(res, err, 'Failed to load your dashboard', 500);
  }
});

module.exports = router;
