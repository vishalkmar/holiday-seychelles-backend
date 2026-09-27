const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const { generateVoucherPDF } = require('../../utils/voucher');
const { sendVoucherEmail, sendRefundEmail } = require('../../utils/mailer');
const { processRefund, isLive: cybersourceLive } = require('../../utils/cybersource');
const { evaluateRefund } = require('../../utils/refundPolicy');
const { buildBookingFilter, buildSort } = require('./bookingsQuery');
const sec = require('../../services/adminSecurity');

const router = express.Router();

// Get all bookings with filters
/**
 * Bookings list.
 *
 * Returns the page AND the totals for the whole filtered set, from the same
 * WHERE clause — so the stat strip always describes what the operator is
 * actually looking at, not just the visible page.
 */
router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
    const offset = (page - 1) * limit;

    const { where, params } = buildBookingFilter(req.query);
    const order = buildSort(req.query.sort);

    const [list, totals, byType, dailyStats] = await Promise.all([
      pool.query(
        `SELECT b.id, b.booking_reference, b.booking_type, b.status, b.payment_status,
                b.payment_gateway, b.payment_reference, b.voucher_path, b.voucher_generated_at,
                b.lead_first_name, b.lead_last_name, b.lead_email, b.lead_mobile,
                b.product_title, b.product_code, b.payment_amount, b.currency, b.travel_date,
                b.check_in_date, b.check_out_date, b.total_travellers, b.total_adults,
                b.total_children, b.admin_notes, b.supplier_reference, b.supplier_status,
                b.refund_amount, b.is_refundable, b.refund_window_hours,
                b.cancelled_at, b.user_id, u.email AS user_email,
                b.created_at, b.updated_at
           FROM bookings b
           LEFT JOIN users u ON b.user_id = u.id
           ${where}
          ORDER BY ${order}
          LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      pool.query(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0) AS revenue,
            SUM(CASE WHEN b.payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
            SUM(CASE WHEN b.payment_status <> 'paid' THEN 1 ELSE 0 END) AS unpaid,
            SUM(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN b.status = 'refunded' THEN 1 ELSE 0 END) AS refunded,
            SUM(CASE WHEN b.status = 'pending_supplier' THEN 1 ELSE 0 END) AS pending_supplier,
            COALESCE(SUM(b.refund_amount), 0) AS refunded_value,
            COALESCE(SUM(b.total_travellers), 0) AS travellers
           FROM bookings b ${where}`,
        params
      ),
      pool.query(
        `SELECT b.booking_type, COUNT(*) AS count FROM bookings b ${where} GROUP BY b.booking_type`,
        params
      ),
      pool.query(
        `SELECT DATE(b.created_at) AS day, COUNT(*) AS bookings,
                COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0) AS revenue,
                SUM(CASE WHEN b.payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN b.payment_status <> 'paid' THEN 1 ELSE 0 END) AS unpaid,
                SUM(CASE WHEN b.status IN ('cancelled', 'refunded') THEN 1 ELSE 0 END) AS cancelled,
                COALESCE(SUM(b.total_travellers), 0) AS travellers
           FROM bookings b ${where}
          GROUP BY DATE(b.created_at) ORDER BY day DESC LIMIT 14`,
        params
      ),
    ]);

    const t = totals.rows[0] || {};
    const num = (v) => Number(v || 0);
    const total = num(t.total);

    sendSuccess(
      res,
      {
        bookings: list.rows,
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit)),
        stats: {
          trends: Object.fromEntries(['revenue', 'bookings', 'paid', 'unpaid', 'cancelled', 'travellers'].map((key) => [
            key, [...dailyStats.rows].reverse().map((row) => num(row[key])),
          ])),
          total,
          revenue: num(t.revenue),
          paid: num(t.paid),
          unpaid: num(t.unpaid),
          cancelled: num(t.cancelled),
          refunded: num(t.refunded),
          pendingSupplier: num(t.pending_supplier),
          refundedValue: num(t.refunded_value),
          travellers: num(t.travellers),
          avgValue: num(t.paid) > 0 ? Number((num(t.revenue) / num(t.paid)).toFixed(2)) : 0,
        },
        byType: byType.rows.map((r) => ({ type: r.booking_type, count: num(r.count) })),
        currency: list.rows[0]?.currency || 'EUR',
      },
      'Bookings retrieved successfully'
    );
  } catch (err) {
    console.error('get bookings error:', err);
    sendError(res, err, 'Failed to get bookings', 500);
  }
});

