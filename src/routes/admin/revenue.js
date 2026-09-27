/**
 * Revenue management.
 *
 * Money in, where it came from, and what nearly came in but didn't. Revenue is
 * always measured on paid bookings; the "tried but didn't pay" series comes
 * from `payment_orders`, because an abandoned checkout never becomes a booking.
 *
 * Every window is resolved to an explicit [start, end) pair so the comparison
 * period can be the same length immediately before it — "last month vs the
 * month before" has to mean exactly that, including in February.
 */

const express = require('express');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const { runLimited } = require('../../utils/concurrency');

const router = express.Router();

const num = (v) => Number(v || 0);
/** Money is rounded once, at the edge, to 2dp — never mid-calculation. */
const money = (v) => Number(Number(v || 0).toFixed(2));

function pad(n) {
  return String(n).padStart(2, '0');
}

function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Resolve the requested window into `{ start, end, label, previous }`.
 * `end` is exclusive, so a day never lands in two buckets.
 */
function resolveWindow(query) {
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const monthsBack = (n) =>
    new Date(startOfToday.getFullYear(), startOfToday.getMonth() - n, startOfToday.getDate());

  let start;
  let end = new Date(startOfToday.getTime() + 86400000); // through end of today
  let label;

  const period = query.period || 'last3';

  if (query.from && query.to) {
    start = new Date(query.from);
    end = new Date(new Date(query.to).getTime() + 86400000);
    label = `${query.from} to ${query.to}`;
  } else if (period === 'specific_year' && query.year) {
    start = new Date(Number(query.year), 0, 1);
    end = new Date(Number(query.year) + 1, 0, 1);
    label = String(query.year);
  } else if (period === 'specific_month' && query.month) {
    const [y, m] = String(query.month).split('-').map(Number);
    start = new Date(y, m - 1, 1);
    end = new Date(y, m, 1);
    label = query.month;
  } else if (period === 'this_month') {
    start = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);
    label = 'This month';
  } else if (period === 'last6') {
    start = monthsBack(6);
    label = 'Last 6 months';
  } else if (period === 'last12') {
    start = monthsBack(12);
    label = 'Last 1 year';
  } else {
    start = monthsBack(3);
    label = 'Last 3 months';
  }

  const spanMs = end.getTime() - start.getTime();

  // A calendar window compares to the PREVIOUS CALENDAR window, not to "the
  // same number of days before". March is 31 days; shifting back 31 days lands
  // on 29 January, which is not what anyone means by "vs last month".
  let previousStart;
  let previousEnd = new Date(start);

  if (period === 'specific_month' && query.month) {
    previousStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
  } else if (period === 'this_month') {
    previousStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
    previousEnd = new Date(start.getFullYear(), start.getMonth(), 1);
  } else if (period === 'specific_year' && query.year) {
    previousStart = new Date(start.getFullYear() - 1, 0, 1);
  } else {
    // Rolling windows and custom ranges: the same span immediately before.
    previousStart = new Date(start.getTime() - spanMs);
  }

  return {
    start: ymd(start),
    end: ymd(end),
    label,
    previous: { start: ymd(previousStart), end: ymd(previousEnd) },
    spanDays: Math.round(spanMs / 86400000),
  };
}

