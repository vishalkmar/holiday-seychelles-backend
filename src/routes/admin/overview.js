/**
 * Admin dashboard data — the whole command-centre screen in one request.
 *
 * Deliberately shaped around what Holiday Seychelles actually sells: hotel
 * stays, tours, transfers and excursions booked through TourVisio and paid for
 * with CyberSource. There are no "suppliers" or "experiences" tables to count,
 * so the counters measure customers, bookings, content and support instead.
 *
 * Every figure here is a read. The dashboard never mutates anything.
 */

const express = require('express');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const { runLimited } = require('../../utils/concurrency');

const router = express.Router();

/** Percent change, guarding the divide-by-zero that makes dashboards lie. */
function delta(current, previous) {
  const now = Number(current || 0);
  const before = Number(previous || 0);
  if (before === 0) {
    return now === 0
      ? { value: '0%', direction: 'flat', raw: 0 }
      : { value: 'new', direction: 'up', raw: null };
  }
  const change = ((now - before) / before) * 100;
  return {
    value: `${Math.abs(change).toFixed(0)}%`,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    raw: Number(change.toFixed(1)),
  };
}

const n = (value) => Number(value || 0);

router.get('/', adminAuth, async (req, res) => {
  try {
    const [
      counts,
      thisMonth,
      lastMonth,
      bookingStatus,
      orderStatus,
      recentBookings,
      upcoming,
      todayOps,
      topProducts,
      dailyRevenue,
      counterTrends,
      attention,
      queries,
      customers,
      refunds,
      monthlyRevenue,
      paymentBookingStatus,
      // Bounded, not Promise.all: fourteen queries at once against a
      // six-connection pool is the contention that made the analytics screens
      // time out on this host.
    ] = await runLimited([
      // ── Lifetime counters ────────────────────────────────────────────────
      () => pool.query(`
        SELECT
          (SELECT COUNT(*) FROM users)                                        AS customers,
          (SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS new_customers,
          (SELECT COUNT(*) FROM bookings)                                     AS bookings,
          (SELECT COUNT(*) FROM blogs)                                        AS blogs,
          (SELECT COUNT(*) FROM blogs WHERE status = 'published')             AS blogs_published,
          (SELECT COUNT(*) FROM queries)                                      AS queries,
          (SELECT COUNT(DISTINCT product_title) FROM bookings)                AS products
      `),

      // ── This month vs last ───────────────────────────────────────────────
      () => pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN payment_amount ELSE 0 END), 0) AS revenue,
          COUNT(*)                                                                    AS bookings,
          SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END)                    AS paid,
          SUM(CASE WHEN status IN ('cancelled','refunded') THEN 1 ELSE 0 END)         AS cancelled
        FROM bookings
        WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
      `),
      () => pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN payment_amount ELSE 0 END), 0) AS revenue,
          COUNT(*)                                                                    AS bookings,
          SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END)                    AS paid,
          SUM(CASE WHEN status IN ('cancelled','refunded') THEN 1 ELSE 0 END)         AS cancelled
        FROM bookings
        WHERE created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
          AND created_at <  DATE_FORMAT(CURDATE(), '%Y-%m-01')
      `),

      // ── Status mixes ─────────────────────────────────────────────────────
      () => pool.query(`SELECT status, COUNT(*) AS count FROM bookings GROUP BY status`),
      () => pool.query(`
        SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS value
          FROM payment_orders GROUP BY status
      `),

      // ── Recent activity ──────────────────────────────────────────────────
      () => pool.query(`
        SELECT id, booking_reference, product_title, booking_type, lead_first_name,
               lead_last_name, lead_email, payment_amount, currency, status,
               payment_status, total_travellers, check_in_date, created_at
          FROM bookings ORDER BY created_at DESC LIMIT 8
      `),
      () => pool.query(`
        SELECT id, booking_reference, product_title, booking_type, check_in_date,
               check_out_date, total_travellers, lead_first_name, lead_last_name,
               payment_amount, currency, supplier_status
          FROM bookings
         WHERE payment_status = 'paid' AND status NOT IN ('cancelled','refunded')
           AND DATE(COALESCE(check_in_date, travel_date)) >= CURDATE()
         ORDER BY COALESCE(check_in_date, travel_date) ASC LIMIT 6
      `),

      // ── Today ────────────────────────────────────────────────────────────
      () => pool.query(`
        SELECT
          SUM(CASE WHEN DATE(COALESCE(check_in_date, travel_date)) = CURDATE() THEN 1 ELSE 0 END) AS starting_today,
          SUM(CASE WHEN DATE(COALESCE(check_in_date, travel_date)) = CURDATE() THEN total_travellers ELSE 0 END) AS travellers_today,
          SUM(CASE WHEN DATE(check_out_date) = CURDATE() THEN 1 ELSE 0 END) AS ending_today,
          SUM(CASE WHEN supplier_status IN ('awaiting_agency_payment','commit_failed','commit_unconfirmed') THEN 1 ELSE 0 END) AS awaiting_supplier
        FROM bookings
        WHERE payment_status = 'paid' AND status NOT IN ('cancelled','refunded')
      `),

      // ── Top sellers ──────────────────────────────────────────────────────
      () => pool.query(`
        SELECT product_title, booking_type, COUNT(*) AS bookings,
               COALESCE(SUM(payment_amount), 0) AS revenue, currency
          FROM bookings
         WHERE payment_status = 'paid'
         GROUP BY product_title, booking_type, currency
         ORDER BY revenue DESC LIMIT 5
      `),

      // ── 30-day revenue sparkline ─────────────────────────────────────────
      () => pool.query(`
        SELECT DATE(created_at) AS day, COALESCE(SUM(payment_amount), 0) AS revenue,
               COUNT(*) AS bookings
          FROM bookings
         WHERE payment_status = 'paid'
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
         GROUP BY DATE(created_at) ORDER BY day ASC
      `),

      // Daily counts for the counter tiles' sparklines. A UNION rather than
      // three round trips, because this host dislikes extra connections more
      // than it dislikes a slightly longer query.
      () => pool.query(`
        SELECT 'customers' AS kind, DATE(created_at) AS day, COUNT(*) AS n
          FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
         GROUP BY DATE(created_at)
        UNION ALL
        SELECT 'blogs', DATE(created_at), COUNT(*)
          FROM blogs WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
         GROUP BY DATE(created_at)
        UNION ALL
        SELECT 'queries', DATE(created_at), COUNT(*)
          FROM queries WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
         GROUP BY DATE(created_at)
      `),

      // ── Needs attention ──────────────────────────────────────────────────
      () => pool.query(`
        SELECT
          (SELECT COUNT(*) FROM payment_orders WHERE status IN ('created','redirected')) AS awaiting_payment,
          (SELECT COALESCE(SUM(amount),0) FROM payment_orders WHERE status IN ('created','redirected')) AS awaiting_value,
          (SELECT COUNT(*) FROM payment_orders WHERE status IN ('declined','error')) AS failed_payments,
          (SELECT COUNT(*) FROM payment_attempts WHERE signature_valid = 0) AS rejected_callbacks,
          (SELECT COUNT(*) FROM bookings WHERE supplier_status IN ('commit_failed','commit_unconfirmed')) AS supplier_problems,
          (SELECT COUNT(*) FROM bookings WHERE supplier_status = 'awaiting_agency_payment') AS awaiting_agency
      `),

      // ── Support ──────────────────────────────────────────────────────────
      () => pool.query(`SELECT status, COUNT(*) AS count FROM queries GROUP BY status`),

      // ── Customer mix ─────────────────────────────────────────────────────
      () => pool.query(`
        SELECT COUNT(*) AS buyers, SUM(bookings_count > 1) AS repeat_buyers
          FROM (
            SELECT lead_email, COUNT(*) AS bookings_count
              FROM bookings WHERE payment_status = 'paid' GROUP BY lead_email
          ) AS per_customer
      `),

      // ── Refunds ──────────────────────────────────────────────────────────
      () => pool.query(`
        SELECT COUNT(*) AS count, COALESCE(SUM(refund_amount), 0) AS total
          FROM bookings WHERE refund_amount IS NOT NULL AND refund_amount > 0
      `),
      () => pool.query(`
        SELECT MONTH(created_at) AS month, COALESCE(SUM(payment_amount), 0) AS revenue
          FROM bookings
         WHERE payment_status = 'paid'
           AND created_at >= MAKEDATE(YEAR(CURDATE()), 1)
           AND created_at < MAKEDATE(YEAR(CURDATE()) + 1, 1)
         GROUP BY MONTH(created_at) ORDER BY month
      `),
      () => pool.query(`
        SELECT
          SUM(CASE WHEN status IN ('cancelled', 'refunded') THEN 1 ELSE 0 END) AS cancelled,
          SUM(CASE WHEN (status NOT IN ('cancelled', 'refunded') OR status IS NULL) AND payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
          SUM(CASE WHEN (status NOT IN ('cancelled', 'refunded') OR status IS NULL)
            AND (payment_status <> 'paid' OR payment_status IS NULL) THEN 1 ELSE 0 END) AS pending
        FROM bookings
      `),
    ]);

    const c = counts.rows[0] || {};
    const tm = thisMonth.rows[0] || {};
    const lm = lastMonth.rows[0] || {};
    const ops = todayOps.rows[0] || {};
    const att = attention.rows[0] || {};
    const cust = customers.rows[0] || {};
    const ref = refunds.rows[0] || {};

    // Currency is single-tenant here; take it from the data rather than assume.
    const currency = recentBookings.rows[0]?.currency || 'EUR';

    const statusMap = bookingStatus.rows.reduce((acc, r) => {
      acc[r.status] = n(r.count);
      return acc;
    }, {});

    const orderMap = orderStatus.rows.reduce((acc, r) => {
      acc[r.status] = { count: n(r.count), value: n(r.value) };
      return acc;
    }, {});

    const openQueries = queries.rows
      .filter((q) => q.status !== 'closed')
      .reduce((sum, q) => sum + n(q.count), 0);

    const paidRevenue = n(tm.revenue);
    const paidCount = n(tm.paid);

    // ── Alerts: only things that actually need a human ────────────────────
    const alerts = [];
    if (n(att.awaiting_payment) > 0) {
      alerts.push({
        tone: 'warning',
        message: `${currency} ${n(att.awaiting_value).toFixed(2)} sitting in ${n(att.awaiting_payment)} unfinished checkout(s).`,
        section: 'transactions',
        filter: 'pending',
      });
    }
    if (n(att.supplier_problems) > 0) {
      alerts.push({
        tone: 'critical',
        message: `${n(att.supplier_problems)} paid booking(s) failed to confirm with the supplier — the customer has been charged.`,
        section: 'bookings',
      });
    }
    if (n(att.rejected_callbacks) > 0) {
      alerts.push({
        tone: 'critical',
        message: `${n(att.rejected_callbacks)} payment callback(s) were rejected for an invalid signature.`,
        section: 'security-fraud',
      });
    }
    if (n(att.awaiting_agency) > 0) {
      alerts.push({
        tone: 'info',
        message: `${n(att.awaiting_agency)} booking(s) waiting on agency-credit settlement with TourVisio.`,
        section: 'bookings',
      });
    }
    if (openQueries > 0) {
      alerts.push({
        tone: 'info',
        message: `${openQueries} customer ${openQueries === 1 ? 'query is' : 'queries are'} open.`,
        section: 'queries',
      });
    }

    sendSuccess(
      res,
      {
        currency,
        counters: {
          customers: n(c.customers),
          newCustomers: n(c.new_customers),
          bookings: n(c.bookings),
          products: n(c.products),
          blogs: n(c.blogs),
          blogsPublished: n(c.blogs_published),
          queries: n(c.queries),
          openQueries,
        },
        month: {
          revenue: paidRevenue,
          bookings: n(tm.bookings),
          paid: paidCount,
          cancelled: n(tm.cancelled),
          avgBooking: paidCount > 0 ? Number((paidRevenue / paidCount).toFixed(2)) : 0,
          deltas: {
            revenue: delta(tm.revenue, lm.revenue),
            bookings: delta(tm.bookings, lm.bookings),
            paid: delta(tm.paid, lm.paid),
            cancelled: delta(tm.cancelled, lm.cancelled),
          },
          previous: {
            revenue: n(lm.revenue),
            bookings: n(lm.bookings),
          },
        },
        bookingStatus: {
          confirmed: statusMap.confirmed || 0,
          pendingSupplier: statusMap.pending_supplier || 0,
          cancelled: (statusMap.cancelled || 0) + (statusMap.refunded || 0),
          all: Object.values(statusMap).reduce((a, b) => a + b, 0),
        },
        payments: {
          collected: paidRevenue,
          // Checkout funnel, straight from the order table.
          ordersStarted: (orderMap.created?.count || 0) + (orderMap.redirected?.count || 0),
          ordersPaid: orderMap.paid?.count || 0,
          awaitingPayment: n(att.awaiting_payment),
          awaitingValue: n(att.awaiting_value),
          failed: n(att.failed_payments),
          rejectedCallbacks: n(att.rejected_callbacks),
          refundCount: n(ref.count),
          refundTotal: n(ref.total),
        },
        today: {
          startingToday: n(ops.starting_today),
          travellersToday: n(ops.travellers_today),
          endingToday: n(ops.ending_today),
          awaitingSupplier: n(ops.awaiting_supplier),
        },
        customers: {
          total: n(c.customers),
          buyers: n(cust.buyers),
          repeatBuyers: n(cust.repeat_buyers),
          repeatRate:
            n(cust.buyers) > 0
              ? Number(((n(cust.repeat_buyers) / n(cust.buyers)) * 100).toFixed(0))
              : 0,
          newLast30: n(c.new_customers),
        },
        recentBookings: recentBookings.rows,
        upcoming: upcoming.rows,
        topProducts: topProducts.rows.map((p) => ({
          title: p.product_title,
          type: p.booking_type,
          bookings: n(p.bookings),
          revenue: n(p.revenue),
          currency: p.currency,
        })),
        monthlyRevenue: monthlyRevenue.rows.map((row) => ({ month: n(row.month), revenue: n(row.revenue) })),
        paymentBookingStatus: {
          paid: n(paymentBookingStatus.rows[0]?.paid),
          pending: n(paymentBookingStatus.rows[0]?.pending),
          cancelled: n(paymentBookingStatus.rows[0]?.cancelled),
        },
        revenueTrend: dailyRevenue.rows.map((d) => ({
          day: d.day,
          revenue: n(d.revenue),
          bookings: n(d.bookings),
        })),
        // Daily counts behind the counter tiles' sparklines. A tile with no
        // series gets an empty array and draws a flat rule rather than an
        // invented curve.
        counterTrends: ['customers', 'blogs', 'queries'].reduce((acc, kind) => {
          acc[kind] = counterTrends.rows
            .filter((r) => r.kind === kind)
            .map((r) => ({ day: r.day, value: n(r.n) }));
          return acc;
        }, {}),
        alerts,
      },
      'Dashboard overview retrieved'
    );
  } catch (err) {
    console.error('admin overview error:', err);
    sendError(res, err, 'Failed to load the dashboard', 500);
  }
});

module.exports = router;