/**
 * CSV of the current view.
 *
 * Streams whatever the filters select, with no page limit — an export that
 * silently stopped at 25 rows would be worse than no export.
 */
router.get('/export', adminAuth, async (req, res) => {
  try {
    const { where, params } = buildBookingFilter(req.query);
    const order = buildSort(req.query.sort);

    const { rows } = await pool.query(
      `SELECT b.booking_reference, b.created_at, b.booking_type, b.status, b.payment_status,
              b.lead_first_name, b.lead_last_name, b.lead_email, b.lead_mobile,
              b.product_title, b.product_code, b.check_in_date, b.check_out_date,
              b.total_travellers, b.total_adults, b.total_children,
              b.payment_amount, b.currency, b.payment_gateway, b.payment_reference,
              b.supplier_reference, b.supplier_status, b.refund_amount, b.cancelled_at
         FROM bookings b ${where} ORDER BY ${order} LIMIT 10000`,
      params
    );

    const columns = [
      ['Reference', (r) => r.booking_reference],
      ['Booked on', (r) => csvDate(r.created_at)],
      ['Type', (r) => r.booking_type],
      ['Status', (r) => r.status],
      ['Payment', (r) => r.payment_status],
      ['Guest', (r) => `${r.lead_first_name || ''} ${r.lead_last_name || ''}`.trim()],
      ['Email', (r) => r.lead_email],
      ['Mobile', (r) => r.lead_mobile],
      ['Product', (r) => r.product_title],
      ['Product code', (r) => r.product_code],
      ['Check in', (r) => csvDate(r.check_in_date)],
      ['Check out', (r) => csvDate(r.check_out_date)],
      ['Travellers', (r) => r.total_travellers],
      ['Adults', (r) => r.total_adults],
      ['Children', (r) => r.total_children],
      ['Amount', (r) => r.payment_amount],
      ['Currency', (r) => r.currency],
      ['Gateway', (r) => r.payment_gateway],
      ['Transaction', (r) => r.payment_reference],
      ['Supplier ref', (r) => r.supplier_reference],
      ['Supplier status', (r) => r.supplier_status],
      ['Refunded', (r) => r.refund_amount],
      ['Cancelled at', (r) => csvDate(r.cancelled_at)],
    ];

    const csv = [
      columns.map((c) => c[0]).join(','),
      ...rows.map((r) => columns.map((c) => csvCell(c[1](r))).join(',')),
    ].join('\r\n');

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.bookings.export',
      summary: `Exported ${rows.length} booking(s) to CSV`,
      metadata: { filters: req.query },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookings-${stamp}.csv"`);
    // Excel needs the BOM to read UTF-8 correctly.
    res.send('﻿' + csv);
  } catch (err) {
    console.error('export bookings error:', err);
    sendError(res, err, 'Failed to export bookings', 500);
  }
});

function csvDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

/** Quote anything that could break a cell, and defuse spreadsheet formulas. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Booking analytics.
 *
 * Uses the same filter builder as the list, so "what the charts describe" and
 * "what the table would show" are always the same set of bookings.
 *
 * The funnel is the one figure that cannot come from `bookings` alone: a
 * booking row only exists once money cleared, so attempts that were abandoned
 * live in `payment_orders`. Conversion is measured there.
 */
