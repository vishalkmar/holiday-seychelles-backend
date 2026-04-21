const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

// Get all queries
router.get('/', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '', category = '', search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = `SELECT id, user_id, name, email, mobile, subject, category, status, 
                        created_at, updated_at
                 FROM queries`;
    let countQuery = 'SELECT COUNT(*) as total FROM queries';
    const params = [];
    const conditions = [];

    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }

    if (category) {
      conditions.push(`category = $${params.length + 1}`);
      params.push(category);
    }

    if (search) {
      conditions.push(`(name ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1} OR subject ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }

    if (conditions.length > 0) {
      const whereClause = ' WHERE ' + conditions.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const { rows } = await pool.query(query, [...params, limit, offset]);

    const { rows: countRows } = await pool.query(countQuery, params);

    sendSuccess(
      res,
      { queries: rows, total: parseInt(countRows[0].total), page, limit },
      'Queries retrieved successfully'
    );
  } catch (err) {
    console.error('get queries error:', err);
    sendError(res, err, 'Failed to get queries', 500);
  }
});

// Get query detail
router.get('/:queryId', adminAuth, async (req, res) => {
  try {
    const { queryId } = req.params;

    const { rows } = await pool.query(
      'SELECT * FROM queries WHERE id = $1',
      [queryId]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'Query not found', 404);
    }

    sendSuccess(res, rows[0], 'Query retrieved successfully');
  } catch (err) {
    console.error('get query detail error:', err);
    sendError(res, err, 'Failed to get query', 500);
  }
});

// Update query status and admin notes
router.patch(
  '/:queryId',
  adminAuth,
  body('status').optional().isIn(['new', 'in_progress', 'resolved', 'closed']),
  body('admin_notes').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { queryId } = req.params;
      const { id: adminId } = req.admin;
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

      // Mark as handled when moved to 'resolved' or 'closed'
      if (status && ['resolved', 'closed'].includes(status)) {
        updates.push(`handled_by_admin_id = $${paramIndex}`);
        params.push(adminId);
        paramIndex++;

        updates.push(`handled_at = NOW()`);
      }

      if (updates.length === 0) {
        return sendError(res, null, 'No fields to update', 400);
      }

      updates.push(`updated_at = NOW()`);
      params.push(queryId);

      const { rows } = await pool.query(
        `UPDATE queries SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        params
      );

      if (rows.length === 0) {
        return sendError(res, null, 'Query not found', 404);
      }

      sendSuccess(res, rows[0], 'Query updated successfully');
    } catch (err) {
      console.error('update query error:', err);
      sendError(res, err, 'Failed to update query', 500);
    }
  }
);

// Delete query
router.delete('/:queryId', adminAuth, async (req, res) => {
  try {
    const { queryId } = req.params;

    const { rows } = await pool.query(
      'DELETE FROM queries WHERE id = $1 RETURNING id',
      [queryId]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'Query not found', 404);
    }

    sendSuccess(res, { id: rows[0].id }, 'Query deleted successfully');
  } catch (err) {
    console.error('delete query error:', err);
    sendError(res, err, 'Failed to delete query', 500);
  }
});

module.exports = router;
