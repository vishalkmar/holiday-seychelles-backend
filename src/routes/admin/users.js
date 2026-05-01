const express = require('express');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

// Get all users with pagination + filters (status, profile_complete, date range)
router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const requestedLimit = parseInt(req.query.limit || '50', 10);
    const limit = Math.min(Math.max(requestedLimit, 1), 100);
    const search = req.query.search || '';
    const status = req.query.status || '';
    const profileComplete = req.query.profile_complete || ''; // 'true' | 'false' | ''
    const dateFrom = req.query.date_from || '';
    const dateTo = req.query.date_to || '';
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(email ILIKE $${params.length} OR first_middle_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR mobile_number ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (profileComplete === 'true' || profileComplete === 'false') {
      params.push(profileComplete === 'true');
      conditions.push(`is_profile_complete = $${params.length}`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`created_at >= $${params.length}::date`);
    }
    if (dateTo) {
      params.push(dateTo);
      conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const query = `SELECT id, email, first_middle_name, last_name, mobile_number, status, is_profile_complete, last_login_at, created_at FROM users${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const countQuery = `SELECT COUNT(*) as total FROM users${whereClause}`;

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

// Get user bookings + payment summary (for detail drawer)
router.get('/:userId/bookings', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    const { rows: bookings } = await pool.query(
      `SELECT id, booking_reference, booking_type, status, payment_status,
              payment_amount, currency, product_title, travel_date,
              check_in_date, check_out_date, voucher_path, voucher_generated_at,
              created_at
       FROM bookings
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    // Aggregate stats per currency
    const totalsByCurrency = {};
    let confirmedCount = 0;
    let cancelledCount = 0;
    let refundedCount = 0;

    for (const b of bookings) {
      const cur = b.currency || 'INR';
      if (!totalsByCurrency[cur]) totalsByCurrency[cur] = 0;
      if (b.payment_status === 'paid') {
        totalsByCurrency[cur] += Number(b.payment_amount || 0);
      }
      if (b.status === 'confirmed') confirmedCount++;
      else if (b.status === 'cancelled') cancelledCount++;
      else if (b.status === 'refunded') refundedCount++;
    }

    sendSuccess(
      res,
      {
        bookings,
        summary: {
          total: bookings.length,
          confirmed: confirmedCount,
          cancelled: cancelledCount,
          refunded: refundedCount,
          totalsByCurrency,
        },
      },
      'User bookings retrieved successfully'
    );
  } catch (err) {
    console.error('get user bookings error:', err);
    sendError(res, err, 'Failed to get user bookings', 500);
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