router.get('/analytics', adminAuth, async (req, res) => {
  try {
    const { where, params } = buildBookingFilter(req.query);
    const compare = String(req.query.compare || '') === '1';

    // How far back the current window reaches, so the comparison window can be
    // the same length immediately before it.
    const periodDays = {
      today: 1, yesterday: 1, last7: 7, last30: 30, this_month: 30,
      last_month: 30, last3: 90, last6: 180, this_year: 365, last_year: 365,
    }[req.query.period] || null;

    const [
      totals, daily, statusRows, byType, topProducts,
      partySize, weekday, topDay, leadTime, funnel,
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN b.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
                SUM(CASE WHEN b.status IN ('cancelled','refunded') THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN b.payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
                COALESCE(SUM(b.total_travellers), 0) AS travellers,
                COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0) AS revenue
           FROM bookings b ${where}`,
        params
      ),
      pool.query(
        `SELECT DATE(b.created_at) AS day, COUNT(*) AS bookings,
                COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0) AS revenue,
                COALESCE(SUM(b.total_travellers), 0) AS travellers
           FROM bookings b ${where}
          GROUP BY DATE(b.created_at) ORDER BY day ASC`,
        params
      ),
      pool.query(
        `SELECT b.status, COUNT(*) AS count FROM bookings b ${where} GROUP BY b.status`,
        params
      ),
      pool.query(
        `SELECT b.booking_type, COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0) AS revenue
           FROM bookings b ${where} GROUP BY b.booking_type ORDER BY count DESC`,
        params
      ),
      pool.query(
        `SELECT b.product_title, b.booking_type, COUNT(*) AS count,
                COALESCE(SUM(b.total_travellers), 0) AS travellers,
                COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0) AS revenue
           FROM bookings b ${where}
          GROUP BY b.product_title, b.booking_type
          ORDER BY count DESC, revenue DESC LIMIT 8`,
        params
      ),
      pool.query(
        `SELECT
            SUM(CASE WHEN b.total_travellers <= 1 THEN 1 ELSE 0 END) AS solo,
            SUM(CASE WHEN b.total_travellers = 2 THEN 1 ELSE 0 END) AS couple,
            SUM(CASE WHEN b.total_travellers BETWEEN 3 AND 5 THEN 1 ELSE 0 END) AS small_group,
            SUM(CASE WHEN b.total_travellers > 5 THEN 1 ELSE 0 END) AS large_group
           FROM bookings b ${where}`,
        params
      ),
      pool.query(
        `SELECT DAYOFWEEK(b.created_at) AS dow, COUNT(*) AS bookings,
                COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0) AS revenue
           FROM bookings b ${where} GROUP BY DAYOFWEEK(b.created_at) ORDER BY dow ASC`,
        params
      ),
      pool.query(
        `SELECT DATE(b.created_at) AS day, COUNT(*) AS bookings,
                COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0) AS revenue
           FROM bookings b ${where}
          GROUP BY DATE(b.created_at) ORDER BY revenue DESC, bookings DESC LIMIT 1`,
        params
      ),
      // How far ahead people book — useful for a destination business.
      pool.query(
        `SELECT
            SUM(CASE WHEN d < 0 THEN 1 ELSE 0 END)              AS same_or_past,
            SUM(CASE WHEN d BETWEEN 0 AND 7 THEN 1 ELSE 0 END)  AS within_week,
            SUM(CASE WHEN d BETWEEN 8 AND 30 THEN 1 ELSE 0 END) AS within_month,
            SUM(CASE WHEN d BETWEEN 31 AND 90 THEN 1 ELSE 0 END) AS one_to_three,
            SUM(CASE WHEN d > 90 THEN 1 ELSE 0 END)             AS over_three,
            ROUND(AVG(d), 1)                                     AS average_days
           FROM (
             SELECT DATEDIFF(COALESCE(b.check_in_date, b.travel_date), DATE(b.created_at)) AS d
               FROM bookings b ${where}
           ) AS lead_days
          WHERE d IS NOT NULL`,
        params
      ),
      // Funnel lives in payment_orders — bookings only exist after payment.
      pool.query(
        `SELECT
            COUNT(*) AS started,
            SUM(CASE WHEN status <> 'created' THEN 1 ELSE 0 END) AS reached_gateway,
            SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
            SUM(CASE WHEN status IN ('created','redirected') THEN 1 ELSE 0 END) AS abandoned,
            COALESCE(SUM(CASE WHEN status IN ('created','redirected') THEN amount ELSE 0 END), 0) AS abandoned_value,
            SUM(CASE WHEN status IN ('declined','error','cancelled') THEN 1 ELSE 0 END) AS failed
           FROM payment_orders`
      ),
    ]);

    const num = (v) => Number(v || 0);
    const t = totals.rows[0] || {};
    const f = funnel.rows[0] || {};
    const p = partySize.rows[0] || {};
    const lead = leadTime.rows[0] || {};

    const statusMap = statusRows.rows.reduce((acc, r) => {
      acc[r.status] = num(r.count);
      return acc;
    }, {});

    const total = num(t.total);
    const started = num(f.started);

    // Optional previous-period comparison, same window length, shifted back.
    let previous = null;
    if (compare && periodDays) {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN payment_amount ELSE 0 END), 0) AS revenue,
                COALESCE(SUM(total_travellers), 0) AS travellers
           FROM bookings
          WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${periodDays * 2} DAY)
            AND created_at <  DATE_SUB(CURDATE(), INTERVAL ${periodDays} DAY)`
      );
      previous = {
        total: num(rows[0]?.total),
        revenue: num(rows[0]?.revenue),
        travellers: num(rows[0]?.travellers),
        windowDays: periodDays,
      };
    }

    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weekdays = weekday.rows.map((r) => ({
      day: DAY_NAMES[num(r.dow) - 1] || 'Unknown',
      bookings: num(r.bookings),
      revenue: num(r.revenue),
    }));
    const bestWeekday = [...weekdays].sort((a, b) => b.revenue - a.revenue)[0] || null;

    sendSuccess(
      res,
      {
        counters: {
          total,
          confirmed: num(t.confirmed),
          completed: num(t.completed),
          cancelled: num(t.cancelled),
          paid: num(t.paid),
          travellers: num(t.travellers),
          revenue: num(t.revenue),
          avgTravellers: total > 0 ? Number((num(t.travellers) / total).toFixed(2)) : 0,
          avgValue: num(t.paid) > 0 ? Number((num(t.revenue) / num(t.paid)).toFixed(2)) : 0,
          cancellationRate: total > 0 ? Number(((num(t.cancelled) / total) * 100).toFixed(1)) : 0,
        },
        funnel: {
          started,
          reachedGateway: num(f.reached_gateway),
          paid: num(f.paid),
          abandoned: num(f.abandoned),
          abandonedValue: num(f.abandoned_value),
          failed: num(f.failed),
          conversion: started > 0 ? Number(((num(f.paid) / started) * 100).toFixed(1)) : 0,
          gatewayReachRate:
            started > 0 ? Number(((num(f.reached_gateway) / started) * 100).toFixed(1)) : 0,
        },
        overTime: daily.rows.map((r) => ({
          day: r.day,
          bookings: num(r.bookings),
          revenue: num(r.revenue),
          travellers: num(r.travellers),
        })),
        status: {
          confirmed: statusMap.confirmed || 0,
          pendingSupplier: statusMap.pending_supplier || 0,
          completed: statusMap.completed || 0,
          cancelled: (statusMap.cancelled || 0) + (statusMap.refunded || 0),
        },
        byType: byType.rows.map((r) => ({
          type: r.booking_type,
          count: num(r.count),
          revenue: num(r.revenue),
        })),
        topProducts: topProducts.rows.map((r) => ({
          title: r.product_title,
          type: r.booking_type,
          count: num(r.count),
          travellers: num(r.travellers),
          revenue: num(r.revenue),
        })),
        partySize: {
          solo: num(p.solo),
          couple: num(p.couple),
          smallGroup: num(p.small_group),
          largeGroup: num(p.large_group),
        },
        leadTime: {
          sameOrPast: num(lead.same_or_past),
          withinWeek: num(lead.within_week),
          withinMonth: num(lead.within_month),
          oneToThreeMonths: num(lead.one_to_three),
          overThreeMonths: num(lead.over_three),
          averageDays: num(lead.average_days),
        },
        peak: {
          bestWeekday,
          weekdays,
          topDay: topDay.rows[0]
            ? {
                day: topDay.rows[0].day,
                bookings: num(topDay.rows[0].bookings),
                revenue: num(topDay.rows[0].revenue),
              }
            : null,
        },
        previous,
        currency: 'EUR',
      },
      'Booking analytics retrieved'
    );
  } catch (err) {
    console.error('booking analytics error:', err);
    sendError(res, err, 'Failed to load booking analytics', 500);
  }
});