/** Extra filters beyond the date window. */
function extraFilter(query, alias = 'b') {
  const conditions = [];
  const params = [];
  if (query.booking_type) {
    params.push(query.booking_type);
    conditions.push(`${alias}.booking_type = $${params.length}`);
  }
  if (query.account === 'registered') conditions.push(`${alias}.user_id IS NOT NULL`);
  if (query.account === 'guest') conditions.push(`${alias}.user_id IS NULL`);
  return { sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', params };
}

async function windowTotals(win, extra) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS bookings,
            COALESCE(SUM(b.payment_amount), 0) AS revenue,
            COALESCE(SUM(b.refund_amount), 0) AS refunded,
            COALESCE(SUM(b.total_travellers), 0) AS travellers
       FROM bookings b
      WHERE b.payment_status IN ('paid','refunded')
        AND b.created_at >= $1 AND b.created_at < $2${extra.sql}`,
    [win.start, win.end, ...extra.params]
  );
  const r = rows[0] || {};
  const revenue = num(r.revenue);
  const refunded = num(r.refunded);
  const bookings = num(r.bookings);
  return {
    bookings,
    revenue: money(revenue),
    refunded: money(refunded),
    net: money(revenue - refunded),
    travellers: num(r.travellers),
    avgBooking: bookings > 0 ? money(revenue / bookings) : 0,
    avgTravellers: bookings > 0 ? Number((num(r.travellers) / bookings).toFixed(2)) : 0,
  };
}

function change(current, previous) {
  if (!previous) {
    return current ? { value: 'new', direction: 'up', raw: null } : { value: '0%', direction: 'flat', raw: 0 };
  }
  const pct = ((current - previous) / previous) * 100;
  return {
    value: `${Math.abs(pct).toFixed(0)}%`,
    direction: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat',
    raw: Number(pct.toFixed(1)),
  };
}

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  try {
    const win = resolveWindow(req.query);
    const extra = extraFilter(req.query);
    const p = [win.start, win.end, ...extra.params];

    const [current, previous, weekly, abandoned, performers, byType, byAccount, currencyRow] =
      await runLimited([
        () => windowTotals(win, extra),
        () => windowTotals({ start: win.previous.start, end: win.previous.end }, extra),

        // Weekly buckets, keyed by the Monday that starts each week.
        () => pool.query(
          `SELECT DATE(DATE_SUB(b.created_at, INTERVAL WEEKDAY(b.created_at) DAY)) AS week_start,
                  COUNT(*) AS bookings,
                  COALESCE(SUM(b.payment_amount), 0) AS revenue,
                  COALESCE(SUM(b.total_travellers), 0) AS travellers
             FROM bookings b
            WHERE b.payment_status IN ('paid','refunded')
              AND b.created_at >= $1 AND b.created_at < $2${extra.sql}
            GROUP BY week_start ORDER BY week_start ASC`,
          p
        ),

        // Tried to book, never paid.
        () => pool.query(
          `SELECT DATE(DATE_SUB(o.created_at, INTERVAL WEEKDAY(o.created_at) DAY)) AS week_start,
                  COUNT(*) AS count,
                  COALESCE(SUM(o.amount), 0) AS value
             FROM payment_orders o
            WHERE o.status IN ('created','redirected','declined','error','cancelled')
              AND o.created_at >= $1 AND o.created_at < $2
            GROUP BY week_start ORDER BY week_start ASC`,
          [win.start, win.end]
        ),

        () => pool.query(
          `SELECT b.product_title, b.booking_type, COUNT(*) AS bookings,
                  COALESCE(SUM(b.payment_amount), 0) AS revenue,
                  COALESCE(SUM(b.total_travellers), 0) AS travellers
             FROM bookings b
            WHERE b.payment_status IN ('paid','refunded')
              AND b.created_at >= $1 AND b.created_at < $2${extra.sql}
            GROUP BY b.product_title, b.booking_type
            ORDER BY revenue DESC LIMIT 8`,
          p
        ),

        () => pool.query(
          `SELECT b.booking_type, COUNT(*) AS bookings,
                  COALESCE(SUM(b.payment_amount), 0) AS revenue
             FROM bookings b
            WHERE b.payment_status IN ('paid','refunded')
              AND b.created_at >= $1 AND b.created_at < $2${extra.sql}
            GROUP BY b.booking_type ORDER BY revenue DESC`,
          p
        ),

        // This business has no B2B channel — the meaningful split is whether
        // the customer had an account or checked out as a guest.
        () => pool.query(
          `SELECT CASE WHEN b.user_id IS NULL THEN 'guest' ELSE 'registered' END AS account,
                  COUNT(*) AS bookings,
                  COALESCE(SUM(b.payment_amount), 0) AS revenue
             FROM bookings b
            WHERE b.payment_status IN ('paid','refunded')
              AND b.created_at >= $1 AND b.created_at < $2${extra.sql}
            GROUP BY account`,
          p
        ),

        () => pool.query(
          `SELECT currency, COUNT(*) AS n FROM bookings
            WHERE payment_status IN ('paid','refunded')
            GROUP BY currency ORDER BY n DESC LIMIT 5`
        ),
      ]);

    const abandonedTotals = abandoned.rows.reduce(
      (acc, r) => ({ count: acc.count + num(r.count), value: acc.value + num(r.value) }),
      { count: 0, value: 0 }
    );

    const currencies = currencyRow.rows.map((r) => r.currency).filter(Boolean);

    sendSuccess(
      res,
      {
        window: { ...win, label: win.label },
        currency: currencies[0] || 'EUR',
        // Surfaced rather than silently summed: mixing currencies would make
        // every total on this page wrong.
        mixedCurrency: currencies.length > 1 ? currencies : null,
        totals: current,
        previous,
        deltas: {
          revenue: change(current.revenue, previous.revenue),
          net: change(current.net, previous.net),
          bookings: change(current.bookings, previous.bookings),
          avgBooking: change(current.avgBooking, previous.avgBooking),
          travellers: change(current.travellers, previous.travellers),
          avgTravellers: change(current.avgTravellers, previous.avgTravellers),
        },
        weekly: weekly.rows.map((r) => ({
          weekStart: r.week_start,
          bookings: num(r.bookings),
          revenue: money(r.revenue),
          travellers: num(r.travellers),
        })),
        abandoned: {
          total: abandonedTotals.count,
          value: money(abandonedTotals.value),
          weekly: abandoned.rows.map((r) => ({
            weekStart: r.week_start,
            count: num(r.count),
            value: money(r.value),
          })),
        },
        topPerformers: performers.rows.map((r) => ({
          title: r.product_title,
          type: r.booking_type,
          bookings: num(r.bookings),
          revenue: money(r.revenue),
          travellers: num(r.travellers),
          share: current.revenue > 0 ? Number(((num(r.revenue) / current.revenue) * 100).toFixed(1)) : 0,
        })),
        byType: byType.rows.map((r) => ({
          type: r.booking_type,
          bookings: num(r.bookings),
          revenue: money(r.revenue),
        })),
        byAccount: byAccount.rows.map((r) => ({
          account: r.account,
          bookings: num(r.bookings),
          revenue: money(r.revenue),
        })),
      },
      'Revenue retrieved'
    );
  } catch (err) {
    console.error('revenue error:', err);
    sendError(res, err, 'Failed to load revenue', 500);
  }
});

/**
 * Deep revenue analysis.
 *
 * Everything the overview shows, plus the "why did the number move" layer:
 * trend at three granularities, where the funnel leaks, which products carry
 * the revenue, who is buying, and what cancellations cost.
 *
 * Two things this deliberately does NOT invent:
 *  - **Profit and margin.** Supplier cost per booking is never captured, so any
 *    margin figure would be fabricated. Refund impact is shown instead.
 *  - **Geography.** Bookings carry no city. "Revenue by travel month" replaces
 *    it, which for a single-destination business is the more useful cut.
 */
router.get('/analysis', adminAuth, async (req, res) => {
  try {
    const win = resolveWindow(req.query);
    const extra = extraFilter(req.query);
    const p = [win.start, win.end, ...extra.params];
    const prevP = [win.previous.start, win.previous.end, ...extra.params];
    const granularity = ['day', 'week', 'month'].includes(req.query.granularity)
      ? req.query.granularity
      : 'week';

    // One expression per granularity, so the trend query stays a single shape.
    const bucket = {
      day: 'DATE(b.created_at)',
      week: 'DATE(DATE_SUB(b.created_at, INTERVAL WEEKDAY(b.created_at) DAY))',
      month: "DATE(DATE_FORMAT(b.created_at, '%Y-%m-01'))",
    }[granularity];

    const paidWhere = `b.payment_status IN ('paid','refunded')
        AND b.created_at >= $1 AND b.created_at < $2${extra.sql}`;

    const [
      current, previous, trend, prevTrend, products, byType, byTravelMonth,
      supplierPerf, customers, payments, cancellations, detailed, goalRow, funnelRow, abandonedSplit,
    ] = await runLimited([
      () => windowTotals(win, extra),
      () => windowTotals({ start: win.previous.start, end: win.previous.end }, extra),

      () => pool.query(
        `SELECT ${bucket} AS bucket, COUNT(*) AS bookings,
                COALESCE(SUM(b.payment_amount), 0) AS revenue,
                COALESCE(SUM(b.refund_amount), 0) AS refunded
           FROM bookings b WHERE ${paidWhere}
          GROUP BY bucket ORDER BY bucket ASC`,
        p
      ),
      () => pool.query(
        `SELECT ${bucket} AS bucket, COALESCE(SUM(b.payment_amount), 0) AS revenue
           FROM bookings b
          WHERE b.payment_status IN ('paid','refunded')
            AND b.created_at >= $1 AND b.created_at < $2${extra.sql}
          GROUP BY bucket ORDER BY bucket ASC`,
        prevP
      ),

      () => pool.query(
        `SELECT b.product_title, b.booking_type, COUNT(*) AS bookings,
                COALESCE(SUM(b.payment_amount), 0) AS revenue,
                COALESCE(SUM(b.refund_amount), 0) AS refunded,
                COALESCE(SUM(b.total_travellers), 0) AS travellers,
                SUM(CASE WHEN b.status IN ('cancelled','refunded') THEN 1 ELSE 0 END) AS cancelled
           FROM bookings b WHERE ${paidWhere}
          GROUP BY b.product_title, b.booking_type
          ORDER BY revenue DESC LIMIT 20`,
        p
      ),

      () => pool.query(
        `SELECT b.booking_type, COUNT(*) AS bookings,
                COALESCE(SUM(b.payment_amount), 0) AS revenue
           FROM bookings b WHERE ${paidWhere}
          GROUP BY b.booking_type ORDER BY revenue DESC`,
        p
      ),

      // When people TRAVEL, as opposed to when they booked.
      () => pool.query(
        `SELECT DATE_FORMAT(COALESCE(b.check_in_date, b.travel_date), '%Y-%m') AS travel_month,
                COUNT(*) AS bookings,
                COALESCE(SUM(b.payment_amount), 0) AS revenue,
                COALESCE(SUM(b.total_travellers), 0) AS travellers
           FROM bookings b WHERE ${paidWhere}
            AND COALESCE(b.check_in_date, b.travel_date) IS NOT NULL
          GROUP BY travel_month ORDER BY travel_month ASC`,
        p
      ),

      // The supplier leg we actually have: TourVisio confirmation outcomes.
      () => pool.query(
        `SELECT COALESCE(b.supplier_status, 'unknown') AS supplier_status,
                COUNT(*) AS bookings,
                COALESCE(SUM(b.payment_amount), 0) AS revenue
           FROM bookings b WHERE ${paidWhere}
          GROUP BY supplier_status ORDER BY bookings DESC`,
        p
      ),

      () => pool.query(
        `SELECT
            COUNT(*) AS customers,
            SUM(CASE WHEN c.bookings > 1 THEN 1 ELSE 0 END) AS repeat_customers,
            COALESCE(SUM(CASE WHEN c.bookings = 1 THEN c.revenue ELSE 0 END), 0) AS new_revenue,
            COALESCE(SUM(CASE WHEN c.bookings > 1 THEN c.revenue ELSE 0 END), 0) AS repeat_revenue
           FROM (
             SELECT b.lead_email, COUNT(*) AS bookings,
                    COALESCE(SUM(b.payment_amount), 0) AS revenue
               FROM bookings b WHERE ${paidWhere}
              GROUP BY b.lead_email
           ) AS c`,
        p
      ),

      () => pool.query(
        `SELECT
            (SELECT COUNT(*) FROM payment_orders WHERE status = 'paid'
               AND created_at >= $1 AND created_at < $2) AS successful,
            (SELECT COALESCE(SUM(amount),0) FROM payment_orders WHERE status = 'paid'
               AND created_at >= $1 AND created_at < $2) AS successful_value,
            (SELECT COUNT(*) FROM payment_orders WHERE status IN ('declined','error')
               AND created_at >= $1 AND created_at < $2) AS failed,
            (SELECT COUNT(*) FROM payment_orders WHERE status IN ('created','redirected')
               AND created_at >= $1 AND created_at < $2) AS pending,
            (SELECT COALESCE(SUM(amount),0) FROM payment_orders WHERE status IN ('created','redirected')
               AND created_at >= $1 AND created_at < $2) AS pending_value`,
        [win.start, win.end]
      ),

      () => pool.query(
        `SELECT COUNT(*) AS cancelled,
                COALESCE(SUM(b.payment_amount), 0) AS cancelled_value,
                SUM(CASE WHEN b.refund_amount > 0 THEN 1 ELSE 0 END) AS refunded_count,
                COALESCE(SUM(b.refund_amount), 0) AS refunded_value
           FROM bookings b
          WHERE b.status IN ('cancelled','refunded')
            AND b.created_at >= $1 AND b.created_at < $2${extra.sql}`,
        p
      ),

      () => pool.query(
        `SELECT b.id, b.booking_reference, b.created_at, b.product_title, b.booking_type,
                b.lead_first_name, b.lead_last_name, b.lead_email,
                b.payment_amount, b.refund_amount, b.currency, b.status, b.payment_status,
                b.supplier_status, b.total_travellers, b.check_in_date
           FROM bookings b WHERE ${paidWhere}
          ORDER BY b.payment_amount DESC LIMIT 100`,
        p
      ),

      () => pool.query(`SELECT setting_value FROM admin_settings WHERE setting_key = 'revenue_goal'`),

      () => pool.query(
        `SELECT COUNT(*) AS started,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN status IN ('created','redirected') THEN 1 ELSE 0 END) AS abandoned,
                COALESCE(SUM(CASE WHEN status IN ('created','redirected') THEN amount ELSE 0 END), 0) AS abandoned_value
           FROM payment_orders WHERE created_at >= $1 AND created_at < $2`,
        [win.start, win.end]
      ),

      // Abandoned before ever reaching the gateway, vs abandoned at the card page.
      () => pool.query(
        `SELECT
            SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END) AS never_started,
            COALESCE(SUM(CASE WHEN status = 'created' THEN amount ELSE 0 END), 0) AS never_started_value,
            SUM(CASE WHEN status = 'redirected' THEN 1 ELSE 0 END) AS left_at_gateway,
            COALESCE(SUM(CASE WHEN status = 'redirected' THEN amount ELSE 0 END), 0) AS left_at_gateway_value
           FROM payment_orders
          WHERE status IN ('created','redirected') AND created_at >= $1 AND created_at < $2`,
        [win.start, win.end]
      ),
    ]);

    const c = customers.rows[0] || {};
    const pay = payments.rows[0] || {};
    const cx = cancellations.rows[0] || {};
    const fn = funnelRow.rows[0] || {};
    const ab = abandonedSplit.rows[0] || {};

    const totalCustomers = num(c.customers);
    const repeatCustomers = num(c.repeat_customers);
    const started = num(fn.started);
    const abandonedCount = num(fn.abandoned);

    const goal = goalRow.rows[0]?.setting_value ? Number(goalRow.rows[0].setting_value) : null;

    // Straight-line projection from the pace so far in this window. Honest
    // about being a projection, not a model.
    const elapsedDays = Math.max(
      1,
      Math.min(
        win.spanDays,
        Math.round((Date.now() - new Date(win.start).getTime()) / 86400000)
      )
    );
    const perDay = current.revenue / elapsedDays;

    const topProducts = products.rows.map((r) => {
      const revenue = num(r.revenue);
      const refunded = num(r.refunded);
      return {
        title: r.product_title,
        type: r.booking_type,
        bookings: num(r.bookings),
        revenue: money(revenue),
        refunded: money(refunded),
        net: money(revenue - refunded),
        travellers: num(r.travellers),
        cancelled: num(r.cancelled),
        refundRate: revenue > 0 ? Number(((refunded / revenue) * 100).toFixed(1)) : 0,
        share: current.revenue > 0 ? Number(((revenue / current.revenue) * 100).toFixed(1)) : 0,
      };
    });

    // ── Auto-written findings ────────────────────────────────────────────
    const insights = [];
    if (topProducts.length) {
      const top = topProducts[0];
      insights.push(`${top.title} led with ${top.share}% of revenue (${top.bookings} booking(s)).`);
    }
    if (byType.rows.length > 1) {
      const lead = byType.rows[0];
      const leadShare =
        current.revenue > 0 ? ((num(lead.revenue) / current.revenue) * 100).toFixed(0) : 0;
      insights.push(`${lead.booking_type} accounts for ${leadShare}% of revenue.`);
    }
    if (abandonedCount > 0) {
      insights.push(
        `EUR ${money(num(fn.abandoned_value)).toFixed(2)} of potential revenue is sitting in ${abandonedCount} abandoned checkout(s).`
      );
    }
    if (started > 0) {
      insights.push(
        `${((num(fn.paid) / started) * 100).toFixed(0)}% of checkouts that started were paid.`
      );
    }
    if (repeatCustomers > 0) {
      insights.push(
        `${repeatCustomers} of ${totalCustomers} customer(s) booked more than once — ${((repeatCustomers / totalCustomers) * 100).toFixed(0)}% repeat rate.`
      );
    }
    const refundy = topProducts.filter((t) => t.refundRate > 10);
    if (refundy.length) {
      insights.push(`${refundy.length} product(s) have a refund rate above 10%.`);
    }
    if (previous.revenue > 0) {
      const diff = ((current.revenue - previous.revenue) / previous.revenue) * 100;
      insights.push(
        `Revenue is ${diff >= 0 ? 'up' : 'down'} ${Math.abs(diff).toFixed(0)}% on the previous period.`
      );
    }

    // ── Needs attention: real signals, not invented margins ──────────────
    const attention = topProducts
      .map((t) => {
        const flags = [];
        if (t.refundRate > 10) flags.push(`${t.refundRate}% refunded`);
        if (t.cancelled > 0) flags.push(`${t.cancelled} cancelled`);
        return flags.length ? { ...t, flags } : null;
      })
      .filter(Boolean);

    const supplierProblems = supplierPerf.rows
      .filter((r) => ['commit_failed', 'commit_unconfirmed', 'awaiting_agency_payment'].includes(r.supplier_status))
      .reduce((sum, r) => sum + num(r.bookings), 0);
    if (supplierProblems > 0) {
      attention.unshift({
        title: 'Supplier confirmation outstanding',
        type: 'operations',
        bookings: supplierProblems,
        revenue: 0,
        flags: ['customer already paid'],
      });
    }

    sendSuccess(
      res,
      {
        window: win,
        granularity,
        currency: 'EUR',
        totals: current,
        previous,
        deltas: {
          revenue: change(current.revenue, previous.revenue),
          net: change(current.net, previous.net),
          bookings: change(current.bookings, previous.bookings),
          avgBooking: change(current.avgBooking, previous.avgBooking),
        },
        // Named so nobody mistakes an absent margin for a zero margin.
        marginAvailable: false,
        trend: trend.rows.map((r, i) => ({
          bucket: r.bucket,
          bookings: num(r.bookings),
          revenue: money(r.revenue),
          refunded: money(r.refunded),
          previousRevenue: money(prevTrend.rows[i]?.revenue || 0),
        })),
        insights,
        topProducts,
        byType: byType.rows.map((r) => ({
          type: r.booking_type,
          bookings: num(r.bookings),
          revenue: money(r.revenue),
        })),
        byTravelMonth: byTravelMonth.rows.map((r) => ({
          month: r.travel_month,
          bookings: num(r.bookings),
          revenue: money(r.revenue),
          travellers: num(r.travellers),
        })),
        supplierPerformance: supplierPerf.rows.map((r) => ({
          status: r.supplier_status,
          bookings: num(r.bookings),
          revenue: money(r.revenue),
        })),
        funnel: {
          started,
          paid: num(fn.paid),
          abandoned: abandonedCount,
          abandonedValue: money(fn.abandoned_value),
          conversion: started > 0 ? Number(((num(fn.paid) / started) * 100).toFixed(1)) : 0,
          avgLost: abandonedCount > 0 ? money(num(fn.abandoned_value) / abandonedCount) : 0,
          neverReachedGateway: {
            count: num(ab.never_started),
            value: money(ab.never_started_value),
          },
          leftAtGateway: {
            count: num(ab.left_at_gateway),
            value: money(ab.left_at_gateway_value),
          },
        },
        customerRevenue: {
          customers: totalCustomers,
          repeatCustomers,
          newCustomers: totalCustomers - repeatCustomers,
          repeatRate: totalCustomers > 0 ? Number(((repeatCustomers / totalCustomers) * 100).toFixed(0)) : 0,
          newRevenue: money(c.new_revenue),
          repeatRevenue: money(c.repeat_revenue),
          revenuePerCustomer: totalCustomers > 0 ? money(current.revenue / totalCustomers) : 0,
        },
        paymentAnalysis: {
          successful: num(pay.successful),
          successfulValue: money(pay.successful_value),
          failed: num(pay.failed),
          pending: num(pay.pending),
          pendingValue: money(pay.pending_value),
          failRate:
            num(pay.successful) + num(pay.failed) > 0
              ? Number(((num(pay.failed) / (num(pay.successful) + num(pay.failed))) * 100).toFixed(1))
              : 0,
        },
        cancellationImpact: {
          cancelled: num(cx.cancelled),
          cancelledValue: money(cx.cancelled_value),
          refundedCount: num(cx.refunded_count),
          refundedValue: money(cx.refunded_value),
          cancelRate:
            current.bookings > 0 ? Number(((num(cx.cancelled) / current.bookings) * 100).toFixed(1)) : 0,
        },
        forecast: {
          perDay: money(perDay),
          projectedNext30: money(perDay * 30),
          elapsedDays,
          goal,
          goalProgress: goal ? Number(((current.revenue / goal) * 100).toFixed(1)) : null,
        },
        attention,
        detailed: detailed.rows.map((r) => ({
          id: r.id,
          reference: r.booking_reference,
          date: r.created_at,
          product: r.product_title,
          type: r.booking_type,
          customer: `${r.lead_first_name || ''} ${r.lead_last_name || ''}`.trim(),
          email: r.lead_email,
          amount: money(r.payment_amount),
          refunded: money(r.refund_amount || 0),
          net: money(num(r.payment_amount) - num(r.refund_amount)),
          currency: r.currency,
          status: r.status,
          supplierStatus: r.supplier_status,
          travellers: r.total_travellers,
          checkIn: r.check_in_date,
        })),
      },
      'Revenue analysis retrieved'
    );
  } catch (err) {
    console.error('revenue analysis error:', err);
    sendError(res, err, 'Failed to load revenue analysis', 500);
  }
});

// ── Revenue goal ─────────────────────────────────────────────────────────────
router.post('/goal', adminAuth, async (req, res) => {
  try {
    const value = req.body?.goal;
    if (value !== null && value !== '' && !(Number(value) > 0)) {
      return sendError(res, null, 'Goal must be a positive number, or empty to clear it', 400);
    }

    if (value === null || value === '') {
      await pool.query(`DELETE FROM admin_settings WHERE setting_key = 'revenue_goal'`);
    } else {
      await pool.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_by_admin_id)
         VALUES ('revenue_goal', $1, $2)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                                 updated_by_admin_id = VALUES(updated_by_admin_id)`,
        [String(Number(value)), req.admin.id]
      );
    }

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.revenue.goal_set',
      summary: value ? `Revenue goal set to ${value}` : 'Revenue goal cleared',
    });

    sendSuccess(res, { goal: value ? Number(value) : null }, 'Revenue goal saved');
  } catch (err) {
    console.error('revenue goal error:', err);
    sendError(res, err, 'Failed to save the revenue goal', 500);
  }
});

