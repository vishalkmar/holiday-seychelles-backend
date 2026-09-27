/**
 * Payment order lifecycle.
 *
 * An order is created BEFORE the customer reaches the gateway and holds the
 * authoritative amount (from TourVisio, not from the browser) plus every detail
 * needed to turn a successful payment into a booking. The gateway only ever
 * echoes back the order reference; everything else is re-read from this row.
 *
 * Status flow:
 *   created -> redirected -> paid | declined | cancelled | error
 *
 * Fulfilment (commit supplier reservation + create booking + email voucher) is
 * claimed atomically so a duplicate gateway callback cannot double-book.
 */

const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/db');
const tourvisio = require('./tourvisio');
const { toDateOnly } = require('../utils/dates');

const ORDER_TTL_MINUTES = Number(process.env.PAYMENT_ORDER_TTL_MINUTES || 25);

function newOrderReference() {
  return `HS-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
}

/** Free-cancellation deadline -> refund window in hours, clamped to the column's range. */
function refundWindowHoursFrom(policies) {
  if (!Array.isArray(policies) || policies.length === 0) return 24;
  const dueDates = policies
    .map((p) => (p && p.dueDate ? new Date(p.dueDate).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  if (dueDates.length === 0) return 24;

  const hours = Math.floor((Math.min(...dueDates) - Date.now()) / 3600000);
  return Math.max(0, Math.min(720, hours));
}

/** MySQL JSON columns come back as strings on some driver/server combinations. */
function hydrate(row) {
  if (row && typeof row.payload === 'string') {
    try {
      row.payload = JSON.parse(row.payload);
    } catch {
      /* leave as-is */
    }
  }
  return row;
}

async function getOrderById(id) {
  const { rows } = await pool.query('SELECT * FROM payment_orders WHERE id = $1', [id]);
  return rows[0] ? hydrate(rows[0]) : null;
}

async function getOrderByReference(reference) {
  const { rows } = await pool.query(
    'SELECT * FROM payment_orders WHERE order_reference = $1 LIMIT 1',
    [reference]
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

/**
 * Create a payment order.
 *
 * When an offerId is supplied we hold it with TourVisio and take the price from
 * the supplier response. `input.quotedAmount` from the client is never trusted -
 * it is only recorded so a mismatch can be spotted later.
 */
async function createOrder(input) {
  const {
    offerId,
    bookingType = 'hotel',
    currency = 'EUR',
    travellers = [],
    contact = {},
    userId = null,
    productTitle = null,
    productCode = null,
    checkIn = null,
    checkOut = null,
    totalAdults = 1,
    totalChildren = 0,
    clientIp = null,
    quotedAmount = null,
  } = input;

  if (!contact.email) throw new Error('Contact email is required');

  let supplier = null;
  if (offerId) {
    supplier = await tourvisio.beginTransaction({ offerIds: [offerId], currency });

    // Best-effort: attach traveller details to the held transaction now, so the
    // post-payment commit is a single call. A failure here is not fatal - the
    // details are stored on the order and retried at fulfilment time.
    try {
      await tourvisio.setReservationInfo({
        transactionId: supplier.transactionId,
        reservationData: supplier.reservationData,
        travellers,
        contact,
      });
      supplier.reservationInfoSet = true;
    } catch (err) {
      console.warn('[paymentOrders] setreservationinfo deferred:', err.message);
      supplier.reservationInfoSet = false;
    }
  }

  const amount = supplier ? supplier.amount : Number(quotedAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Could not determine a valid payment amount');
  }

  const orderReference = newOrderReference();
  const transactionUuid = uuidv4();
  const resolvedCurrency = String(supplier?.currency || currency || 'EUR').toUpperCase();

  const payload = {
    offerId: offerId || null,
    travellers,
    contact,
    supplier: supplier
      ? {
          transactionId: supplier.transactionId,
          expiresOn: supplier.expiresOn,
          reservationInfoSet: supplier.reservationInfoSet,
          cancellationPolicies: supplier.cancellationPolicies,
          reservationData: supplier.reservationData,
        }
      : null,
    quotedAmount: quotedAmount == null ? null : Number(quotedAmount),
    amountSource: supplier ? 'tourvisio:begintransaction' : 'client-quote',
  };

  // Surface a client/supplier price disagreement in the logs - it usually means
  // the UI is showing a stale or teaser price.
  if (quotedAmount != null && Math.abs(Number(quotedAmount) - amount) > 0.01) {
    console.warn(
      `[paymentOrders] price mismatch on ${orderReference}: client quoted ${quotedAmount}, supplier says ${amount}`
    );
  }

  // user_id is a foreign key, and some flows still carry a legacy customer id
  // that does not exist in our users table. An unknown id must not take the
  // whole payment down - record the order without an owner instead.
  let ownerId = null;
  if (userId) {
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    ownerId = rows.length ? rows[0].id : null;
    if (!ownerId) {
      console.warn(`[paymentOrders] unknown user_id ${userId}; creating order without an owner`);
    }
  }

  const expiresAt = new Date(Date.now() + ORDER_TTL_MINUTES * 60000);

  const { insertId } = await pool.query(
    `INSERT INTO payment_orders (
       order_reference, transaction_uuid, status, gateway, amount, currency,
       user_id, booking_type, lead_first_name, lead_last_name, lead_email, lead_mobile,
       product_title, product_code, check_in_date, check_out_date, travel_date,
       total_adults, total_children, is_refundable, refund_window_hours,
       payload, client_ip, expires_at
     ) VALUES ($1,$2,'created','cybersource',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      orderReference,
      transactionUuid,
      amount.toFixed(2),
      resolvedCurrency,
      ownerId,
      bookingType,
      travellers[0]?.firstName || contact.firstName || 'Guest',
      travellers[0]?.lastName || contact.lastName || 'Guest',
      contact.email,
      contact.phone || '',
      supplier?.productName || productTitle || 'Booking',
      supplier?.productCode || productCode || null,
      toDateOnly(supplier?.beginDate || checkIn),
      toDateOnly(supplier?.endDate || checkOut),
      toDateOnly(supplier?.beginDate || checkIn),
      totalAdults,
      totalChildren,
      supplier ? supplier.isRefundable : true,
      refundWindowHoursFrom(supplier?.cancellationPolicies),
      JSON.stringify(payload),
      clientIp,
      expiresAt,
    ]
  );

  return getOrderById(insertId);
}