/**
 * Booking timeline.
 *
 * Assembled from what actually happened rather than stored as its own log:
 * the booking's own timestamps, the gateway attempts against its payment
 * reference, and the refund events. Nothing here is written, so the timeline
 * can never drift from the record it describes.
 */
router.get('/:bookingId/timeline', adminAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;

    const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (!rows.length) return sendError(res, null, 'Booking not found', 404);
    const b = rows[0];

    const [attempts, refunds, emails] = await Promise.all([
      pool.query(
        `SELECT decision, gateway, gateway_reference, amount, currency, message,
                signature_valid, created_at
           FROM payment_attempts
          WHERE booking_id = $1 OR gateway_reference = $2
          ORDER BY created_at ASC`,
        [bookingId, b.payment_reference]
      ),
      pool.query(
        `SELECT action, amount, currency, gateway_reference, notes, created_at
           FROM refund_events WHERE booking_id = $1 ORDER BY created_at ASC`,
        [bookingId]
      ),
      pool.query(
        `SELECT kind, recipient, status, error, sent_at
           FROM email_notifications WHERE booking_id = $1 ORDER BY sent_at ASC`,
        [bookingId]
      ),
    ]);

    const events = [];
    const push = (at, type, title, detail, tone = 'neutral') => {
      if (!at) return;
      events.push({ at, type, title, detail, tone });
    };

    push(b.created_at, 'created', 'Booking created', `Reference ${b.booking_reference}`, 'info');

    for (const a of attempts.rows) {
      if (!a.signature_valid && a.decision === 'INVALID_SIGNATURE') {
        push(
          a.created_at,
          'payment',
          'Payment callback rejected',
          'Signature did not verify — ignored',
          'critical'
        );
      } else {
        push(
          a.created_at,
          'payment',
          `Payment ${String(a.decision || '').toLowerCase()}`,
          `${a.currency || ''} ${a.amount || ''} · ${a.gateway_reference || ''}`.trim(),
          a.decision === 'ACCEPT' ? 'good' : 'critical'
        );
      }
    }

    if (b.payment_status === 'paid') {
      push(
        b.created_at,
        'paid',
        'Payment captured',
        `${b.currency} ${Number(b.payment_amount).toFixed(2)} via ${b.payment_gateway || 'gateway'}`,
        'good'
      );
    }

    if (b.supplier_status && b.supplier_status !== 'not_applicable') {
      const tone =
        b.supplier_status === 'confirmed'
          ? 'good'
          : b.supplier_status === 'commit_failed'
            ? 'critical'
            : 'warning';
      push(
        b.updated_at,
        'supplier',
        `Supplier: ${String(b.supplier_status).replace(/_/g, ' ')}`,
        b.supplier_reference ? `Reference ${b.supplier_reference}` : null,
        tone
      );
    }

    if (b.voucher_generated_at) {
      push(b.voucher_generated_at, 'voucher', 'Voucher generated', b.voucher_path, 'info');
    }

    for (const e of emails.rows) {
      push(
        e.sent_at,
        'email',
        `Email: ${String(e.kind).replace(/_/g, ' ')}`,
        e.status === 'sent' ? `Sent to ${e.recipient}` : `Failed — ${e.error || 'unknown'}`,
        e.status === 'sent' ? 'good' : 'critical'
      );
    }

    for (const r of refunds.rows) {
      push(
        r.created_at,
        'refund',
        `Refund ${String(r.action).replace(/_/g, ' ')}`,
        [r.amount ? `${r.currency || ''} ${r.amount}` : null, r.notes].filter(Boolean).join(' · '),
        r.action === 'completed' ? 'good' : r.action === 'gateway_failed' ? 'critical' : 'info'
      );
    }

    if (b.cancelled_at) {
      push(
        b.cancelled_at,
        'cancelled',
        `Cancelled by ${b.cancelled_by || 'admin'}`,
        b.cancellation_reason,
        'critical'
      );
    }

    events.sort((x, y) => new Date(x.at) - new Date(y.at));

    sendSuccess(res, { events }, 'Timeline retrieved');
  } catch (err) {
    console.error('booking timeline error:', err);
    sendError(res, err, 'Failed to load the timeline', 500);
  }
});