// ── GET /export ──────────────────────────────────────────────────────────────
router.get('/export', adminAuth, async (req, res) => {
  try {
    const win = resolveWindow(req.query);
    const extra = extraFilter(req.query);

    const { rows } = await pool.query(
      `SELECT DATE(DATE_SUB(b.created_at, INTERVAL WEEKDAY(b.created_at) DAY)) AS week_start,
              b.booking_type, COUNT(*) AS bookings,
              COALESCE(SUM(b.payment_amount), 0) AS revenue,
              COALESCE(SUM(b.refund_amount), 0) AS refunded,
              COALESCE(SUM(b.total_travellers), 0) AS travellers
         FROM bookings b
        WHERE b.payment_status IN ('paid','refunded')
          AND b.created_at >= $1 AND b.created_at < $2${extra.sql}
        GROUP BY week_start, b.booking_type
        ORDER BY week_start ASC`,
      [win.start, win.end, ...extra.params]
    );

    const header = ['Week starting', 'Type', 'Bookings', 'Revenue', 'Refunded', 'Net', 'Travellers'];
    const csv = [
      header.join(','),
      ...rows.map((r) =>
        [
          String(r.week_start).slice(0, 10),
          r.booking_type,
          num(r.bookings),
          money(r.revenue),
          money(r.refunded),
          money(num(r.revenue) - num(r.refunded)),
          num(r.travellers),
        ].join(',')
      ),
    ].join('\r\n');

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.revenue.export',
      summary: `Exported revenue for ${win.label}`,
      metadata: { window: win },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="revenue-${win.start}-to-${win.end}.csv"`
    );
    res.send('﻿' + csv);
  } catch (err) {
    console.error('revenue export error:', err);
    sendError(res, err, 'Failed to export revenue', 500);
  }
});

module.exports = router;
