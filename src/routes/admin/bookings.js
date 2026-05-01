const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const { generateVoucherPDF } = require('../../utils/voucher');
const { sendVoucherEmail, sendRefundEmail } = require('../../utils/mailer');
const { processRefund, isLive: cybersourceLive } = require('../../utils/cybersource');

const router = express.Router();

// Get all bookings with filters
router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const requestedLimit = parseInt(req.query.limit || '50', 10);
    const limit = Math.min(Math.max(requestedLimit, 1), 100);
    const status = req.query.status || '';
    const booking_type = req.query.booking_type || '';
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    let query = `SELECT b.id, b.booking_reference, b.booking_type, b.status, b.payment_status,
                        b.payment_gateway, b.payment_reference, b.voucher_path, b.voucher_generated_at,
                        b.lead_first_name, b.lead_last_name, b.lead_email, b.lead_mobile,
                        b.product_title, b.product_code, b.payment_amount, b.currency, b.travel_date,
                        b.check_in_date, b.check_out_date, b.total_travellers, b.total_adults, b.total_children,
                        b.admin_notes, b.details,
                        b.user_id, u.email as user_email,
                        b.created_at, b.updated_at
                 FROM bookings b
                 LEFT JOIN users u ON b.user_id = u.id`;
    let countQuery = `SELECT COUNT(*) as total FROM bookings b
                      LEFT JOIN users u ON b.user_id = u.id`;
    const params = [];
    const conditions = [];

    if (status) {
      conditions.push(`b.status = $${params.length + 1}`);
      params.push(status);
    }

    if (booking_type) {
      conditions.push(`b.booking_type = $${params.length + 1}`);
      params.push(booking_type);
    }

    if (search) {
      conditions.push(`(b.booking_reference ILIKE $${params.length + 1} OR b.lead_email ILIKE $${params.length + 1} OR b.lead_first_name ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }

    if (conditions.length > 0) {
      const whereClause = ' WHERE ' + conditions.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    query += ` ORDER BY b.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const { rows } = await pool.query(query, [...params, limit, offset]);

    const { rows: countRows } = await pool.query(countQuery, params);

    sendSuccess(
      res,
      { bookings: rows, total: parseInt(countRows[0].total), page, limit },
      'Bookings retrieved successfully'
    );
  } catch (err) {
    console.error('get bookings error:', err);
    sendError(res, err, 'Failed to get bookings', 500);
  }
});

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
  body('status').optional().isIn(['confirmed', 'cancelled', 'refunded', 'pending']),
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

      if (booking.is_refundable === false) {
        await client.query('ROLLBACK');
        return sendError(res, null, 'This booking is marked non-refundable', 409);
      }
      if (booking.payment_status === 'refunded' || booking.status === 'refunded') {
        await client.query('ROLLBACK');
        return sendError(res, null, 'This booking has already been refunded', 409);
      }
      if (booking.payment_status !== 'paid') {
        await client.query('ROLLBACK');
        return sendError(res, null, 'Only paid bookings can be refunded', 409);
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
