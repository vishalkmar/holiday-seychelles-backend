/**
 * A user's payment history.
 *
 * Every checkout writes a `payment_orders` row before the customer reaches the
 * gateway, so this list shows attempts that never completed too - which is the
 * point. A booking only exists once money cleared, so the booking is joined in
 * rather than being the source of the list.
 *
 * Status buckets the UI filters on:
 *   completed  order paid              -> booking exists, voucher available
 *   pending    created | redirected    -> customer reached checkout, no result yet
 *   cancelled  cancelled | declined | error
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../../config/db');
const userAuth = require('../../middleware/userAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const { generateVoucherPDF } = require('../../utils/voucher');
const tourvisio = require('../../services/tourvisio');

const router = express.Router();

const BUCKETS = {
  completed: ['paid'],
  pending: ['created', 'redirected'],
  cancelled: ['cancelled', 'declined', 'error', 'expired'],
};

function bucketOf(orderStatus) {
  for (const [bucket, statuses] of Object.entries(BUCKETS)) {
    if (statuses.includes(orderStatus)) return bucket;
  }
  return 'pending';
}

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

function paymentMethod(gatewayPayload) {
  const brand = CARD_TYPES[gatewayPayload.req_card_type];
  const masked = gatewayPayload.req_card_number || gatewayPayload.card_number;
  if (brand && masked) return `${brand} •••• ${String(masked).slice(-4)}`;
  if (brand) return brand;
  if (masked) return `Card •••• ${String(masked).slice(-4)}`;
  return null;
}

/**
 * Orders belong to the signed-in user by user_id, or by the email they booked
 * with - a checkout started before logging in still belongs to them.
 */
async function ownerClause(userId) {
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = rows[0]?.email || null;
  return email
    ? { sql: '(o.user_id = $1 OR o.lead_email = $2)', params: [userId, email] }
    : { sql: 'o.user_id = $1', params: [userId] };
}

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;
    const filter = String(req.query.status || 'all').toLowerCase();
    const owner = await ownerClause(userId);

    const { rows } = await pool.query(
      `SELECT o.id, o.order_reference, o.transaction_uuid, o.status, o.decision,
              o.amount, o.currency, o.gateway, o.gateway_reference, o.gateway_message,
              o.gateway_payload, o.booking_type, o.product_title, o.product_code,
              o.check_in_date, o.check_out_date, o.travel_date,
              o.total_adults, o.total_children, o.lead_first_name, o.lead_last_name,
              o.lead_email, o.lead_mobile, o.created_at, o.paid_at, o.booking_id,
              b.booking_reference, b.status AS booking_status,
              b.supplier_reference, b.supplier_status, b.voucher_path
         FROM payment_orders o
         LEFT JOIN bookings b ON b.id = o.booking_id
        WHERE ${owner.sql}
        ORDER BY o.created_at DESC`,
      owner.params
    );

    const items = rows
      .map((r) => {
        const gatewayPayload = asObject(r.gateway_payload);
        return {
          orderReference: r.order_reference,
          transactionId: r.gateway_reference || null,
          bookingReference: r.booking_reference || null,
          bucket: bucketOf(r.status),
          rawStatus: r.status,
          decision: r.decision,
          amount: Number(r.amount),
          currency: r.currency,
          gateway: r.gateway === 'cybersource' ? 'CyberSource' : r.gateway,
          method: paymentMethod(gatewayPayload),
          message: r.gateway_message,
          bookingType: r.booking_type,
          productTitle: r.product_title,
          checkIn: r.check_in_date,
          checkOut: r.check_out_date,
          guests: (r.total_adults || 0) + (r.total_children || 0),
          createdAt: r.created_at,
          paidAt: r.paid_at,
          supplierReference: r.supplier_reference,
          supplierStatus: r.supplier_status,
          voucherAvailable: !!r.booking_id,
        };
      })
      .filter((t) => filter === 'all' || t.bucket === filter);

    const counts = rows.reduce(
      (acc, r) => {
        acc.all += 1;
        acc[bucketOf(r.status)] += 1;
        return acc;
      },
      { all: 0, completed: 0, pending: 0, cancelled: 0 }
    );

    sendSuccess(res, { transactions: items, counts }, 'Transactions retrieved');
  } catch (err) {
    console.error('get transactions error:', err);
    sendError(res, err, 'Failed to load transactions', 500);
  }
});