/**
 * Manual supplier override.
 *
 * When TourVisio has been sorted out by hand (an agent phoned the hotel, the
 * agency credit was topped up), the operator records the real outcome here.
 * It does not call the supplier — it records what a human already did, which is
 * why the reason is mandatory and the change is audited.
 */
router.post(
  '/:bookingId/supplier',
  adminAuth,
  body('supplier_status').isIn([
    'confirmed',
    'awaiting_agency_payment',
    'commit_failed',
    'commit_unconfirmed',
    'not_applicable',
  ]),
  body('supplier_reference').optional().trim(),
  body('reason').trim().isLength({ min: 3 }).withMessage('Say why this was changed'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    }

    try {
      const { bookingId } = req.params;
      const { supplier_status, supplier_reference, reason } = req.body;

      const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
      if (!rows.length) return sendError(res, null, 'Booking not found', 404);
      const before = rows[0];

      // A confirmed supplier means the booking itself is confirmed again.
      const nextStatus =
        supplier_status === 'confirmed' && before.status === 'pending_supplier'
          ? 'confirmed'
          : before.status;

      const { rows: updated } = await pool.query(
        `UPDATE bookings
            SET supplier_status = $1,
                supplier_reference = COALESCE($2, supplier_reference),
                status = $3,
                admin_notes = CONCAT(COALESCE(admin_notes, ''), $4),
                updated_at = NOW()
          WHERE id = $5
          RETURNING id, booking_reference, status, supplier_status, supplier_reference, admin_notes`,
        [
          supplier_status,
          supplier_reference || null,
          nextStatus,
          `\n[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] Supplier set to ${supplier_status}: ${reason}`,
          bookingId,
        ]
      );

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.bookings.supplier_override',
        entityType: 'booking',
        entityId: before.booking_reference,
        summary: `Supplier status ${before.supplier_status || 'none'} → ${supplier_status}`,
        metadata: { reason, supplier_reference: supplier_reference || null },
      });

      sendSuccess(res, updated[0], 'Supplier status updated');
    } catch (err) {
      console.error('supplier override error:', err);
      sendError(res, err, 'Failed to update supplier status', 500);
    }
  }
);

