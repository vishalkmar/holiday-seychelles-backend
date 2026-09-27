const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const { comparePassword } = require('../../utils/password');
const { signAdminToken } = require('../../utils/jwt');
const { sendSuccess, sendError } = require('../../utils/response');
const adminAuth = require('../../middleware/adminAuth');
const totp = require('../../utils/totp');
const sec = require('../../services/adminSecurity');
const { sendAdminOtpEmail, sendNewDeviceAlert } = require('../../utils/adminEmails');

const router = express.Router();

/**
 * Admin sign-in.
 *
 * Two steps when a second factor is switched on: the password earns a
 * short-lived challenge id, and only a verified code turns that into a session
 * token. Nothing usable as a session is handed out before the second factor,
 * so a leaked password alone opens nothing.
 *
 * ENV-based master admin: when the email matches ADMIN_SEED_EMAIL the password
 * is checked against ADMIN_SEED_PASSWORD instead of the stored hash, so the
 * master password lives in .env. The DB row is still needed for the admin id.
 */

const ENV_ADMIN_EMAIL = (process.env.ADMIN_SEED_EMAIL || '').toLowerCase().trim();
const ENV_ADMIN_PASSWORD = process.env.ADMIN_SEED_PASSWORD || '';

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return email;
  const shown = user.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

/** Mint the session token, record the device, alert on a new one. */
async function issueSession(req, res, admin, { via, remember = false }) {
  const { token, jti, expiresAt } = signAdminToken(admin.id, { remember });
  const fingerprint = sec.deviceFingerprint(req);
  const knownDevice = await sec.isKnownDevice(admin.id, fingerprint);

  await pool.query(
    `INSERT INTO auth_tokens (jti, subject_type, subject_id, expires_at, ip_address, user_agent)
     VALUES ($1, 'admin', $2, $3, $4, $5)`,
    [jti, admin.id, expiresAt, sec.clientIp(req), (req.get('user-agent') || '').slice(0, 500)]
  );
  await pool.query('UPDATE admins SET last_login_at = NOW() WHERE id = $1', [admin.id]);

  await sec.recordAttempt({ req, email: admin.email, adminId: admin.id, successful: true });
  await sec.audit({
    req,
    adminId: admin.id,
    adminEmail: admin.email,
    action: 'admin.login',
    summary: `Signed in via ${via}`,
    metadata: { via, newDevice: !knownDevice },
  });

  if (!knownDevice) {
    sendNewDeviceAlert({
      to: admin.email,
      name: admin.name,
      ip: sec.clientIp(req),
      userAgent: req.get('user-agent'),
      when: new Date().toUTCString(),
    }).catch((err) => console.error('new device alert failed:', err.message));
  }

  res.cookie('adminToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    maxAge: 24 * 60 * 60 * 1000,
  });

  return {
    token,
    adminId: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
  };
}

/** Resolve credentials through either the ENV master path or the DB. */
async function authenticate(email, password) {
  const lower = String(email || '').toLowerCase();

  if (ENV_ADMIN_EMAIL && ENV_ADMIN_PASSWORD && lower === ENV_ADMIN_EMAIL) {
    if (password !== ENV_ADMIN_PASSWORD) return { error: 'Invalid email or password', code: 401 };

    const { rows } = await pool.query(
      'SELECT id, email, name, role, status FROM admins WHERE LOWER(email) = $1 LIMIT 1',
      [ENV_ADMIN_EMAIL]
    );
    if (!rows.length) {
      return { error: 'Admin account not found in database. Run: npm run seed:admin', code: 401 };
    }
    if (rows[0].status !== 'active') return { error: 'Admin account is inactive', code: 403 };
    return { admin: rows[0] };
  }

  const { rows } = await pool.query(
    'SELECT id, email, password_hash, name, role, status FROM admins WHERE email = $1',
    [email]
  );
  if (!rows.length) return { error: 'Invalid email or password', code: 401 };

  const admin = rows[0];
  if (admin.status !== 'active') return { error: 'Admin account is inactive', code: 403 };

  const ok = await comparePassword(password, admin.password_hash);
  if (!ok) return { error: 'Invalid email or password', code: 401 };

  return { admin };
}

