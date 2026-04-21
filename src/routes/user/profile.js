const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const userAuth = require('../../middleware/userAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

// Get user profile
router.get('/', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;

    const { rows } = await pool.query(
      `SELECT id, email, first_middle_name, last_name, gender, date_of_birth, 
              nationality, marital_status, anniversary, city_of_residence, state, country,
              mobile_country_code, mobile_number, mobile_verified, passport_no, passport_expiry,
              passport_issuing_country, pan_card_number, profile_image, is_profile_complete,
              status, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'User not found', 404);
    }

    sendSuccess(res, rows[0], 'Profile retrieved successfully');
  } catch (err) {
    console.error('get profile error:', err);
    sendError(res, err, 'Failed to get profile', 500);
  }
});

// Update user profile
router.put(
  '/',
  userAuth,
  body('first_middle_name').optional().trim(),
  body('last_name').optional().trim(),
  body('email').optional().isEmail(),
  body('gender').optional().isIn(['male', 'female', 'other']),
  body('date_of_birth').optional().isISO8601(),
  body('nationality').optional().trim(),
  body('marital_status').optional().trim(),
  body('anniversary').optional().isISO8601(),
  body('city_of_residence').optional().trim(),
  body('state').optional().trim(),
  body('country').optional().trim(),
  body('mobile_country_code').optional().trim(),
  body('mobile_number').optional().trim(),
  body('passport_no').optional().trim(),
  body('passport_expiry').optional().isISO8601(),
  body('passport_issuing_country').optional().trim(),
  body('pan_card_number').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { id: userId } = req.user;
      const updates = req.body;

      // Build dynamic update query
      const allowedFields = [
        'first_middle_name', 'last_name', 'gender', 'date_of_birth',
        'nationality', 'marital_status', 'anniversary', 'city_of_residence',
        'state', 'country', 'mobile_country_code', 'mobile_number',
        'passport_no', 'passport_expiry', 'passport_issuing_country',
        'pan_card_number', 'profile_image'
      ];

      const setClause = [];
      const values = [];
      let paramIndex = 1;

      for (const field of allowedFields) {
        if (field in updates) {
          setClause.push(`${field} = $${paramIndex}`);
          values.push(updates[field]);
          paramIndex++;
        }
      }

      if (setClause.length === 0) {
        return sendError(res, null, 'No fields to update', 400);
      }

      // Check if profile is now complete (has first_middle_name and last_name)
      const updatedData = { ...updates };
      const { rows: currentUser } = await pool.query(
        'SELECT first_middle_name, last_name FROM users WHERE id = $1',
        [userId]
      );
      const firstName = updatedData.first_middle_name || currentUser[0]?.first_middle_name;
      const lastName = updatedData.last_name || currentUser[0]?.last_name;
      const isComplete = firstName && lastName;

      setClause.push(`is_profile_complete = $${paramIndex}`);
      values.push(isComplete);
      paramIndex++;

      setClause.push(`updated_at = NOW()`);

      values.push(userId);

      const query = `UPDATE users SET ${setClause.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

      const { rows } = await pool.query(query, values);

      if (rows.length === 0) {
        return sendError(res, null, 'User not found', 404);
      }

      sendSuccess(res, rows[0], 'Profile updated successfully');
    } catch (err) {
      console.error('update profile error:', err);
      sendError(res, err, 'Failed to update profile', 500);
    }
  }
);

module.exports = router;