// ── GET /:reference ──────────────────────────────────────────────────────────
// Everything about one transaction: the item, the configuration chosen, the
// details the customer typed, and the full payment trail.
router.get('/:reference', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;
    const owner = await ownerClause(userId);

    const { rows } = await pool.query(
      `SELECT o.*, b.booking_reference, b.status AS booking_status, b.details AS booking_details,
              b.supplier_reference, b.supplier_status, b.voucher_path, b.is_refundable,
              b.refund_window_hours, b.payment_status, b.total_travellers
         FROM payment_orders o
         LEFT JOIN bookings b ON b.id = o.booking_id
        WHERE o.order_reference = $${owner.params.length + 1} AND ${owner.sql}
        LIMIT 1`,
      [...owner.params, req.params.reference]
    );

    if (rows.length === 0) return sendError(res, null, 'Transaction not found', 404);

    const r = rows[0];
    const payload = asObject(r.payload);
    const bookingDetails = asObject(r.booking_details);
    const gatewayPayload = asObject(r.gateway_payload);
    const supplier = payload.supplier || {};

    sendSuccess(
      res,
      {
        orderReference: r.order_reference,
        bucket: bucketOf(r.status),
        rawStatus: r.status,

        payment: {
          transactionId: r.gateway_reference,
          amount: Number(r.amount),
          currency: r.currency,
          gateway: r.gateway === 'cybersource' ? 'CyberSource' : r.gateway,
          method: paymentMethod(gatewayPayload),
          decision: r.decision,
          message: r.gateway_message,
          authCode: gatewayPayload.auth_code || null,
          paidAt: r.paid_at,
          createdAt: r.created_at,
          status: r.payment_status || (r.status === 'paid' ? 'paid' : r.status),
        },

        item: {
          title: r.product_title,
          code: r.product_code,
          type: r.booking_type,
          checkIn: r.check_in_date,
          checkOut: r.check_out_date,
          travelDate: r.travel_date,
          adults: r.total_adults,
          children: r.total_children,
          totalTravellers: r.total_travellers || (r.total_adults || 0) + (r.total_children || 0),
          offerId: payload.offerId || bookingDetails.offerId || null,
          supplierTransactionId: supplier.transactionId || null,
          supplierReference: r.supplier_reference,
          supplierStatus: r.supplier_status,
          isRefundable: r.is_refundable === null ? !!r.is_refundable : !!r.is_refundable,
          refundWindowHours: r.refund_window_hours,
          cancellationPolicies: supplier.cancellationPolicies || bookingDetails.cancellationPolicies || [],
        },

        customer: {
          firstName: r.lead_first_name,
          lastName: r.lead_last_name,
          email: r.lead_email,
          mobile: r.lead_mobile,
          travellers: payload.travellers || bookingDetails.travellers || [],
          contact: payload.contact || bookingDetails.contact || {},
        },

        booking: r.booking_reference
          ? {
              reference: r.booking_reference,
              status: r.booking_status,
              voucherAvailable: true,
            }
          : null,
      },
      'Transaction retrieved'
    );
  } catch (err) {
    console.error('get transaction detail error:', err);
    sendError(res, err, 'Failed to load transaction', 500);
  }
});