async function markRedirected(orderReference) {
  await pool.query(
    `UPDATE payment_orders SET status = 'redirected', updated_at = NOW()
      WHERE order_reference = $1 AND status = 'created'`,
    [orderReference]
  );
}

/**
 * Atomically claim an order for fulfilment.
 * Returns true only for the caller that flipped it to 'paid' - every duplicate
 * callback gets false and must not create a second booking.
 */
async function claimForFulfilment(orderReference, { gatewayReference, message, gatewayPayload }) {
  const { rowCount } = await pool.query(
    `UPDATE payment_orders
        SET status = 'paid', decision = 'ACCEPT', paid_at = NOW(),
            gateway_reference = $1, gateway_message = $2, gateway_payload = $3,
            updated_at = NOW()
      WHERE order_reference = $4
        AND status IN ('created', 'redirected')`,
    [gatewayReference || null, message || null, JSON.stringify(gatewayPayload || {}), orderReference]
  );
  return rowCount > 0;
}

async function markFailed(orderReference, decision, { gatewayReference, message, gatewayPayload }) {
  const status =
    decision === 'CANCEL' ? 'cancelled' : decision === 'DECLINE' ? 'declined' : 'error';
  await pool.query(
    `UPDATE payment_orders
        SET status = $1, decision = $2, gateway_reference = $3, gateway_message = $4,
            gateway_payload = $5, updated_at = NOW()
      WHERE order_reference = $6
        AND status NOT IN ('paid')`,
    [
      status,
      decision,
      gatewayReference || null,
      message || null,
      JSON.stringify(gatewayPayload || {}),
      orderReference,
    ]
  );
}

async function attachBooking(orderReference, bookingId) {
  await pool.query(
    'UPDATE payment_orders SET booking_id = $1, updated_at = NOW() WHERE order_reference = $2',
    [bookingId, orderReference]
  );
}

module.exports = {
  createOrder,
  getOrderById,
  getOrderByReference,
  markRedirected,
  claimForFulfilment,
  markFailed,
  attachBooking,
  refundWindowHoursFrom,
  newOrderReference,
  ORDER_TTL_MINUTES,
};
