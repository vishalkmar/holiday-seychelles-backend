/**
 * Payment ledger.
 *
 * One row per movement of money: a PAYMENT for every paid booking, a REFUND for
 * every completed refund. Attempts that never became money (abandoned
 * checkouts, declines, forged callbacks) are deliberately NOT ledger entries —
 * they live in the audit and fraud views, because mixing "nearly paid" into a
 * ledger is how reconciliation goes wrong.
 *
 * `bookings` is the source of truth for money received: a booking row only
 * exists once the gateway confirmed, and it survives even when the supplier
 * side later fails. `payment_orders` and `payment_attempts` are joined in for
 * the gateway detail (card, auth code, order reference).
 */

const express = require('express');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');

const router = express.Router();

const PERIODS = {
  today: 'DATE(t.occurred_at) = CURDATE()',
  yesterday: 'DATE(t.occurred_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)',
  last7: 't.occurred_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)',
  last30: 't.occurred_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)',
  this_month: "t.occurred_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')",
  last_month:
    "t.occurred_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01') " +
    "AND t.occurred_at < DATE_FORMAT(CURDATE(), '%Y-%m-01')",
  last3: 't.occurred_at >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)',
  last6: 't.occurred_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)',
  this_year: 'YEAR(t.occurred_at) = YEAR(CURDATE())',
  last_year: 'YEAR(t.occurred_at) = YEAR(CURDATE()) - 1',
};

const AMOUNT_BANDS = {
  under_100: 't.amount < 100',
  '100_500': 't.amount >= 100 AND t.amount < 500',
  '500_1000': 't.amount >= 500 AND t.amount < 1000',
  over_1000: 't.amount >= 1000',
};

/**
 * The ledger as a derived table, so filters and totals can be written once
 * against a single shape regardless of which side a row came from.
 */
const LEDGER_SOURCE = `
  SELECT
      CONCAT('P', b.id)                AS entry_id,
      'payment'                        AS entry_type,
      b.id                             AS booking_id,
      b.booking_reference,
      b.created_at                     AS occurred_at,
      b.payment_amount                 AS amount,
      b.currency,
      b.payment_gateway                AS gateway,
      b.payment_reference              AS gateway_reference,
      b.booking_type,
      b.product_title,
      b.lead_first_name, b.lead_last_name, b.lead_email, b.lead_mobile,
      b.user_id,
      b.status                         AS booking_status,
      b.payment_status
    FROM bookings b
   WHERE b.payment_status IN ('paid', 'refunded')

  UNION ALL

  SELECT
      CONCAT('R', b.id)                AS entry_id,
      'refund'                         AS entry_type,
      b.id                             AS booking_id,
      b.booking_reference,
      COALESCE(b.refund_completed_at, b.refund_initiated_at, b.updated_at) AS occurred_at,
      -b.refund_amount                 AS amount,
      COALESCE(b.refund_currency, b.currency) AS currency,
      b.payment_gateway                AS gateway,
      b.refund_reference               AS gateway_reference,
      b.booking_type,
      b.product_title,
      b.lead_first_name, b.lead_last_name, b.lead_email, b.lead_mobile,
      b.user_id,
      b.status                         AS booking_status,
      b.payment_status
    FROM bookings b
   WHERE b.refund_amount IS NOT NULL AND b.refund_amount > 0
`;