// ── GET /:reference/voucher ──────────────────────────────────────────────────
// Streams the PDF, regenerating it if the file is missing from disk.
router.get('/:reference/voucher', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;
    const owner = await ownerClause(userId);

    const { rows } = await pool.query(
      `SELECT b.* FROM payment_orders o
         JOIN bookings b ON b.id = o.booking_id
        WHERE o.order_reference = $${owner.params.length + 1} AND ${owner.sql}
        LIMIT 1`,
      [...owner.params, req.params.reference]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'No voucher for this transaction', 404);
    }

    const booking = rows[0];
    const uploadsDir = path.join(__dirname, '../../..', process.env.UPLOAD_DIR || 'uploads');
    let absolutePath = booking.voucher_path
      ? path.join(uploadsDir, path.basename(booking.voucher_path))
      : null;

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      const generated = await generateVoucherPDF(booking);
      absolutePath = generated.absolutePath;
      await pool.query(
        'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
        [generated.relativePath, booking.id]
      );
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="voucher-${booking.booking_reference}.pdf"`
    );
    fs.createReadStream(absolutePath).pipe(res);
  } catch (err) {
    console.error('voucher download error:', err);
    sendError(res, err, 'Failed to download voucher', 500);
  }
});

// ── POST /:reference/resume ──────────────────────────────────────────────────
// Finish a checkout that was never paid.
//
// The order carries a supplier hold that expires in minutes, so an old order
// cannot simply be re-opened: the offer is re-held and re-priced first, and the
// caller is told if the price moved. Orders without a supplier leg just get
// their expiry extended.
router.post('/:reference/resume', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;
    const owner = await ownerClause(userId);

    const { rows } = await pool.query(
      `SELECT * FROM payment_orders o
        WHERE o.order_reference = $${owner.params.length + 1} AND ${owner.sql}
        LIMIT 1`,
      [...owner.params, req.params.reference]
    );

    if (rows.length === 0) return sendError(res, null, 'Transaction not found', 404);

    const order = rows[0];
    if (order.status === 'paid') {
      return sendError(res, null, 'This payment is already complete', 409);
    }
    if (!['created', 'redirected', 'cancelled', 'declined', 'error'].includes(order.status)) {
      return sendError(res, null, `Cannot resume an order that is ${order.status}`, 409);
    }

    const payload = asObject(order.payload);
    const ttlMinutes = Number(process.env.PAYMENT_ORDER_TTL_MINUTES || 25);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60000);

    let amount = Number(order.amount);
    let priceChanged = false;

    if (payload.offerId) {
      // Re-hold the offer; the old transactionId is long gone.
      const supplier = await tourvisio.beginTransaction({
        offerIds: [payload.offerId],
        currency: order.currency,
      });

      priceChanged = Math.abs(supplier.amount - Number(order.amount)) > 0.01;
      amount = supplier.amount;

      try {
        await tourvisio.setReservationInfo({
          transactionId: supplier.transactionId,
          reservationData: supplier.reservationData,
          travellers: payload.travellers || [],
          contact: payload.contact || {},
        });
        supplier.reservationInfoSet = true;
      } catch (err) {
        console.warn('[resume] setreservationinfo deferred:', err.message);
        supplier.reservationInfoSet = false;
      }

      payload.supplier = {
        transactionId: supplier.transactionId,
        expiresOn: supplier.expiresOn,
        reservationInfoSet: supplier.reservationInfoSet,
        cancellationPolicies: supplier.cancellationPolicies,
        reservationData: supplier.reservationData,
      };
    }

    await pool.query(
      `UPDATE payment_orders
          SET status = 'created', amount = $1, payload = $2, expires_at = $3,
              decision = NULL, gateway_message = NULL, updated_at = NOW()
        WHERE id = $4`,
      [amount.toFixed(2), JSON.stringify(payload), expiresAt, order.id]
    );

    const base = (
      process.env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`
    ).replace(/\/$/, '');

    sendSuccess(
      res,
      {
        orderReference: order.order_reference,
        checkoutUrl: `${base}/api/payments/checkout/${order.order_reference}`,
        amount,
        currency: order.currency,
        priceChanged,
        previousAmount: Number(order.amount),
        expiresAt,
      },
      priceChanged ? 'Price has changed since you started' : 'Ready to complete payment'
    );
  } catch (err) {
    console.error('resume payment error:', err);
    sendError(res, err, err.message || 'Could not resume this payment', 502);
  }
});

module.exports = router;