// ── POST /login ──────────────────────────────────────────────────────────────
router.post(
  '/login',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const lockout = await sec.checkLockout({ req, email });
      if (lockout.locked) {
        await sec.audit({
          req,
          adminEmail: email,
          action: 'admin.login.blocked',
          summary: 'Blocked by lockout',
          status: 'blocked',
        });
        return sendError(
          res,
          null,
          `Too many failed attempts. Try again in ${lockout.windowMinutes} minutes.`,
          429
        );
      }

      const result = await authenticate(email, password);
      if (result.error) {
        await sec.recordAttempt({
          req,
          email,
          successful: false,
          reason: result.code === 403 ? 'inactive' : 'bad_credentials',
        });
        const left = Math.max(0, lockout.remaining - 1);
        const suffix = left > 0 && left <= 2 ? ` ${left} attempt(s) left.` : '';
        return sendError(res, null, result.error + suffix, result.code);
      }

      const admin = result.admin;
      const security = await sec.getSecurity(admin.id);

      // ── Password accepted; is a second factor required? ──────────────────
      if (sec.mfaEnabled(security)) {
        const method = security.totp_enabled ? 'totp' : 'email';
        const challenge = await sec.createChallenge({ req, adminId: admin.id, method });

        if (method === 'email') {
          const to = security.email_otp_address || admin.email;
          await sendAdminOtpEmail({
            to,
            code: challenge.emailCode,
            name: admin.name,
            ttlMinutes: sec.CHALLENGE_TTL_MINUTES,
            ip: sec.clientIp(req),
          });
        }

        await sec.audit({
          req,
          adminId: admin.id,
          adminEmail: admin.email,
          action: 'admin.login.mfa_required',
          summary: `Password accepted, awaiting ${method} code`,
        });

        return sendSuccess(
          res,
          {
            mfaRequired: true,
            challengeId: challenge.challengeId,
            method,
            sentTo: method === 'email' ? maskEmail(security.email_otp_address || admin.email) : null,
            expiresAt: challenge.expiresAt,
          },
          method === 'totp'
            ? 'Enter the code from your authenticator app'
            : 'We emailed you a sign-in code',
          200
        );
      }

      const session = await issueSession(req, res, admin, {
        via: 'password',
        // "Keep me signed in". The server caps how long this can be.
        remember: req.body?.remember === true,
      });
      return sendSuccess(res, session, 'Admin login successful', 200);
    } catch (err) {
      console.error('admin login error:', err);
      return sendError(res, err, 'Failed to login', 500);
    }
  }
);