/**
 * Bulk actions over selected rows.
 *
 * Refunds are deliberately NOT bulk-able — moving money needs the per-booking
 * screen where the amount and reason are in front of you.
 */
router.post(
  '/bulk',
  adminAuth,
  body('ids').isArray({ min: 1, max: 200 }).withMessage('Select at least one booking'),
  body('action').isIn(['confirm', 'complete', 'cancel', 'resend_voucher']),
  body('reason').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    }

    const { ids, action, reason } = req.body;
    const clean = ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
    if (!clean.length) return sendError(res, null, 'No valid bookings selected', 400);

    const results = { updated: 0, skipped: 0, failed: 0, details: [] };

    try {
      for (const id of clean) {
        const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
        if (!rows.length) {
          results.failed += 1;
          results.details.push({ id, outcome: 'not found' });
          continue;
        }
        const b = rows[0];

        try {
          if (action === 'resend_voucher') {
            if (b.payment_status !== 'paid') {
              results.skipped += 1;
              results.details.push({ id, reference: b.booking_reference, outcome: 'not paid' });
              continue;
            }
            const { absolutePath, relativePath } = await generateVoucherPDF(b);
            await pool.query(
              'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
              [relativePath, id]
            );
            await sendVoucherEmail(b, absolutePath);
            results.updated += 1;
            results.details.push({ id, reference: b.booking_reference, outcome: 'voucher sent' });
            continue;
          }

          // Never walk a cancelled or refunded booking back to active.
          if (['cancelled', 'refunded'].includes(b.status) && action !== 'cancel') {
            results.skipped += 1;
            results.details.push({ id, reference: b.booking_reference, outcome: `already ${b.status}` });
            continue;
          }

          const nextStatus =
            action === 'confirm' ? 'confirmed' : action === 'complete' ? 'completed' : 'cancelled';

          if (b.status === nextStatus) {
            results.skipped += 1;
            results.details.push({ id, reference: b.booking_reference, outcome: 'no change' });
            continue;
          }

          await pool.query(
            `UPDATE bookings
                SET status = $1,
                    cancelled_at = CASE WHEN $1 = 'cancelled' THEN NOW() ELSE cancelled_at END,
                    cancelled_by = CASE WHEN $1 = 'cancelled' THEN 'admin' ELSE cancelled_by END,
                    cancellation_reason = CASE WHEN $1 = 'cancelled' THEN $2 ELSE cancellation_reason END,
                    updated_at = NOW()
              WHERE id = $3`,
            [nextStatus, reason || null, id]
          );

          results.updated += 1;
          results.details.push({ id, reference: b.booking_reference, outcome: nextStatus });
        } catch (err) {
          results.failed += 1;
          results.details.push({ id, reference: b.booking_reference, outcome: err.message });
        }
      }

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: `admin.bookings.bulk_${action}`,
        summary: `${action} on ${clean.length} booking(s): ${results.updated} changed, ${results.skipped} skipped, ${results.failed} failed`,
        metadata: { ids: clean, reason: reason || null },
        status: results.failed ? 'failed' : 'success',
      });

      sendSuccess(
        res,
        results,
        `${results.updated} updated, ${results.skipped} skipped${results.failed ? `, ${results.failed} failed` : ''}`
      );
    } catch (err) {
      console.error('bulk booking action error:', err);
      sendError(res, err, 'Bulk action failed', 500);
    }
  }
);

// Get booking detail with user info
router.get('/:bookingId', adminAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;

    const { rows: bookingRows } = await pool.query(
      `SELECT b.*, u.email as user_email, u.first_middle_name, u.last_name, u.mobile_number, u.nationality
       FROM bookings b
       LEFT JOIN users u ON b.user_id = u.id
       WHERE b.id = $1`,
      [bookingId]
    );

    if (bookingRows.length === 0) {
      return sendError(res, null, 'Booking not found', 404);
    }

    const booking = bookingRows[0];

    // Get all user bookings for context
    const { rows: userBookings } = booking.user_id
      ? await pool.query(
          'SELECT id, booking_reference, status, created_at FROM bookings WHERE user_id = $1 ORDER BY created_at DESC',
          [booking.user_id]
        )
      : { rows: [] };

    sendSuccess(
      res,
      { booking, userBookings },
      'Booking retrieved successfully'
    );
  } catch (err) {
    console.error('get booking detail error:', err);
    sendError(res, err, 'Failed to get booking details', 500);
  }
});