/** Build the WHERE clause shared by the list, the totals and the export. */
function buildLedgerFilter(query = {}) {
  const conditions = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };

  if (query.entry_type) add('t.entry_type = ?', query.entry_type);
  if (query.booking_type) add('t.booking_type = ?', query.booking_type);
  if (query.gateway) add('t.gateway = ?', query.gateway);
  if (query.period && PERIODS[query.period]) conditions.push(PERIODS[query.period]);
  if (query.band && AMOUNT_BANDS[query.band]) conditions.push(AMOUNT_BANDS[query.band]);
  if (query.from) add('DATE(t.occurred_at) >= ?', query.from);
  if (query.to) add('DATE(t.occurred_at) <= ?', query.to);
  if (query.min_amount) add('ABS(t.amount) >= ?', Number(query.min_amount));
  if (query.max_amount) add('ABS(t.amount) <= ?', Number(query.max_amount));

  if (query.search) {
    params.push(`%${query.search}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(t.booking_reference LIKE ${p} OR t.gateway_reference LIKE ${p} OR t.lead_email LIKE ${p} ` +
        `OR t.lead_first_name LIKE ${p} OR t.lead_last_name LIKE ${p} OR t.product_title LIKE ${p})`
    );
  }

  return {
    where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

const SORTS = {
  date_desc: 't.occurred_at DESC',
  date_asc: 't.occurred_at ASC',
  amount_desc: 'ABS(t.amount) DESC',
  amount_asc: 'ABS(t.amount) ASC',
};

const num = (v) => Number(v || 0);

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
    const offset = (page - 1) * limit;
    const order = SORTS[req.query.sort] || SORTS.date_desc;

    const { where, params } = buildLedgerFilter(req.query);
    // The JOIN has to sit before WHERE — appending it after the filter is valid
    // only while the filter is empty, which is exactly the case that hides the bug.
    const ledgerWithUser = `FROM (${LEDGER_SOURCE}) AS t LEFT JOIN users u ON u.id = t.user_id ${where}`;
    const ledger = `FROM (${LEDGER_SOURCE}) AS t ${where}`;

    const [rows, totals, pending, gateways, daily, pendingDaily] = await Promise.all([
      pool.query(
        `SELECT t.*, u.email AS account_email
           ${ledgerWithUser}
          ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(CASE WHEN t.entry_type = 'payment' THEN t.amount ELSE 0 END), 0) AS collected,
                COALESCE(SUM(CASE WHEN t.entry_type = 'refund' THEN ABS(t.amount) ELSE 0 END), 0) AS refunded,
                COALESCE(SUM(t.amount), 0) AS net,
                SUM(CASE WHEN t.entry_type = 'payment' THEN 1 ELSE 0 END) AS payment_count,
                SUM(CASE WHEN t.entry_type = 'refund' THEN 1 ELSE 0 END) AS refund_count
           ${ledger}`,
        params
      ),
      // Money not collected yet — an order that never completed.
      pool.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS value
           FROM payment_orders WHERE status IN ('created', 'redirected')`
      ),
      pool.query(`SELECT DISTINCT gateway FROM (${LEDGER_SOURCE}) AS t WHERE t.gateway IS NOT NULL`),
      pool.query(
        `SELECT DATE(t.occurred_at) AS day,
                SUM(CASE WHEN t.entry_type = 'payment' THEN t.amount ELSE 0 END) AS collected,
                SUM(CASE WHEN t.entry_type = 'refund' THEN ABS(t.amount) ELSE 0 END) AS refunded,
                SUM(t.amount) AS net
           ${ledger} GROUP BY DATE(t.occurred_at) ORDER BY day DESC LIMIT 14`, params
      ),
      pool.query(`SELECT DATE(created_at) AS day, SUM(amount) AS pending
                    FROM payment_orders WHERE status IN ('created', 'redirected')
                   GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 14`),
    ]);

    const t = totals.rows[0] || {};
    const entries = num(t.entries);

    sendSuccess(
      res,
      {
        entries: rows.rows,
        total: entries,
        page,
        limit,
        pages: Math.max(1, Math.ceil(entries / limit)),
        stats: {
          trends: {
            ...Object.fromEntries(['collected', 'refunded', 'net'].map((key) => [key, [...daily.rows].reverse().map((row) => num(row[key]))])),
            pending: [...pendingDaily.rows].reverse().map((row) => num(row.pending)),
          },
          collected: num(t.collected),
          refunded: num(t.refunded),
          net: num(t.net),
          pending: num(pending.rows[0]?.value),
          pendingCount: num(pending.rows[0]?.count),
          paymentCount: num(t.payment_count),
          refundCount: num(t.refund_count),
        },
        gateways: gateways.rows.map((g) => g.gateway).filter(Boolean),
        currency: rows.rows[0]?.currency || 'EUR',
      },
      'Ledger retrieved'
    );
  } catch (err) {
    console.error('transactions list error:', err);
    sendError(res, err, 'Failed to load the ledger', 500);
  }
});

// ── GET /export ──────────────────────────────────────────────────────────────
router.get('/export', adminAuth, async (req, res) => {
  try {
    const { where, params } = buildLedgerFilter(req.query);
    const order = SORTS[req.query.sort] || SORTS.date_desc;

    const { rows } = await pool.query(
      `SELECT t.* FROM (${LEDGER_SOURCE}) AS t ${where} ORDER BY ${order} LIMIT 10000`,
      params
    );

    const columns = [
      ['Date', (r) => (r.occurred_at ? new Date(r.occurred_at).toISOString().slice(0, 19).replace('T', ' ') : '')],
      ['Type', (r) => r.entry_type],
      ['Booking', (r) => r.booking_reference],
      ['Customer', (r) => `${r.lead_first_name || ''} ${r.lead_last_name || ''}`.trim()],
      ['Email', (r) => r.lead_email],
      ['Product', (r) => r.product_title],
      ['Booking type', (r) => r.booking_type],
      ['Gateway', (r) => r.gateway],
      ['Reference', (r) => r.gateway_reference],
      ['Amount', (r) => r.amount],
      ['Currency', (r) => r.currency],
      ['Booking status', (r) => r.booking_status],
    ];

    const csv = [
      columns.map((c) => c[0]).join(','),
      ...rows.map((r) => columns.map((c) => csvCell(c[1](r))).join(',')),
    ].join('\r\n');

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.transactions.export',
      summary: `Exported ${rows.length} ledger entries`,
      metadata: { filters: req.query },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ledger-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send('﻿' + csv);
  } catch (err) {
    console.error('ledger export error:', err);
    sendError(res, err, 'Failed to export the ledger', 500);
  }
});

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

// ── GET /reconciliation ──────────────────────────────────────────────────────
/**
 * Does what we think we collected match what the gateway says?
 *
 * Our side: paid bookings. Gateway side: accepted, signature-verified callbacks.
 * Anything in one and not the other is what an operator needs to see.
 */
router.get('/reconciliation', adminAuth, async (req, res) => {
  try {
    const [ours, theirs, orphanAttempts, unmatchedBookings, mismatches] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(payment_amount), 0) AS total
           FROM bookings WHERE payment_status IN ('paid','refunded')`
      ),
      pool.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
           FROM payment_attempts
          WHERE decision = 'ACCEPT' AND signature_valid = 1`
      ),
      // Gateway said yes, but we have no booking for it.
      pool.query(
        `SELECT a.gateway_reference, a.amount, a.currency, a.created_at
           FROM payment_attempts a
          WHERE a.decision = 'ACCEPT' AND a.signature_valid = 1
            AND NOT EXISTS (
              SELECT 1 FROM bookings b WHERE b.payment_reference = a.gateway_reference
            )
          ORDER BY a.created_at DESC LIMIT 50`
      ),
      // We have a paid booking with no verified gateway callback behind it.
      pool.query(
        `SELECT b.booking_reference, b.payment_reference, b.payment_amount, b.currency, b.created_at
           FROM bookings b
          WHERE b.payment_status = 'paid'
            AND NOT EXISTS (
              SELECT 1 FROM payment_attempts a
               WHERE a.gateway_reference = b.payment_reference
                 AND a.decision = 'ACCEPT' AND a.signature_valid = 1
            )
          ORDER BY b.created_at DESC LIMIT 50`
      ),
      // Same reference, different amount.
      pool.query(
        `SELECT b.booking_reference, b.payment_reference, b.payment_amount AS our_amount,
                a.amount AS gateway_amount, b.currency
           FROM bookings b
           JOIN payment_attempts a ON a.gateway_reference = b.payment_reference
          WHERE a.decision = 'ACCEPT' AND a.signature_valid = 1
            AND ABS(a.amount - b.payment_amount) > 0.01
          LIMIT 50`
      ),
    ]);

    const ourTotal = num(ours.rows[0]?.total);
    const theirTotal = num(theirs.rows[0]?.total);

    sendSuccess(
      res,
      {
        ours: { count: num(ours.rows[0]?.count), total: ourTotal },
        gateway: { count: num(theirs.rows[0]?.count), total: theirTotal },
        difference: Number((ourTotal - theirTotal).toFixed(2)),
        balanced: Math.abs(ourTotal - theirTotal) < 0.01,
        orphanAttempts: orphanAttempts.rows,
        unmatchedBookings: unmatchedBookings.rows,
        amountMismatches: mismatches.rows,
      },
      'Reconciliation retrieved'
    );
  } catch (err) {
    console.error('reconciliation error:', err);
    sendError(res, err, 'Failed to reconcile', 500);
  }
});

// ── GET /fraud ───────────────────────────────────────────────────────────────
/**
 * Payment-side fraud signals. This is the half of Module 2's fraud screen that
 * needed the ledger to exist.
 */
router.get('/fraud', adminAuth, async (req, res) => {
  try {
    const [rejected, declines, repeatFailures, summary] = await Promise.all([
      // Callbacks whose signature did not verify — someone posting to our
      // receipt endpoint directly.
      pool.query(
        `SELECT id, transaction_uuid, gateway_reference, amount, currency, message, created_at
           FROM payment_attempts WHERE signature_valid = 0
          ORDER BY created_at DESC LIMIT 50`
      ),
      pool.query(
        `SELECT o.order_reference, o.amount, o.currency, o.decision, o.gateway_message,
                o.lead_email, o.client_ip, o.created_at
           FROM payment_orders o
          WHERE o.status IN ('declined', 'error')
          ORDER BY o.created_at DESC LIMIT 50`
      ),
      // The same customer failing repeatedly is the classic card-testing shape.
      pool.query(
        `SELECT lead_email, COUNT(*) AS failures,
                COALESCE(SUM(amount), 0) AS value, MAX(created_at) AS last_attempt
           FROM payment_orders
          WHERE status IN ('declined', 'error')
            AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          GROUP BY lead_email HAVING failures >= 2
          ORDER BY failures DESC LIMIT 20`
      ),
      pool.query(
        `SELECT
            (SELECT COUNT(*) FROM payment_attempts WHERE signature_valid = 0) AS rejected_callbacks,
            (SELECT COUNT(*) FROM payment_orders WHERE status IN ('declined','error')) AS failed_payments,
            (SELECT COUNT(*) FROM payment_orders WHERE status IN ('created','redirected')) AS abandoned,
            (SELECT COALESCE(SUM(amount),0) FROM payment_orders WHERE status IN ('created','redirected')) AS abandoned_value`
      ),
    ]);

    const s = summary.rows[0] || {};
    sendSuccess(
      res,
      {
        summary: {
          rejectedCallbacks: num(s.rejected_callbacks),
          failedPayments: num(s.failed_payments),
          abandoned: num(s.abandoned),
          abandonedValue: num(s.abandoned_value),
        },
        rejectedCallbacks: rejected.rows,
        failedPayments: declines.rows,
        repeatFailures: repeatFailures.rows.map((r) => ({
          email: r.lead_email,
          failures: num(r.failures),
          value: num(r.value),
          lastAttempt: r.last_attempt,
        })),
      },
      'Fraud signals retrieved'
    );
  } catch (err) {
    console.error('payment fraud error:', err);
    sendError(res, err, 'Failed to load fraud signals', 500);
  }
});

// ── GET /:entryId ────────────────────────────────────────────────────────────
// entryId is "P<bookingId>" or "R<bookingId>" — the ledger's synthetic key.
router.get('/:entryId', adminAuth, async (req, res) => {
  try {
    const match = /^([PR])(\d+)$/.exec(req.params.entryId);
    if (!match) return sendError(res, null, 'Unknown ledger entry', 400);
    const [, kind, bookingId] = match;

    const { rows } = await pool.query(
      `SELECT b.*, u.email AS account_email, u.id AS account_id
         FROM bookings b LEFT JOIN users u ON u.id = b.user_id
        WHERE b.id = $1`,
      [bookingId]
    );
    if (!rows.length) return sendError(res, null, 'Entry not found', 404);
    const b = rows[0];

    const [order, attempts, refundEvents] = await Promise.all([
      pool.query('SELECT * FROM payment_orders WHERE booking_id = $1 LIMIT 1', [bookingId]),
      pool.query(
        `SELECT decision, gateway, gateway_reference, amount, currency, message,
                signature_valid, raw_payload, created_at
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
    ]);

    const details = asObject(b.details);
    const gatewayPayload = asObject(details.gateway_response);
    const isRefund = kind === 'R';

    sendSuccess(
      res,
      {
        entryType: isRefund ? 'refund' : 'payment',
        amount: isRefund ? -Number(b.refund_amount) : Number(b.payment_amount),
        currency: isRefund ? b.refund_currency || b.currency : b.currency,
        occurredAt: isRefund ? b.refund_completed_at || b.refund_initiated_at : b.created_at,
        gateway: b.payment_gateway === 'cybersource' ? 'CyberSource' : b.payment_gateway,
        gatewayReference: isRefund ? b.refund_reference : b.payment_reference,
        orderReference: order.rows[0]?.order_reference || details.order_reference || null,
        method: cardLabel(gatewayPayload),
        authCode: gatewayPayload.auth_code || null,
        booking: {
          id: b.id,
          reference: b.booking_reference,
          product: b.product_title,
          type: b.booking_type,
          status: b.status,
          paymentStatus: b.payment_status,
          checkIn: b.check_in_date,
          checkOut: b.check_out_date,
          travellers: b.total_travellers,
          adults: b.total_adults,
          children: b.total_children,
          supplierReference: b.supplier_reference,
          supplierStatus: b.supplier_status,
        },
        customer: {
          id: b.account_id,
          name: `${b.lead_first_name || ''} ${b.lead_last_name || ''}`.trim(),
          email: b.lead_email,
          mobile: b.lead_mobile,
          accountEmail: b.account_email,
        },
        breakdown: {
          gross: Number(b.payment_amount),
          refunded: Number(b.refund_amount || 0),
          net: Number(b.payment_amount) - Number(b.refund_amount || 0),
          travellers: b.total_travellers,
          perTraveller:
            b.total_travellers > 0
              ? Number((Number(b.payment_amount) / b.total_travellers).toFixed(2))
              : null,
        },
        refund: b.refund_amount
          ? {
              amount: Number(b.refund_amount),
              reference: b.refund_reference,
              reason: b.refund_reason,
              initiatedAt: b.refund_initiated_at,
              completedAt: b.refund_completed_at,
            }
          : null,
        attempts: attempts.rows.map((a) => ({
          decision: a.decision,
          reference: a.gateway_reference,
          amount: Number(a.amount || 0),
          currency: a.currency,
          message: a.message,
          signatureValid: !!a.signature_valid,
          at: a.created_at,
        })),
        refundEvents: refundEvents.rows,
      },
      'Ledger entry retrieved'
    );
  } catch (err) {
    console.error('ledger entry error:', err);
    sendError(res, err, 'Failed to load this entry', 500);
  }
});

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value) || {};
  } catch {
    return {};
  }
}

const CARD_TYPES = {
  '001': 'Visa',
  '002': 'Mastercard',
  '003': 'American Express',
  '004': 'Discover',
  '005': 'Diners Club',
  '007': 'JCB',
};

function cardLabel(payload) {
  const brand = CARD_TYPES[payload.req_card_type];
  const masked = payload.req_card_number || payload.card_number;
  if (brand && masked) return `${brand} •••• ${String(masked).slice(-4)}`;
  if (brand) return brand;
  if (masked) return `Card •••• ${String(masked).slice(-4)}`;
  return null;
}

module.exports = router;
