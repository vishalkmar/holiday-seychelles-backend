const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const userAuth = require('../../middleware/userAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

// Submit a query
router.post(
  '/',
  userAuth,
  body('name').trim().notEmpty(),
  body('email').isEmail(),
  body('subject').trim().notEmpty(),
  body('message').trim().notEmpty(),
  body('category').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { id: userId } = req.user;
      const { name, email, mobile, subject, category, message } = req.body;

      const { rows } = await pool.query(
        `INSERT INTO queries (user_id, name, email, mobile, subject, category, message, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, user_id, name, email, subject, status, created_at`,
        [userId, name, email, mobile || null, subject, category || 'general', message, 'contact_form']
      );

      sendSuccess(res, rows[0], 'Query submitted successfully', 201);
    } catch (err) {
      console.error('submit query error:', err);
      sendError(res, err, 'Failed to submit query', 500);
    }
  }
);

// Get user's queries
router.get('/', userAuth, async (req, res) => {
  try {
    const { id: userId } = req.user;

    const { rows } = await pool.query(
      `SELECT id, user_id, name, email, subject, category, status, created_at, updated_at
       FROM queries
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    sendSuccess(res, { queries: rows, total: rows.length }, 'Queries retrieved successfully');
  } catch (err) {
    console.error('get queries error:', err);
    sendError(res, err, 'Failed to get queries', 500);
  }
});

module.exports = router;