// ── POST /login/verify ───────────────────────────────────────────────────────
// Second step: exchange a challenge + code for a session.
router.post(
  '/login/verify',
  body('challengeId').trim().notEmpty(),
  body('code').optional().trim(),
  body('recoveryCode').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    const { challengeId, code, recoveryCode } = req.body;
    if (!code && !recoveryCode) {
      return sendError(res, null, 'Enter your code', 400);
    }

    try {
      const challenge = await sec.loadChallenge(challengeId);
      const problem = sec.challengeProblem(challenge);
      if (problem) return sendError(res, null, problem, 401);

      const { rows } = await pool.query(
        'SELECT id, email, name, role, status FROM admins WHERE id = $1',
        [challenge.admin_id]
      );
      if (!rows.length) return sendError(res, null, 'Admin account not found', 401);
      const admin = rows[0];
      if (admin.status !== 'active') return sendError(res, null, 'Admin account is inactive', 403);

      const security = await sec.getSecurity(admin.id);

      let verified = false;
      let via = challenge.method;

      if (recoveryCode) {
        verified = await sec.consumeRecoveryCode(admin.id, recoveryCode);
        via = 'recovery-code';
      } else if (challenge.method === 'totp') {
        verified = security.totp_secret ? totp.verify(security.totp_secret, code) : false;
      } else {
        verified = sec.verifyEmailCode(challenge, code);
      }

      if (!verified) {
        await sec.bumpChallengeAttempts(challengeId);
        await sec.recordAttempt({
          req,
          email: admin.email,
          adminId: admin.id,
          successful: false,
          reason: 'bad_mfa_code',
        });
        await sec.audit({
          req,
          adminId: admin.id,
          adminEmail: admin.email,
          action: 'admin.login.mfa_failed',
          summary: `Incorrect ${via} code`,
          status: 'failed',
        });
        return sendError(res, null, 'That code is not right. Please try again.', 401);
      }

      await sec.markChallengeUsed(challengeId);
      await pool.query('UPDATE admin_security SET last_verified_at = NOW() WHERE admin_id = $1', [
        admin.id,
      ]);

      const session = await issueSession(req, res, admin, {
        via,
        // The challenge row does not carry it, so the second step re-states
        // what the operator ticked on the first. The server still caps it.
        remember: req.body?.remember === true,
      });

      if (via === 'recovery-code') {
        const status = await sec.recoveryCodeStatus(admin.id);
        return sendSuccess(
          res,
          { ...session, recoveryCodesRemaining: status.remaining },
          `Signed in with a recovery code. ${status.remaining} left.`,
          200
        );
      }

      return sendSuccess(res, session, 'Admin login successful', 200);
    } catch (err) {
      console.error('admin mfa verify error:', err);
      return sendError(res, err, 'Failed to verify code', 500);
    }
  }
);

// ── POST /login/resend ───────────────────────────────────────────────────────
router.post('/login/resend', body('challengeId').trim().notEmpty(), async (req, res) => {
  try {
    const challenge = await sec.loadChallenge(req.body.challengeId);
    const problem = sec.challengeProblem(challenge);
    if (problem) return sendError(res, null, problem, 401);
    if (challenge.method !== 'email') {
      return sendError(res, null, 'This sign-in does not use an emailed code', 400);
    }

    const { rows } = await pool.query('SELECT id, email, name FROM admins WHERE id = $1', [
      challenge.admin_id,
    ]);
    if (!rows.length) return sendError(res, null, 'Admin account not found', 401);

    const admin = rows[0];
    const security = await sec.getSecurity(admin.id);

    // A resend is a brand-new challenge; the old one is retired so only the
    // newest code ever works.
    await sec.markChallengeUsed(challenge.challenge_id);
    const next = await sec.createChallenge({ req, adminId: admin.id, method: 'email' });
    await sendAdminOtpEmail({
      to: security.email_otp_address || admin.email,
      code: next.emailCode,
      name: admin.name,
      ttlMinutes: sec.CHALLENGE_TTL_MINUTES,
      ip: sec.clientIp(req),
    });

    return sendSuccess(
      res,
      { challengeId: next.challengeId, expiresAt: next.expiresAt },
      'A new code is on its way',
      200
    );
  } catch (err) {
    console.error('admin mfa resend error:', err);
    return sendError(res, err, 'Failed to resend code', 500);
  }
});

// ── POST /logout ─────────────────────────────────────────────────────────────
router.post('/logout', adminAuth, async (req, res) => {
  try {
    const { jti, id } = req.admin;
    await pool.query('UPDATE auth_tokens SET revoked_at = NOW() WHERE jti = $1', [jti]);
    await sec.audit({ req, adminId: id, action: 'admin.logout', summary: 'Signed out' });
    res.clearCookie('adminToken');
    sendSuccess(res, {}, 'Admin logged out successfully', 200);
  } catch (err) {
    console.error('admin logout error:', err);
    sendError(res, err, 'Failed to logout', 500);
  }
});

module.exports = router;
