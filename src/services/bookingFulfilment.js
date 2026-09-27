/**
 * Turn a paid payment order into a confirmed booking.
 *
 * Ordering matters here. The customer's card has already been charged by the
 * time this runs, so the booking row is written EVEN IF the supplier commit
 * fails. Losing the payment record because TourVisio hiccuped would be far
 * worse than a booking that needs a manual follow-up: `supplier_status` carries
 * the failure so admins can see and fix it.
 */

const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/db');
const tourvisio = require('./tourvisio');
const paymentOrders = require('./paymentOrders');
const { generateVoucherPDF } = require('../utils/voucher');
const { sendVoucherEmail } = require('../utils/mailer');
const { logEmail } = require('./emailTemplates');

function newBookingReference() {
  return `BS-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
}

/**
 * Settling the supplier side spends the agency's real prepaid balance and
 * creates a real reservation, so it stays opt-in. With the flag off, paid
 * bookings land as `awaiting_agency_payment` for an operator to confirm.
 */
const AUTO_COMMIT = String(process.env.TOURVISIO_AUTO_COMMIT || 'false').toLowerCase() === 'true';

/**
 * Confirm the held supplier reservation.
 *
 * TourVisio will not commit a reservation it considers unpaid - calling
 * committransaction on its own returns `PaymentFailure`. The agency balance has
 * to settle it first, which is what payWithAgencyCredit does (and it commits in
 * the same call).
 *
 * Never throws: the customer's card is already charged by this point, so the
 * booking row must be written whatever the supplier does.
 */
async function commitSupplier(order) {
  const supplier = order.payload?.supplier;
  if (!supplier?.transactionId) {
    return { status: 'not_applicable', reference: null, error: null };
  }

  if (!AUTO_COMMIT) {
    return {
      status: 'awaiting_agency_payment',
      reference: null,
      error: 'TOURVISIO_AUTO_COMMIT is off - confirm this reservation from the admin panel.',
    };
  }

  try {
    // If traveller details could not be attached at order-creation time, retry
    // now - TourVisio rejects a reservation with empty traveller slots.
    if (!supplier.reservationInfoSet) {
      await tourvisio.setReservationInfo({
        transactionId: supplier.transactionId,
        reservationData: supplier.reservationData,
        travellers: order.payload?.travellers || [],
        contact: order.payload?.contact || {},
      });
    }

    const payment = await tourvisio.payWithAgencyCredit({
      transactionId: supplier.transactionId,
      currency: order.currency,
      commitAfterPayment: true,
    });

    // Most agency-credit payments come back already committed; fall back to an
    // explicit commit if TourVisio did not return a reservation number.
    let reservationNumber = payment.reservationNumber;
    if (!reservationNumber) {
      const committed = await tourvisio.commitTransaction({
        transactionId: supplier.transactionId,
      });
      reservationNumber = committed.reservationNumber;
    }

    if (!reservationNumber) {
      return {
        status: 'commit_unconfirmed',
        reference: null,
        error: 'Agency payment accepted but no reservation number was returned.',
      };
    }

    return { status: 'confirmed', reference: reservationNumber, error: null };
  } catch (err) {
    console.error(`[fulfilment] supplier commit failed for ${order.order_reference}:`, err.message);
    return { status: 'commit_failed', reference: null, error: err.message };
  }
}

/**
 * Generate the voucher PDF and email it. Failures are logged, never thrown.
 *
 * The send is written to `email_notifications` as kind `voucher`. It used not
 * to be, which meant the one email every paying customer actually receives was
 * the only one missing from their email history — so a guest saying "I never
 * got my voucher" could not be answered from the admin panel at all.
 */
async function sendVoucher(bookingId) {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (rows.length === 0) return;
    const booking = rows[0];

    const { absolutePath, relativePath } = await generateVoucherPDF(booking);
    await pool.query(
      'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
      [relativePath, bookingId]
    );
    if (!booking.lead_email) return;

    const result = await sendVoucherEmail(booking, absolutePath);
    await logEmail({
      kind: 'voucher',
      dedupeKey: `voucher:b${bookingId}`,
      bookingId,
      recipient: booking.lead_email,
      subject: `Your booking is confirmed · ${booking.booking_reference}`,
      result: result || { success: true },
    });
  } catch (err) {
    console.error('[fulfilment] voucher/email error:', err.message);
  }
}

/**
 * Fulfil a paid order. The caller must already have won claimForFulfilment(),
 * so this runs exactly once per order.
 */
async function fulfil(order, gatewayPayload = {}) {
  // Guard against a re-entry that slipped past the claim.
  const { rows: already } = await pool.query(
    'SELECT id, booking_reference FROM bookings WHERE payment_reference = $1 LIMIT 1',
    [order.gateway_reference || order.order_reference]
  );
  if (already.length > 0) {
    return { bookingId: already[0].id, bookingReference: already[0].booking_reference, reused: true };
  }

  const supplierResult = await commitSupplier(order);

  const bookingReference = newBookingReference();
  const totalTravellers = (order.total_adults || 1) + (order.total_children || 0);

  const details = {
    gateway: order.gateway,
    order_reference: order.order_reference,
    transaction_uuid: order.transaction_uuid,
    supplier: {
      transactionId: order.payload?.supplier?.transactionId || null,
      status: supplierResult.status,
      error: supplierResult.error,
    },
    offerId: order.payload?.offerId || null,
    travellers: order.payload?.travellers || [],
    contact: order.payload?.contact || {},
    cancellationPolicies: order.payload?.supplier?.cancellationPolicies || [],
    gateway_response: gatewayPayload,
  };

  const { insertId } = await pool.query(
    `INSERT INTO bookings (
       booking_reference, user_id, booking_type, status, payment_status,
       lead_first_name, lead_last_name, lead_email, lead_mobile,
       product_title, product_code, check_in_date, check_out_date, travel_date,
       total_travellers, total_adults, total_children,
       payment_amount, currency, payment_gateway, payment_reference,
       details, is_refundable, refund_window_hours,
       supplier_reference, supplier_status
     ) VALUES (
       $1,$2,$3,$4,'paid',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
     )`,
    [
      bookingReference,
      order.user_id || null,
      order.booking_type,
      // Confirmed only when the supplier actually confirmed (or there is no
      // supplier leg). Anything else needs an operator to look at it.
      ['confirmed', 'not_applicable'].includes(supplierResult.status) ? 'confirmed' : 'pending_supplier',
      order.lead_first_name,
      order.lead_last_name,
      order.lead_email,
      order.lead_mobile || '',
      order.product_title,
      order.product_code,
      order.check_in_date,
      order.check_out_date,
      order.travel_date,
      totalTravellers,
      order.total_adults,
      order.total_children,
      order.amount,
      order.currency,
      order.gateway,
      order.gateway_reference || order.order_reference,
      JSON.stringify(details),
      !!order.is_refundable,
      order.refund_window_hours,
      supplierResult.reference,
      supplierResult.status,
    ]
  );

  await paymentOrders.attachBooking(order.order_reference, insertId);

  // Voucher generation and SMTP must not hold up the customer's redirect.
  setImmediate(() => sendVoucher(insertId));

  return {
    bookingId: insertId,
    bookingReference,
    supplierStatus: supplierResult.status,
    supplierReference: supplierResult.reference,
    reused: false,
  };
}

module.exports = { fulfil, commitSupplier, sendVoucher };
