/**
 * Account deletion requests — the admin's side.
 *
 *   GET  /api/admin/account-deletions?status=pending|approved|rejected|cancelled|all
 *   POST /api/admin/account-deletions/:id/approve   { note? }  deletes the account
 *   POST /api/admin/account-deletions/:id/reject    { note }
 *
 * Mounted behind guardFor('customers'): viewing needs customers.view, deciding
 * needs customers.manage.
 *
 * What approval deletes: the users row, the wishlist, the assistant's memory of
 * the person, their one-time codes, and every login session. What it keeps:
 * bookings, payment orders and support queries — tax and accounting law needs
 * those, and their user_id foreign keys are ON DELETE SET NULL, so they simply
 * stop pointing at an account. The request row itself is kept as the record
 * that the deletion was asked for and carried out.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');

const router = express.Router();

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

router.get('/', async (req, res) => {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : req.query.status === 'all' ? null : 'pending';
    const { rows } = await pool.query(
      `SELECT r.id, r.user_id, r.email, r.full_name, r.reason, r.status, r.requested_at,
              r.decided_at, r.decided_by_email, r.admin_note,
              u.created_at AS account_created_at, u.last_login_at,
              (SELECT COUNT(*) FROM bookings b WHERE b.user_id = r.user_id) AS bookings
         FROM account_deletion_requests r
         LEFT JOIN users u ON u.id = r.user_id
        ${status ? 'WHERE r.status = $1' : ''}
        ORDER BY r.requested_at DESC, r.id DESC
        LIMIT 500`,
      status ? [status] : []
    );
    const { rows: counts } = await pool.query(
      'SELECT status, COUNT(*) AS n FROM account_deletion_requests GROUP BY status'
    );
    const summary = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const c of counts) summary[c.status] = Number(c.n);
    sendSuccess(res, {
      requests: rows.map((r) => ({ ...r, bookings: Number(r.bookings || 0) })),
      summary,
    });
  } catch (err) {
    sendError(res, err, 'Could not load deletion requests', 500);
  }
});

const noteRule = body('note').optional({ nullable: true }).isString().trim().isLength({ max: 1000 });

router.post('/:id/approve', noteRule, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendError(res, null, 'Note is too long (1000 characters max)', 400);

  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, user_id, email, status FROM account_deletion_requests WHERE id = $1 FOR UPDATE',
      [id]
    );
    const request = rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return sendError(res, null, 'Request not found', 404);
    }
    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return sendError(res, null, `This request is already ${request.status}`, 409);
    }

    const userId = request.user_id;
    if (userId) {
      await client.query('DELETE FROM user_wishlist WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM chat_user_profile WHERE user_id = $1', [userId]);
      await client.query('UPDATE chat_sessions SET user_id = NULL WHERE user_id = $1', [userId]);
      await client.query(
        `UPDATE auth_tokens SET revoked_at = NOW()
          WHERE subject_type = 'user' AND subject_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    await client.query('DELETE FROM email_otps WHERE email = $1', [request.email]);
    await client.query(
      `UPDATE account_deletion_requests
          SET status = 'approved', decided_at = NOW(), decided_by = $2, decided_by_email = $3, admin_note = $4
        WHERE id = $1`,
      [id, req.admin.id, req.admin.email, req.body.note || null]
    );
    await client.query('COMMIT');

    await sec.audit({
      req,
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      action: 'customer.account_deleted',
      entityType: 'user',
      entityId: userId,
      summary: `Deleted customer account ${request.email} (deletion request #${id})`,
      metadata: { requestId: id },
    });
    sendSuccess(res, { id, status: 'approved' }, 'Account deleted');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err, 'Could not delete the account', 500);
  } finally {
    client.release();
  }
});

router.post(
  '/:id/reject',
  body('note')
    .isString().withMessage('Say why the request is rejected').bail()
    .trim().isLength({ min: 1, max: 1000 }).withMessage('Say why the request is rejected (1000 characters max)'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return sendError(res, null, errors.array()[0].msg, 400);

    try {
      const id = Number(req.params.id);
      const { rows } = await pool.query('SELECT id, email, status FROM account_deletion_requests WHERE id = $1', [id]);
      const request = rows[0];
      if (!request) return sendError(res, null, 'Request not found', 404);
      if (request.status !== 'pending') return sendError(res, null, `This request is already ${request.status}`, 409);

      await pool.query(
        `UPDATE account_deletion_requests
            SET status = 'rejected', decided_at = NOW(), decided_by = $2, decided_by_email = $3, admin_note = $4
          WHERE id = $1`,
        [id, req.admin.id, req.admin.email, req.body.note]
      );
      await sec.audit({
        req,
        adminId: req.admin.id,
        adminEmail: req.admin.email,
        action: 'customer.account_deletion_rejected',
        entityType: 'account_deletion_request',
        entityId: id,
        summary: `Rejected deletion request #${id} for ${request.email}`,
        metadata: { note: req.body.note },
      });
      sendSuccess(res, { id, status: 'rejected' }, 'Request rejected');
    } catch (err) {
      sendError(res, err, 'Could not reject the request', 500);
    }
  }
);

module.exports = router;
