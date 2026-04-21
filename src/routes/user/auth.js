const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const { generateOTP, hashOTP, verifyOTP } = require('../../utils/otp');
const { sendOTPEmail } = require('../../utils/mailer');
const { signUserToken } = require('../../utils/jwt');
const { sendSuccess, sendError } = require('../../utils/response');
const userAuth = require('../../middleware/userAuth');

const router = express.Router();

const userSelectFields = `
  id, email, first_middle_name, last_name, gender, date_of_birth,
  country, mobile_country_code, mobile_number, is_profile_complete,
  status, created_at, updated_at
`;

// Send OTP to email
router.post(
  '/send-otp',
  body('email').isEmail().normalizeEmail(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { email } = req.body;

      // Check rate limit: max 1 OTP request per minute per email
      const { rows: recentOtps } = await pool.query(
        `SELECT id FROM email_otps 
         WHERE email = $1 AND purpose = 'user_login' 
         AND created_at > NOW() - INTERVAL '1 minute'
         ORDER BY created_at DESC LIMIT 1`,
        [email]
      );

      if (recentOtps.length > 0) {
        return sendError(
          res,
          null,
          'Please wait before requesting another OTP',
          429
        );
      }

      // Generate OTP
      const otp = generateOTP(6);
      const codeHash = hashOTP(otp);
      const ttlMinutes = parseInt(process.env.OTP_TTL_MINUTES || '10');
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

      // Store OTP hash in database
      await pool.query(
        `INSERT INTO email_otps (email, purpose, code_hash, expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          email,
          'user_login',
          codeHash,
          expiresAt,
          req.ip,
          req.get('user-agent'),
        ]
      );

      // Send OTP email
      const mailResult = await sendOTPEmail(email, otp);

      if (!mailResult.success) {
        return sendError(res, mailResult.error, 'Failed to send OTP email', 500);
      }

      sendSuccess(
        res,
        { message: 'OTP sent to your email' },
        'OTP sent successfully'
      );
    } catch (err) {
      console.error('send-otp error:', err);
      sendError(res, err, 'Failed to send OTP', 500);
    }
  }
);

// Verify OTP - this also creates the user if doesn't exist
router.post(
  '/verify-otp',
  body('email').isEmail().normalizeEmail(),
  body('otp').isLength({ min: 6, max: 6 }).isNumeric(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { email, otp } = req.body;

      // Find most recent non-consumed OTP for this email
      const { rows: otpRows } = await pool.query(
        `SELECT id, code_hash, attempts, max_attempts, consumed_at, expires_at
         FROM email_otps
         WHERE email = $1 AND purpose = 'user_login'
         ORDER BY created_at DESC LIMIT 1`,
        [email]
      );

      if (otpRows.length === 0) {
        return sendError(res, null, 'No OTP found for this email', 400);
      }

      const otpRecord = otpRows[0];

      // Check if already consumed
      if (otpRecord.consumed_at) {
        return sendError(res, null, 'OTP already used', 400);
      }

      // Check if expired
      if (new Date(otpRecord.expires_at) < new Date()) {
        return sendError(res, null, 'OTP expired', 400);
      }

      // Check max attempts
      if (otpRecord.attempts >= otpRecord.max_attempts) {
        return sendError(res, null, 'Max OTP attempts exceeded', 429);
      }

      // Verify OTP hash
      const plainHash = hashOTP(otp);
      if (plainHash !== otpRecord.code_hash) {
        // Increment attempts
        await pool.query(
          'UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1',
          [otpRecord.id]
        );
        return sendError(res, null, 'Invalid OTP', 400);
      }

      // Mark OTP as consumed
      await pool.query(
        'UPDATE email_otps SET consumed_at = NOW() WHERE id = $1',
        [otpRecord.id]
      );

      // Find or create user
      let userId;
      const { rows: userRows } = await pool.query(
        `SELECT ${userSelectFields} FROM users WHERE email = $1`,
        [email]
      );

      let user;
      if (userRows.length > 0) {
        user = userRows[0];
        userId = user.id;
      } else {
        // Create new user
        const { rows: newUserRows } = await pool.query(
          `INSERT INTO users (email) VALUES ($1) RETURNING ${userSelectFields}`,
          [email]
        );
        user = newUserRows[0];
        userId = user.id;
      }

      // Update last login
      const { rows: refreshedUserRows } = await pool.query(
        `UPDATE users SET last_login_at = NOW() WHERE id = $1 RETURNING ${userSelectFields}, last_login_at`,
        [userId]
      );
      user = refreshedUserRows[0] || user;

      // Sign token
      const { token, jti, expiresAt } = signUserToken(userId);

      // Log token in auth_tokens table
      await pool.query(
        `INSERT INTO auth_tokens (jti, subject_type, subject_id, expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [jti, 'user', userId, expiresAt, req.ip, req.get('user-agent')]
      );

      // Set cookie
      res.cookie('userToken', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });

      sendSuccess(
        res,
        { token, userId, user },
        'OTP verified successfully',
        200
      );
    } catch (err) {
      console.error('verify-otp error:', err);
      sendError(res, err, 'Failed to verify OTP', 500);
    }
  }
);

// Complete user profile after OTP login
router.post(
  '/complete-profile',
  userAuth,
  body('first_middle_name').trim().notEmpty(),
  body('last_name').trim().notEmpty(),
  body('mobile_number').optional().trim(),
  body('mobile_country_code').optional().trim(),
  body('country').optional().trim(),
  body('date_of_birth').optional().isISO8601(),
  body('gender').optional().isIn(['male', 'female', 'other']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { id: userId } = req.user;
      const {
        first_middle_name,
        last_name,
        mobile_number = null,
        mobile_country_code = null,
        country = null,
        date_of_birth = null,
        gender = null,
      } = req.body;

      // Update user profile
      const { rows } = await pool.query(
        `UPDATE users 
         SET first_middle_name = $1,
             last_name = $2,
             mobile_number = COALESCE($3, mobile_number),
             mobile_country_code = COALESCE($4, mobile_country_code),
             country = COALESCE($5, country),
             date_of_birth = COALESCE($6, date_of_birth),
             gender = COALESCE($7, gender),
             is_profile_complete = true,
             updated_at = NOW()
         WHERE id = $8
         RETURNING ${userSelectFields}, last_login_at`,
        [
          first_middle_name,
          last_name,
          mobile_number,
          mobile_country_code,
          country,
          date_of_birth,
          gender,
          userId,
        ]
      );

      if (rows.length === 0) {
        return sendError(res, null, 'User not found', 404);
      }

      sendSuccess(res, rows[0], 'Profile completed successfully', 200);
    } catch (err) {
      console.error('complete-profile error:', err);
      sendError(res, err, 'Failed to complete profile', 500);
    }
  }
);

// Logout - revoke token
router.post('/logout', userAuth, async (req, res) => {
  try {
    const { jti } = req.user;

    // Revoke token
    await pool.query(
      'UPDATE auth_tokens SET revoked_at = NOW() WHERE jti = $1',
      [jti]
    );

    // Clear cookie
    res.clearCookie('userToken');

    sendSuccess(res, {}, 'Logged out successfully', 200);
  } catch (err) {
    console.error('logout error:', err);
    sendError(res, err, 'Failed to logout', 500);
  }
});

module.exports = router;
