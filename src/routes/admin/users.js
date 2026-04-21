const express = require('express');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

// Get all users with pagination
router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const requestedLimit = parseInt(req.query.limit || '50', 10);
    const limit = Math.min(Math.max(requestedLimit, 1), 100);
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    let query = 'SELECT id, email, first_middle_name, last_name, mobile_number, status, is_profile_complete, last_login_at, created_at FROM users';
    let countQuery = 'SELECT COUNT(*) as total FROM users';
    const params = [];

    if (search) {
      query += ' WHERE email ILIKE $1 OR first_middle_name ILIKE $1 OR last_name ILIKE $1';
      countQuery += ' WHERE email ILIKE $1 OR first_middle_name ILIKE $1 OR last_name ILIKE $1';
      params.push(`%${search}%`);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const { rows } = await pool.query(query, [...params, limit, offset]);

    const { rows: countRows } = await pool.query(countQuery, params);

    sendSuccess(
      res,
      { users: rows, total: parseInt(countRows[0].total), page, limit },
      'Users retrieved successfully'
    );
  } catch (err) {
    console.error('get users error:', err);
    sendError(res, err, 'Failed to get users', 500);
  }
});

// Get user detail
router.get('/:userId', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'User not found', 404);
    }

    sendSuccess(res, rows[0], 'User retrieved successfully');
  } catch (err) {
    console.error('get user detail error:', err);
    sendError(res, err, 'Failed to get user', 500);
  }
});

// Update user status
router.patch('/:userId/status', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive', 'suspended'].includes(status)) {
      return sendError(res, null, 'Invalid status', 400);
    }

    const { rows } = await pool.query(
      'UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, status',
      [status, userId]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'User not found', 404);
    }

    sendSuccess(res, rows[0], 'User status updated successfully');
  } catch (err) {
    console.error('update user status error:', err);
    sendError(res, err, 'Failed to update user status', 500);
  }
});

module.exports = router;
