const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const { comparePassword } = require('../../utils/password');
const { signAdminToken } = require('../../utils/jwt');
const { sendSuccess, sendError } = require('../../utils/response');
const adminAuth = require('../../middleware/adminAuth');

const router = express.Router();

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

      // Find admin
      const { rows } = await pool.query(
        'SELECT id, email, password_hash, name, role, status FROM admins WHERE email = $1',
        [email]
      );

      if (rows.length === 0) {
        return sendError(res, null, 'Invalid email or password', 401);
      }

      const admin = rows[0];

      // Check status
      if (admin.status !== 'active') {
        return sendError(res, null, 'Admin account is inactive', 403);
      }

      // Verify password
      const passwordMatch = await comparePassword(password, admin.password_hash);
      if (!passwordMatch) {
        return sendError(res, null, 'Invalid email or password', 401);
      }

      // Sign token
      const { token, jti, expiresAt } = signAdminToken(admin.id);

      // Log token in auth_tokens table
      await pool.query(
        `INSERT INTO auth_tokens (jti, subject_type, subject_id, expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [jti, 'admin', admin.id, expiresAt, req.ip, req.get('user-agent')]
      );

      // Update last login
      await pool.query(
        'UPDATE admins SET last_login_at = NOW() WHERE id = $1',
        [admin.id]
      );

      // Set cookie
      res.cookie('adminToken', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge: 24 * 60 * 60 * 1000, // 1 day
      });

      sendSuccess(
        res,
        {
          token,
          adminId: admin.id,
          email: admin.email,
          name: admin.name,
          role: admin.role,
        },
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