// Update booking status and admin notes
router.patch('/:bookingId', adminAuth, 
  body('status').optional().isIn(['confirmed', 'cancelled', 'refunded', 'pending', 'completed', 'pending_supplier']),
  body('admin_notes').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { bookingId } = req.params;
      const { status, admin_notes } = req.body;

      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (status) {
        updates.push(`status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }

      if (admin_notes !== undefined) {
        updates.push(`admin_notes = $${paramIndex}`);
        params.push(admin_notes);
        paramIndex++;
      }

      if (updates.length === 0) {
        return sendError(res, null, 'No fields to update', 400);
      }

      updates.push(`updated_at = NOW()`);
      params.push(bookingId);

      const { rows } = await pool.query(
        `UPDATE bookings SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        params
      );

      if (rows.length === 0) {
        return sendError(res, null, 'Booking not found', 404);
      }

      sendSuccess(res, rows[0], 'Booking updated successfully');
    } catch (err) {
      console.error('update booking error:', err);
      sendError(res, err, 'Failed to update booking', 500);
    }
  }
);

// Generate voucher PDF (and optionally email it).
// Body: { email: true } to also send the voucher to the lead guest.
router.post('/:bookingId/voucher', adminAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const shouldEmail = req.body?.email === true || req.body?.email === 'true';

    const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);

    if (rows.length === 0) {
      return sendError(res, null, 'Booking not found', 404);
    }

    const booking = rows[0];
    const { absolutePath, relativePath } = await generateVoucherPDF(booking);

    await pool.query(
      'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
      [relativePath, bookingId]
    );

    let emailResult = null;
    if (shouldEmail && booking.lead_email) {
      emailResult = await sendVoucherEmail(booking, absolutePath);
    }

    sendSuccess(
      res,
      { voucherPath: relativePath, emailed: !!emailResult?.success, emailError: emailResult?.error || null },
      shouldEmail ? 'Voucher generated and emailed' : 'Voucher generated successfully'
    );
  } catch (err) {
    console.error('voucher endpoint error:', err);
    sendError(res, err, 'Failed to generate voucher', 500);
  }
});

// Resend voucher email — regenerates PDF and emails to lead guest.
router.post('/:bookingId/resend-voucher', adminAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const overrideEmail = req.body?.email && typeof req.body.email === 'string' ? req.body.email.trim() : null;

    const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (rows.length === 0) {
      return sendError(res, null, 'Booking not found', 404);
    }

    const booking = rows[0];
    const recipient = overrideEmail || booking.lead_email;
    if (!recipient) {
      return sendError(res, null, 'No recipient email available', 400);
    }

    const { absolutePath, relativePath } = await generateVoucherPDF(booking);
    await pool.query(
      'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
      [relativePath, bookingId]
    );

    const result = await sendVoucherEmail({ ...booking, lead_email: recipient }, absolutePath);
    if (!result.success) {
      return sendError(res, null, `Failed to send email: ${result.error}`, 502);
    }

    sendSuccess(res, { voucherPath: relativePath, sentTo: recipient }, 'Voucher resent successfully');
  } catch (err) {
    console.error('resend voucher error:', err);
    sendError(res, err, 'Failed to resend voucher', 500);
  }
});

