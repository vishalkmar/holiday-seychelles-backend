const express = require('express');
const { pool } = require('../../config/db');
const userAuth = require('../../middleware/userAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

// Get user's trips (bookings)
router.get('/', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;

    const { rows } = await pool.query(
      `SELECT id, booking_reference, booking_type, product_title, product_code,
              check_in_date, check_out_date, travel_date, total_travellers,
              payment_amount, currency, status, payment_status, voucher_path,
              created_at, updated_at
       FROM bookings
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    sendSuccess(res, { bookings: rows, total: rows.length }, 'Trips retrieved successfully');
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

    sendSuccess(res, rows[0], 'Trip details retrieved successfully');
  } catch (err) {
    console.error('get trip detail error:', err);
    sendError(res, err, 'Failed to get trip details', 500);
  }
});

module.exports = router;
