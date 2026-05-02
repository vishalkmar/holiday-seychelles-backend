const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const { sendSuccess, sendError } = require('../../utils/response');
const { generateVoucherPDF } = require('../../utils/voucher');
const { sendVoucherEmail } = require('../../utils/mailer');

const router = express.Router();

/**
 * Generate voucher + email it to the lead guest.
 * Persists voucher_path on success. Errors are swallowed (logged) so the booking
 * response never blocks on email/PDF issues.
 */
async function sendBookingVoucher(bookingId) {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (rows.length === 0) return;
    const booking = rows[0];

    const { absolutePath, relativePath } = await generateVoucherPDF(booking);
    await pool.query(
      'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
      [relativePath, bookingId]
    );

    if (booking.lead_email) {
      await sendVoucherEmail(booking, absolutePath);
    }
  } catch (err) {
    console.error('sendBookingVoucher error:', err.message);
  }
}

// Create booking after payment success (called by payment gateway webhook)
router.post(
  '/',
  body('user_id').optional().isInt(),
  body('booking_type').isIn(['hotel', 'package', 'tour', 'transfer', 'flight', 'excursion', 'rentcar', 'attraction']),
  body('lead_first_name').trim().notEmpty(),
  body('lead_last_name').trim().notEmpty(),
  body('lead_email').isEmail(),
  body('lead_mobile').trim().notEmpty(),
  body('product_title').trim().notEmpty(),
  body('payment_amount').isFloat({ min: 0 }),
  body('currency').optional().trim(),
  body('payment_gateway').trim().notEmpty(),
  body('payment_reference').trim().notEmpty(),
  body('details').optional(),
  body('is_refundable').optional().isBoolean(),
  body('refund_window_hours').optional().isInt({ min: 0, max: 720 }),
  body('supplier_reference').optional().trim(),
  body('supplier_status').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const {
        user_id,
        booking_type,
        lead_first_name,
        lead_last_name,
        lead_email,
        lead_mobile,
        product_title,
        product_code,
        check_in_date,
        check_out_date,
        travel_date,
        total_travellers,
        total_adults,
        total_children,
        payment_amount,
        currency = 'INR',
        payment_gateway,
        payment_reference,
        details = {},
        is_refundable = true,
        refund_window_hours = 24,
        supplier_reference = null,
        supplier_status = null,
      } = req.body;

      // Idempotency: if a booking with this payment_reference already exists, return it.
      // This is critical because PHP receipt is allowed to retry on transient network errors.
      const existing = await pool.query(
        'SELECT id, booking_reference, status, created_at FROM bookings WHERE payment_reference = $1 LIMIT 1',
        [payment_reference]
      );
      if (existing.rows.length > 0) {
        return sendSuccess(res, existing.rows[0], 'Booking already exists', 200);
      }

      const bookingReference = `BS-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

      const { rows } = await pool.query(
        `INSERT INTO bookings (
          booking_reference, user_id, booking_type, status, payment_status,
          lead_first_name, lead_last_name, lead_email, lead_mobile,
          product_title, product_code, check_in_date, check_out_date, travel_date,
          total_travellers, total_adults, total_children,
          payment_amount, currency, payment_gateway, payment_reference, details,
          is_refundable, refund_window_hours, supplier_reference, supplier_status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
        ) RETURNING id, booking_reference, status, created_at`,
        [
          bookingReference, user_id || null, booking_type, 'confirmed', 'paid',
          lead_first_name, lead_last_name, lead_email, lead_mobile,
          product_title, product_code || null, check_in_date || null, check_out_date || null, travel_date || null,
          total_travellers || 1, total_adults || 1, total_children || 0,
          payment_amount, currency, payment_gateway, payment_reference,
          typeof details === 'string' ? JSON.parse(details) : details,
          !!is_refundable, refund_window_hours, supplier_reference, supplier_status,
        ]
      );

      // Fire-and-forget: generate voucher PDF + email to lead guest.
      // Do NOT await — booking response should return immediately.
      setImmediate(() => sendBookingVoucher(rows[0].id));

      sendSuccess(res, rows[0], 'Booking created successfully', 201);
    } catch (err) {
      console.error('create booking error:', err);
      sendError(res, err, 'Failed to create booking', 500);
    }
  }
);

// Record a payment attempt (success/decline/error). Used by the CyberSource
// receipt to log every gateway response so admins can audit declines and
// failed transactions even when no booking row was created.
router.post(
  '/payment-attempts',
  body('transaction_uuid').optional().trim(),
  body('decision').trim().notEmpty(),
  body('gateway').optional().trim(),
  body('gateway_reference').optional().trim(),
  body('amount').optional().isFloat({ min: 0 }),
  body('currency').optional().trim(),
  body('message').optional().trim(),
  body('booking_id').optional().isInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const {
        transaction_uuid = null,
        decision,
        gateway = 'cybersource',
        gateway_reference = null,
        amount = null,
        currency = null,
        message = null,
        booking_id = null,
        raw_payload = {},
      } = req.body;

      const { rows } = await pool.query(
        `INSERT INTO payment_attempts (
            booking_id, transaction_uuid, decision, gateway, gateway_reference,
            amount, currency, message, raw_payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, decision, created_at`,
        [
          booking_id, transaction_uuid, String(decision).toUpperCase(), gateway,
          gateway_reference, amount, currency, message,
          typeof raw_payload === 'string' ? JSON.parse(raw_payload) : raw_payload,
        ]
      );

      sendSuccess(res, rows[0], 'Payment attempt recorded', 201);
    } catch (err) {
      console.error('payment attempt log error:', err);
      sendError(res, err, 'Failed to log payment attempt', 500);
    }
  }
);

// Attach a supplier reservation reference (e.g. TourVisio reservation number)
// to a booking after the supplier-side save completes. Keyed by payment_reference
// so the success page can call it without knowing our internal booking id.
router.post(
  '/attach-supplier-reference',
  body('payment_reference').trim().notEmpty(),
  body('supplier_reference').trim().notEmpty(),
  body('supplier_status').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { payment_reference, supplier_reference, supplier_status = null } = req.body;

      const { rows } = await pool.query(
        `UPDATE bookings
            SET supplier_reference = $1,
                supplier_status    = COALESCE($2, supplier_status),
                updated_at         = NOW()
          WHERE payment_reference = $3
          RETURNING id, booking_reference, supplier_reference, supplier_status`,
        [supplier_reference, supplier_status, payment_reference]
      );

      if (rows.length === 0) {
        return sendError(res, null, 'Booking not found for given payment_reference', 404);
      }

      sendSuccess(res, rows[0], 'Supplier reference attached');
    } catch (err) {
      console.error('attach supplier reference error:', err);
      sendError(res, err, 'Failed to attach supplier reference', 500);
    }
  }
);

// Get booking by reference (public access)
router.get('/:bookingReference', async (req, res) => {
  try {
    const { bookingReference } = req.params;

    const { rows } = await pool.query(
      'SELECT * FROM bookings WHERE booking_reference = $1',
      [bookingReference]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'Booking not found', 404);
    }

    sendSuccess(res, rows[0], 'Booking retrieved successfully');
  } catch (err) {
    console.error('get booking error:', err);
    sendError(res, err, 'Failed to get booking', 500);
  }
});

module.exports = router;