// Initiate / process a refund for a booking.
// Body: { amount?: number, reason?: string, notify?: boolean }
router.post(
  '/:bookingId/refund',
  adminAuth,
  body('amount').optional().isFloat({ min: 0.01 }),
  body('reason').optional().trim(),
  body('notify').optional().isBoolean(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    const client = await pool.connect();
    try {
      const { bookingId } = req.params;
      const { amount: amountReq, reason, notify = true } = req.body || {};

      await client.query('BEGIN');

      const { rows } = await client.query(
        'SELECT * FROM bookings WHERE id = $1 FOR UPDATE',
        [bookingId]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return sendError(res, null, 'Booking not found', 404);
      }
      const booking = rows[0];

      const eligibility = evaluateRefund(booking);
      // Admin can override an expired window by passing { force: true } in the body.
      // is_refundable === false is *not* overridable from this endpoint — that's a supplier rule.
      const adminForce = req.body?.force === true || req.body?.force === 'true';
      if (!eligibility.eligible) {
        const overridable = eligibility.expired === true;
        if (!(overridable && adminForce)) {
          await client.query('ROLLBACK');
          return sendError(
            res,
            null,
            overridable
              ? `${eligibility.reason}. Pass { "force": true } to override as admin.`
              : eligibility.reason,
            eligibility.alreadyRefunded ? 409 : 409
          );
        }
      }

      const refundAmount = amountReq != null ? Number(amountReq) : Number(booking.payment_amount);
      const paid = Number(booking.payment_amount || 0);
      if (refundAmount <= 0 || refundAmount > paid) {
        await client.query('ROLLBACK');
        return sendError(res, null, `Refund amount must be between 0 and ${paid}`, 400);
      }

      // Audit: requested
      await client.query(
        `INSERT INTO refund_events (booking_id, admin_id, action, amount, currency, notes, payload)
         VALUES ($1, $2, 'requested', $3, $4, $5, $6)`,
        [bookingId, req.admin?.id || null, refundAmount, booking.currency, reason || null, JSON.stringify({ initiatedBy: req.admin?.email || 'admin' })]
      );

      // Call gateway (simulated unless CYBERSOURCE_REFUND_LIVE=true and creds wired)
      const gateway = await processRefund({
        paymentReference: booking.payment_reference,
        amount: refundAmount,
        currency: booking.currency,
      });

      if (!gateway.success) {
        await client.query(
          `INSERT INTO refund_events (booking_id, admin_id, action, amount, currency, notes, payload)
           VALUES ($1, $2, 'gateway_failed', $3, $4, $5, $6)`,
          [bookingId, req.admin?.id || null, refundAmount, booking.currency, gateway.error, JSON.stringify(gateway)]
        );
        await client.query('COMMIT');
        return sendError(res, null, `Gateway refund failed: ${gateway.error}`, 502);
      }

      await client.query(
        `INSERT INTO refund_events (booking_id, admin_id, action, amount, currency, gateway_reference, notes, payload)
         VALUES ($1, $2, 'gateway_initiated', $3, $4, $5, $6, $7)`,
        [bookingId, req.admin?.id || null, refundAmount, booking.currency, gateway.gatewayReference, gateway.simulated ? 'SIMULATED (live mode disabled)' : 'live gateway', JSON.stringify(gateway)]
      );

      // Update booking row
      const isFullRefund = Math.abs(refundAmount - paid) < 0.005;
      const { rows: updated } = await client.query(
        `UPDATE bookings SET
            status = 'refunded',
            payment_status = 'refunded',
            refund_amount = $1,
            refund_currency = $2,
            refund_reason = $3,
            refund_reference = $4,
            refund_initiated_at = COALESCE(refund_initiated_at, NOW()),
            refund_completed_at = NOW(),
            refunded_by_admin_id = $5,
            updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [refundAmount, booking.currency, reason || null, gateway.gatewayReference, req.admin?.id || null, bookingId]
      );

      await client.query(
        `INSERT INTO refund_events (booking_id, admin_id, action, amount, currency, gateway_reference, notes)
         VALUES ($1, $2, 'completed', $3, $4, $5, $6)`,
        [bookingId, req.admin?.id || null, refundAmount, booking.currency, gateway.gatewayReference, isFullRefund ? 'Full refund' : 'Partial refund']
      );

      await client.query('COMMIT');

      // Email user (fire-and-forget)
      let emailResult = { success: false };
      if (notify && updated[0].lead_email) {
        emailResult = await sendRefundEmail(updated[0], {
          amount: refundAmount,
          currency: booking.currency,
          reason: reason || null,
          gatewayReference: gateway.gatewayReference,
        });
      }

      sendSuccess(
        res,
        {
          booking: updated[0],
          gateway: { simulated: !!gateway.simulated, reference: gateway.gatewayReference, live: cybersourceLive },
          emailed: !!emailResult.success,
        },
        gateway.simulated
          ? 'Refund recorded (simulated; live gateway disabled).'
          : 'Refund processed successfully.'
      );
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      console.error('refund error:', err);
      sendError(res, err, 'Failed to process refund', 500);
    } finally {
      client.release();
    }
  }
);

// Get refund history for a booking
router.get('/:bookingId/refunds', adminAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { rows } = await pool.query(
      `SELECT id, action, amount, currency, gateway_reference, notes, payload, created_at, admin_id
       FROM refund_events WHERE booking_id = $1 ORDER BY created_at DESC`,
      [bookingId]
    );
    sendSuccess(res, { events: rows }, 'Refund events retrieved');
  } catch (err) {
    console.error('refund history error:', err);
    sendError(res, err, 'Failed to load refund events', 500);
  }
});

module.exports = router;
