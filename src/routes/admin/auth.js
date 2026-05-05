const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const { comparePassword } = require('../../utils/password');
const { signAdminToken } = require('../../utils/jwt');
const { sendSuccess, sendError } = require('../../utils/response');
const adminAuth = require('../../middleware/adminAuth');

const router = express.Router();

// ENV-based master admin credentials.
// When the incoming email matches ADMIN_SEED_EMAIL, the password is verified
// directly against ADMIN_SEED_PASSWORD (plain-text) instead of the DB hash.
// This means you control the admin password entirely through the .env file —
// no need to re-seed the DB when you change the password.
// The DB record is still required for the admin ID (used in JWT / audit trail);
// run `npm run seed:admin` once after changing ADMIN_SEED_EMAIL or NAME.
const ENV_ADMIN_EMAIL    = (process.env.ADMIN_SEED_EMAIL    || '').toLowerCase().trim();
const ENV_ADMIN_PASSWORD =  process.env.ADMIN_SEED_PASSWORD || '';

// Admin login
router.post(
  '/login',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { email, password } = req.body;

      // ── ENV-credential path ─────────────────────────────────────────────────
      // If the login email matches the master admin email in .env, verify the
      // plain-text password directly from .env (no DB hash comparison needed).
      if (ENV_ADMIN_EMAIL && ENV_ADMIN_PASSWORD && email.toLowerCase() === ENV_ADMIN_EMAIL) {
        if (password !== ENV_ADMIN_PASSWORD) {
          return sendError(res, null, 'Invalid email or password', 401);
        }

        // Still need the DB record for the admin ID (JWT subject).
        const { rows: envRows } = await pool.query(
          'SELECT id, email, name, role, status FROM admins WHERE LOWER(email) = $1 LIMIT 1',
          [ENV_ADMIN_EMAIL]
        );
        if (envRows.length === 0) {
          return sendError(
            res, null,
            'Admin account not found in database. Run: npm run seed:admin',
            401
          );
        }
        const admin = envRows[0];
        if (admin.status !== 'active') {
          return sendError(res, null, 'Admin account is inactive', 403);
        }

        const { token, jti, expiresAt } = signAdminToken(admin.id);
        await pool.query(
          `INSERT INTO auth_tokens (jti, subject_type, subject_id, expires_at, ip_address, user_agent)
           VALUES ($1, 'admin', $2, $3, $4, $5)`,
          [jti, admin.id, expiresAt, req.ip, req.get('user-agent')]
        );
        await pool.query('UPDATE admins SET last_login_at = NOW() WHERE id = $1', [admin.id]);
        res.cookie('adminToken', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'Strict',
          maxAge: 24 * 60 * 60 * 1000,
        });
        return sendSuccess(
          res,
          { token, adminId: admin.id, email: admin.email, name: admin.name, role: admin.role },
          'Admin login successful',
          200
        );
      }

      // ── DB-credential path (non-ENV admins) ────────────────────────────────
      const { rows } = await pool.query(
        'SELECT id, email, password_hash, name, role, status FROM admins WHERE email = $1',
        [email]
      );

      if (rows.length === 0) {
        return sendError(res, null, 'Invalid email or password', 401);
      }

      const admin = rows[0];

      if (admin.status !== 'active') {
        return sendError(res, null, 'Admin account is inactive', 403);
      }

      const passwordMatch = await comparePassword(password, admin.password_hash);
      if (!passwordMatch) {
        return sendError(res, null, 'Invalid email or password', 401);
      }

      // Sign token
      const { token, jti, expiresAt } = signAdminToken(admin.id);

      await pool.query(
        `INSERT INTO auth_tokens (jti, subject_type, subject_id, expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [jti, 'admin', admin.id, expiresAt, req.ip, req.get('user-agent')]
      );

      await pool.query(
        'UPDATE admins SET last_login_at = NOW() WHERE id = $1',
        [admin.id]
      );

      res.cookie('adminToken', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge: 24 * 60 * 60 * 1000,
      });

      sendSuccess(
        res,
        { token, adminId: admin.id, email: admin.email, name: admin.name, role: admin.role },
        'Admin login successful',
        200
      );
    } catch (err) {
      console.error('admin login error:', err);
      sendError(res, err, 'Failed to login', 500);
    }
  }
);

// Admin logout
router.post('/logout', adminAuth, async (req, res) => {
  try {
    const { jti } = req.admin;

    // Revoke token
    await pool.query(
      'UPDATE auth_tokens SET revoked_at = NOW() WHERE jti = $1',
      [jti]
    );

    // Clear cookie
    res.clearCookie('adminToken');

    sendSuccess(res, {}, 'Admin logged out successfully', 200);
  } catch (err) {
    console.error('admin logout error:', err);
    sendError(res, err, 'Failed to logout', 500);
  }
});

module.exports = router;
