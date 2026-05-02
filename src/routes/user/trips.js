const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const userAuth = require('../../middleware/userAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const { evaluateRefund } = require('../../utils/refundPolicy');
const { processRefund, isLive: cybersourceLive } = require('../../utils/cybersource');
const { sendRefundEmail } = require('../../utils/mailer');

const router = express.Router();

// Get user's trips (bookings)
router.get('/', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;

    const { rows } = await pool.query(
      `SELECT id, booking_reference, booking_type, product_title, product_code,
              check_in_date, check_out_date, travel_date, total_travellers,
              payment_amount, currency, status, payment_status, voucher_path,
              is_refundable, refund_window_hours, supplier_reference,
              cancelled_at, refund_amount, refund_completed_at,
              created_at, updated_at
       FROM bookings
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    // Surface eligibility on each row so the UI can render the right CTA.
    const enriched = rows.map((b) => {
      const evalResult = evaluateRefund(b);
      return {
        ...b,
        refund_eligibility: {
          eligible: evalResult.eligible,
          reason: evalResult.reason || null,
          window_hours: evalResult.windowHours ?? b.refund_window_hours ?? null,
          hours_elapsed: evalResult.hoursElapsed ?? null,
        },
      };
    });

    sendSuccess(res, { bookings: enriched, total: enriched.length }, 'Trips retrieved successfully');
  } catch (err) {
    console.error('get trips error:', err);
    sendError(res, err, 'Failed to get trips', 500);
  }
});

// Get trip details
router.get('/:bookingId', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { bookingId } = req.params;

    const { rows } = await pool.query(
      `SELECT * FROM bookings
       WHERE id = $1 AND user_id = $2`,
      [bookingId, userId]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'Booking not found', 404);
    }

    const evalResult = evaluateRefund(rows[0]);
    sendSuccess(
      res,
      { ...rows[0], refund_eligibility: evalResult },
      'Trip details retrieved successfully'
    );
  } catch (err) {
    console.error('get trip detail error:', err);
    sendError(res, err, 'Failed to get trip details', 500);
  }
});

// User-initiated cancellation. If within the refund window, the gateway
// refund is processed automatically and the user is emailed. Otherwise the
// booking is just marked cancelled and the user is told to contact support
// for a manual review.
router.post(
  '/:bookingId/cancel',
  userAuth,
  body('reason').optional().trim().isLength({ max: 500 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    const { id: userId } = req.user;
    const { bookingId } = req.params;
    const reason = (req.body?.reason || '').trim() || null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        'SELECT * FROM bookings WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [bookingId, userId]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return sendError(res, null, 'Booking not found', 404);
      }
      const booking = rows[0];

      if (booking.status === 'cancelled' || booking.status === 'refunded') {
        await client.query('ROLLBACK');
        return sendError(res, null, `Booking is already ${booking.status}`, 409);
      }

      const eligibility = evaluateRefund(booking);

      // Always log the cancellation request as an audit event
      await client.query(
        `INSERT INTO refund_events (booking_id, action, amount, currency, notes, payload)
         VALUES ($1, 'requested', $2, $3, $4, $5)`,
        [
          bookingId,
          booking.payment_amount,
          booking.currency,
          reason,
          JSON.stringify({ initiatedBy: 'user', userId, eligibility }),
        ]
      );

      if (!eligibility.eligible) {
        // Cancel-only path: mark cancelled, no automatic refund.
        // Admin can review and refund manually with { force: true }.
        const { rows: updated } = await client.query(
          `UPDATE bookings SET
              status = 'cancelled',
              cancelled_at = NOW(),
              cancelled_by = 'user',
              cancellation_reason = $1,
              updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [reason, bookingId]
        );

        await client.query('COMMIT');
        return sendSuccess(
          res,
          {
            booking: updated[0],
            refunded: false,
            reason: eligibility.reason,
            note: 'Cancellation recorded. Refund not eligible — please contact support if you believe this is wrong.',
          },
          'Booking cancelled (no automatic refund)'
        );
      }

      // Within window → process refund through gateway and mark refunded
      const refundAmount = Number(booking.payment_amount);
      const gateway = await processRefund({
        paymentReference: booking.payment_reference,
        amount: refundAmount,
        currency: booking.currency,
      });

      if (!gateway.success) {
        await client.query(
          `INSERT INTO refund_events (booking_id, action, amount, currency, notes, payload)
           VALUES ($1, 'gateway_failed', $2, $3, $4, $5)`,
          [bookingId, refundAmount, booking.currency, gateway.error, JSON.stringify(gateway)]
        );
        // Still mark booking cancelled so the user can't double-act on it,
        // but leave payment_status='paid' so admin can retry the refund.
        const { rows: cxlOnly } = await client.query(
          `UPDATE bookings SET
              status = 'cancelled',
              cancelled_at = NOW(),
              cancelled_by = 'user',
              cancellation_reason = $1,
              updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [reason, bookingId]
        );
        await client.query('COMMIT');
        return sendSuccess(
          res,
          { booking: cxlOnly[0], refunded: false, gatewayError: gateway.error },
          'Booking cancelled but gateway refund failed. Support team will retry.'
        );
      }

      await client.query(
        `INSERT INTO refund_events (booking_id, action, amount, currency, gateway_reference, notes, payload)
         VALUES ($1, 'gateway_initiated', $2, $3, $4, $5, $6)`,
        [bookingId, refundAmount, booking.currency, gateway.gatewayReference, gateway.simulated ? 'SIMULATED' : 'live', JSON.stringify(gateway)]
      );

      const { rows: updated } = await client.query(
        `UPDATE bookings SET
            status = 'refunded',
            payment_status = 'refunded',
            cancelled_at = NOW(),
            cancelled_by = 'user',
            cancellation_reason = $1,
            refund_amount = $2,
            refund_currency = $3,
            refund_reason = $4,
            refund_reference = $5,
            refund_initiated_at = COALESCE(refund_initiated_at, NOW()),
            refund_completed_at = NOW(),
            updated_at = NOW()
         WHERE id = $6 RETURNING *`,
        [reason, refundAmount, booking.currency, reason, gateway.gatewayReference, bookingId]
      );

      await client.query(
        `INSERT INTO refund_events (booking_id, action, amount, currency, gateway_reference, notes)
         VALUES ($1, 'completed', $2, $3, $4, 'User-initiated within window')`,
        [bookingId, refundAmount, booking.currency, gateway.gatewayReference]
      );

      await client.query('COMMIT');

      // Fire-and-forget refund email
      if (updated[0].lead_email) {
        sendRefundEmail(updated[0], {
          amount: refundAmount,
          currency: booking.currency,
          reason,
          gatewayReference: gateway.gatewayReference,
        }).catch((err) => console.error('refund email error:', err.message));
      }

      sendSuccess(
        res,
        {
          booking: updated[0],
          refunded: true,
          gateway: { simulated: !!gateway.simulated, reference: gateway.gatewayReference, live: cybersourceLive },
        },
        gateway.simulated
          ? 'Booking cancelled & refund recorded (simulated; live gateway disabled).'
          : 'Booking cancelled & refund processed. Funds will appear in 5–10 business days.'
      );
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      console.error('user cancel error:', err);
      sendError(res, err, 'Failed to cancel booking', 500);
    } finally {
      client.release();
    }
  }
);

module.exports = router;
