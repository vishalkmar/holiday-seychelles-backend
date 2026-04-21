const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

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
  body('details').optional().isJSON(),
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
      } = req.body;

      // Generate booking reference
      const bookingReference = `BS-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

      const { rows } = await pool.query(
        `INSERT INTO bookings (
          booking_reference, user_id, booking_type, status, payment_status,
          lead_first_name, lead_last_name, lead_email, lead_mobile,
          product_title, product_code, check_in_date, check_out_date, travel_date,
          total_travellers, total_adults, total_children,
          payment_amount, currency, payment_gateway, payment_reference, details
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
        ) RETURNING id, booking_reference, status, created_at`,
        [
          bookingReference, user_id || null, booking_type, 'confirmed', 'paid',
          lead_first_name, lead_last_name, lead_email, lead_mobile,
          product_title, product_code || null, check_in_date || null, check_out_date || null, travel_date || null,
          total_travellers || 1, total_adults || 1, total_children || 0,
          payment_amount, currency, payment_gateway, payment_reference,
          typeof details === 'string' ? JSON.parse(details) : details,
        ]
      );

      sendSuccess(res, rows[0], 'Booking created successfully', 201);
    } catch (err) {
      console.error('create booking error:', err);
      sendError(res, err, 'Failed to create booking', 500);
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
