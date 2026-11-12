/**
 * Account deletion — the customer's side.
 *
 *   GET    /api/user/account/deletion-request   latest request (or null)
 *   POST   /api/user/account/deletion-request   ask for deletion { reason? }
 *   DELETE /api/user/account/deletion-request   withdraw a pending request
 *
 * Nothing is deleted here. An admin approves the request in Admin → Account
 * Deletions (routes/admin/accountDeletions.js), which is what removes the
 * account. Google Play requires this path inside the app and on the web.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const userAuth = require('../../middleware/userAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

const FIELDS = 'id, status, reason, requested_at, decided_at, admin_note';

async function latestFor(userId) {
  const { rows } = await pool.query(
    `SELECT ${FIELDS} FROM account_deletion_requests
      WHERE user_id = $1 ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

router.get('/deletion-request', userAuth, async (req, res) => {
  try {
    sendSuccess(res, { request: await latestFor(req.user.id) });
  } catch (err) {
    sendError(res, err, 'Could not load your deletion request', 500);
  }
});

router.post(
  '/deletion-request',
  userAuth,
  body('reason').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendError(res, null, 'Reason is too long (1000 characters max)', 400);

    try {
      const current = await latestFor(req.user.id);
      if (current && current.status === 'pending') {
        return sendSuccess(res, { request: current }, 'Your deletion request is already with our team');
      }

      const { rows: users } = await pool.query(
        'SELECT id, email, first_middle_name, last_name FROM users WHERE id = $1',
        [req.user.id]
      );
      const user = users[0];
      if (!user) return sendError(res, null, 'Account not found', 404);

      const fullName = [user.first_middle_name, user.last_name].filter(Boolean).join(' ').trim() || null;
      await pool.query(
        `INSERT INTO account_deletion_requests (user_id, email, full_name, reason)
         VALUES ($1, $2, $3, $4)`,
        [user.id, user.email, fullName, req.body.reason || null]
      );

      sendSuccess(res, { request: await latestFor(user.id) }, 'Deletion request received', 201);
    } catch (err) {
      sendError(res, err, 'Could not submit your deletion request', 500);
    }
  }
);

router.delete('/deletion-request', userAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE account_deletion_requests
          SET status = 'cancelled', decided_at = NOW()
        WHERE user_id = $1 AND status = 'pending'`,
      [req.user.id]
    );
    sendSuccess(res, { request: await latestFor(req.user.id) }, 'Deletion request withdrawn');
  } catch (err) {
    sendError(res, err, 'Could not withdraw your deletion request', 500);
  }
});

module.exports = router;
