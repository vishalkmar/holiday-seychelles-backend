/**
 * Admin security settings.
 *
 * Two rules run through this file:
 *  - A factor is never active until it has been proven. TOTP goes into
 *    `totp_pending_secret` at setup and only becomes real once a code from the
 *    app verifies, so nobody locks themselves out with a bad QR scan.
 *  - Every change is audited and emailed to the account owner, so a change made
 *    by someone who stole the password does not happen quietly.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const QRCode = require('qrcode');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const { hashPassword, comparePassword } = require('../../utils/password');
const totp = require('../../utils/totp');
const sec = require('../../services/adminSecurity');
const { sendAdminOtpEmail, sendSecurityChangeAlert } = require('../../utils/adminEmails');

const router = express.Router();

async function loadAdmin(adminId) {
  const { rows } = await pool.query(
    'SELECT id, email, name, role, status, password_hash, last_login_at FROM admins WHERE id = $1',
    [adminId]
  );
  return rows[0] || null;
}

function notifyChange(admin, change, req) {
  sendSecurityChangeAlert({
    to: admin.email,
    name: admin.name,
    change,
    ip: sec.clientIp(req),
    when: new Date().toUTCString(),
  }).catch((err) => console.error('security alert failed:', err.message));
}

// ── GET / ────────────────────────────────────────────────────────────────────
// Current security posture. Never returns an active TOTP secret.
router.get('/', adminAuth, async (req, res) => {
  try {
    const admin = await loadAdmin(req.admin.id);
    if (!admin) return sendError(res, null, 'Admin not found', 404);

    const security = await sec.getSecurity(admin.id);
    const recovery = await sec.recoveryCodeStatus(admin.id);

    const { rows: sessions } = await pool.query(
      `SELECT jti, ip_address, user_agent, issued_at, expires_at, revoked_at
         FROM auth_tokens
        WHERE subject_type = 'admin' AND subject_id = $1
        ORDER BY issued_at DESC LIMIT 25`,
      [admin.id]
    );

    sendSuccess(
      res,
      {
        admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
        emailOtp: {
          enabled: !!security.email_otp_enabled,
          address: security.email_otp_address || admin.email,
        },
        totp: {
          enabled: !!security.totp_enabled,
          pending: !!security.totp_pending_secret,
        },
        recoveryCodes: recovery,
        lastVerifiedAt: security.last_verified_at,
        sessions: sessions.map((s) => ({
          id: s.jti,
          current: s.jti === req.admin.jti,
          ip: s.ip_address,
          userAgent: s.user_agent,
          issuedAt: s.issued_at,
          expiresAt: s.expires_at,
          revoked: !!s.revoked_at,
        })),
      },
      'Security settings retrieved'
    );
  } catch (err) {
    console.error('admin security read error:', err);
    sendError(res, err, 'Failed to load security settings', 500);
  }
});

// ── Email OTP ────────────────────────────────────────────────────────────────

// Send a code to the chosen inbox to prove it is reachable before enabling.
router.post('/email-otp/start', adminAuth, body('address').optional().isEmail(), async (req, res) => {
  try {
    const admin = await loadAdmin(req.admin.id);
    const address = (req.body.address || admin.email).toLowerCase().trim();

    const challenge = await sec.createChallenge({ req, adminId: admin.id, method: 'email' });
    await sendAdminOtpEmail({
      to: address,
      code: challenge.emailCode,
      name: admin.name,
      ttlMinutes: sec.CHALLENGE_TTL_MINUTES,
      ip: sec.clientIp(req),
    });

    // Remember the address on the challenge row so confirm() knows where it went.
    await pool.query('UPDATE admin_mfa_challenges SET user_agent = $1 WHERE challenge_id = $2', [
      `setup:${address}`,
      challenge.challengeId,
    ]);

    sendSuccess(
      res,
      { challengeId: challenge.challengeId, address, expiresAt: challenge.expiresAt },
      'Verification code sent'
    );
  } catch (err) {
    console.error('email otp start error:', err);
    sendError(res, err, 'Failed to send verification code', 500);
  }
});

router.post(
  '/email-otp/confirm',
  adminAuth,
  body('challengeId').trim().notEmpty(),
  body('code').trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ status: 'error', errors: errors.array() });

    try {
      const admin = await loadAdmin(req.admin.id);
      const challenge = await sec.loadChallenge(req.body.challengeId);
      const problem = sec.challengeProblem(challenge);
      if (problem) return sendError(res, null, problem, 400);
      if (challenge.admin_id !== admin.id) return sendError(res, null, 'Invalid request', 403);

      if (!sec.verifyEmailCode(challenge, req.body.code)) {
        await sec.bumpChallengeAttempts(challenge.challenge_id);
        return sendError(res, null, 'That code is not right. Please try again.', 400);
      }

      await sec.markChallengeUsed(challenge.challenge_id);
      const address = String(challenge.user_agent || '').startsWith('setup:')
        ? challenge.user_agent.slice(6)
        : admin.email;

      await pool.query(
        `UPDATE admin_security SET email_otp_enabled = 1, email_otp_address = $1 WHERE admin_id = $2`,
        [address, admin.id]
      );

      await sec.audit({
        req,
        adminId: admin.id,
        adminEmail: admin.email,
        action: 'admin.security.email_otp_enabled',
        summary: `Email verification enabled (${address})`,
      });
      notifyChange(admin, 'Email verification turned on', req);

      sendSuccess(res, { enabled: true, address }, 'Email verification is on');
    } catch (err) {
      console.error('email otp confirm error:', err);
      sendError(res, err, 'Failed to enable email verification', 500);
    }
  }
);

router.post('/email-otp/disable', adminAuth, async (req, res) => {
  try {
    const admin = await loadAdmin(req.admin.id);
    await pool.query('UPDATE admin_security SET email_otp_enabled = 0 WHERE admin_id = $1', [
      admin.id,
    ]);
    await sec.audit({
      req,
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'admin.security.email_otp_disabled',
      summary: 'Email verification disabled',
    });
    notifyChange(admin, 'Email verification turned off', req);
    sendSuccess(res, { enabled: false }, 'Email verification is off');
  } catch (err) {
    console.error('email otp disable error:', err);
    sendError(res, err, 'Failed to disable email verification', 500);
  }
});

// ── Authenticator app (TOTP) ─────────────────────────────────────────────────

// Hand out a secret + QR. The factor stays off until a code proves the app works.
router.post('/totp/setup', adminAuth, async (req, res) => {
  try {
    const admin = await loadAdmin(req.admin.id);
    const security = await sec.getSecurity(admin.id);
    if (security.totp_enabled) {
      return sendError(res, null, 'Authenticator app is already on. Turn it off first.', 409);
    }

    const secret = totp.generateSecret();
    await pool.query('UPDATE admin_security SET totp_pending_secret = $1 WHERE admin_id = $2', [
      secret,
      admin.id,
    ]);

    const uri = totp.keyUri({ secret, account: admin.email });
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240 });

    await sec.audit({
      req,
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'admin.security.totp_setup_started',
      summary: 'Authenticator setup started',
    });

    sendSuccess(
      res,
      { secret, manualKey: totp.formatSecret(secret), uri, qrDataUrl },
      'Scan the QR code, then enter the 6-digit code'
    );
  } catch (err) {
    console.error('totp setup error:', err);
    sendError(res, err, 'Failed to start authenticator setup', 500);
  }
});

router.post('/totp/confirm', adminAuth, body('code').trim().notEmpty(), async (req, res) => {
  try {
    const admin = await loadAdmin(req.admin.id);
    const security = await sec.getSecurity(admin.id);
    if (!security.totp_pending_secret) {
      return sendError(res, null, 'Start the setup again — no pending authenticator.', 400);
    }

    if (!totp.verify(security.totp_pending_secret, req.body.code)) {
      await sec.audit({
        req,
        adminId: admin.id,
        adminEmail: admin.email,
        action: 'admin.security.totp_confirm_failed',
        summary: 'Incorrect authenticator code during setup',
        status: 'failed',
      });
      return sendError(res, null, 'That code is not right. Check the app and try again.', 400);
    }

    await pool.query(
      `UPDATE admin_security
          SET totp_enabled = 1, totp_secret = totp_pending_secret,
              totp_pending_secret = NULL, last_verified_at = NOW()
        WHERE admin_id = $1`,
      [admin.id]
    );

    // First factor of this kind — give them a way back in if the phone is lost.
    const recovery = await sec.recoveryCodeStatus(admin.id);
    const codes = recovery.total === 0 ? await sec.generateRecoveryCodes(admin.id) : null;

    await sec.audit({
      req,
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'admin.security.totp_enabled',
      summary: 'Authenticator app enabled',
    });
    notifyChange(admin, 'Authenticator app turned on', req);

    sendSuccess(
      res,
      { enabled: true, recoveryCodes: codes },
      codes
        ? 'Authenticator is on. Save your recovery codes — they are shown once.'
        : 'Authenticator app is on'
    );
  } catch (err) {
    console.error('totp confirm error:', err);
    sendError(res, err, 'Failed to enable authenticator', 500);
  }
});

// Turning a factor off requires the password — a hijacked session cannot
// quietly weaken the account.
router.post('/totp/disable', adminAuth, body('password').notEmpty(), async (req, res) => {
  try {
    const admin = await loadAdmin(req.admin.id);
    const ok = await verifyPassword(admin, req.body.password);
    if (!ok) return sendError(res, null, 'Password is not correct', 401);

    await pool.query(
      `UPDATE admin_security SET totp_enabled = 0, totp_secret = NULL, totp_pending_secret = NULL
        WHERE admin_id = $1`,
      [admin.id]
    );
    await sec.audit({
      req,
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'admin.security.totp_disabled',
      summary: 'Authenticator app disabled',
    });
    notifyChange(admin, 'Authenticator app turned off', req);

    sendSuccess(res, { enabled: false }, 'Authenticator app is off');
  } catch (err) {
    console.error('totp disable error:', err);
    sendError(res, err, 'Failed to disable authenticator', 500);
  }
});

/** Password check that honours the ENV master-admin path. */
async function verifyPassword(admin, password) {
  const envEmail = (process.env.ADMIN_SEED_EMAIL || '').toLowerCase().trim();
  const envPassword = process.env.ADMIN_SEED_PASSWORD || '';
  if (envEmail && envPassword && admin.email.toLowerCase() === envEmail) {
    return password === envPassword;
  }
  if (!admin.password_hash) return false;
  return comparePassword(password, admin.password_hash);
}

// ── Recovery codes ───────────────────────────────────────────────────────────

router.post('/recovery-codes', adminAuth, body('password').notEmpty(), async (req, res) => {
  try {
    const admin = await loadAdmin(req.admin.id);
    if (!(await verifyPassword(admin, req.body.password))) {
      return sendError(res, null, 'Password is not correct', 401);
    }

    const codes = await sec.generateRecoveryCodes(admin.id);
    await sec.audit({
      req,
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'admin.security.recovery_codes_generated',
      summary: `${codes.length} recovery codes generated`,
    });
    notifyChange(admin, 'New recovery codes generated', req);

    sendSuccess(res, { codes }, 'Save these now — they are shown once');
  } catch (err) {
    console.error('recovery codes error:', err);
    sendError(res, err, 'Failed to generate recovery codes', 500);
  }
});

// ── Sessions ─────────────────────────────────────────────────────────────────

router.post('/sessions/:jti/revoke', adminAuth, async (req, res) => {
  try {
    const { jti } = req.params;
    const { rowCount } = await pool.query(
      `UPDATE auth_tokens SET revoked_at = NOW()
        WHERE jti = $1 AND subject_type = 'admin' AND subject_id = $2 AND revoked_at IS NULL`,
      [jti, req.admin.id]
    );
    if (!rowCount) return sendError(res, null, 'Session not found or already ended', 404);

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.security.session_revoked',
      entityType: 'session',
      entityId: jti,
      summary: jti === req.admin.jti ? 'Ended current session' : 'Ended another session',
    });

    sendSuccess(res, { revoked: jti }, 'Session ended');
  } catch (err) {
    console.error('revoke session error:', err);
    sendError(res, err, 'Failed to end session', 500);
  }
});

router.post('/sessions/revoke-others', adminAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE auth_tokens SET revoked_at = NOW()
        WHERE subject_type = 'admin' AND subject_id = $1 AND jti <> $2 AND revoked_at IS NULL`,
      [req.admin.id, req.admin.jti]
    );
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.security.sessions_revoked',
      summary: `Signed out ${rowCount} other session(s)`,
    });
    sendSuccess(res, { revoked: rowCount }, `Signed out ${rowCount} other session(s)`);
  } catch (err) {
    console.error('revoke others error:', err);
    sendError(res, err, 'Failed to end other sessions', 500);
  }
});

// ── Password ─────────────────────────────────────────────────────────────────

router.post(
  '/password',
  adminAuth,
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 10 }).withMessage('Use at least 10 characters'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    }

    try {
      const admin = await loadAdmin(req.admin.id);
      if (!(await verifyPassword(admin, req.body.currentPassword))) {
        await sec.audit({
          req,
          adminId: admin.id,
          adminEmail: admin.email,
          action: 'admin.security.password_change_failed',
          summary: 'Wrong current password',
          status: 'failed',
        });
        return sendError(res, null, 'Current password is not correct', 401);
      }

      const envEmail = (process.env.ADMIN_SEED_EMAIL || '').toLowerCase().trim();
      if (envEmail && admin.email.toLowerCase() === envEmail) {
        return sendError(
          res,
          null,
          'This account signs in with the password from .env — change ADMIN_SEED_PASSWORD there instead.',
          409
        );
      }

      await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [
        await hashPassword(req.body.newPassword),
        admin.id,
      ]);

      // A password change ends every other session.
      await pool.query(
        `UPDATE auth_tokens SET revoked_at = NOW()
          WHERE subject_type = 'admin' AND subject_id = $1 AND jti <> $2 AND revoked_at IS NULL`,
        [admin.id, req.admin.jti]
      );

      await sec.audit({
        req,
        adminId: admin.id,
        adminEmail: admin.email,
        action: 'admin.security.password_changed',
        summary: 'Password changed; other sessions ended',
      });
      notifyChange(admin, 'Password changed', req);

      sendSuccess(res, {}, 'Password changed. Other devices have been signed out.');
    } catch (err) {
      console.error('password change error:', err);
      sendError(res, err, 'Failed to change password', 500);
    }
  }
);

// ── Audit log ────────────────────────────────────────────────────────────────

router.get('/audit', adminAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const action = (req.query.action || '').trim();
    const status = (req.query.status || '').trim();
    const search = (req.query.search || '').trim();

    const where = [];
    const params = [];
    if (action) {
      params.push(`${action}%`);
      where.push(`action LIKE $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(summary LIKE $${params.length} OR admin_email LIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT id, admin_id, admin_email, action, entity_type, entity_id, summary,
              ip_address, user_agent, status, created_at
         FROM admin_audit_log ${whereSql}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const { rows: totals } = await pool.query(
      `SELECT COUNT(*) AS total FROM admin_audit_log ${whereSql}`,
      params
    );
    const { rows: actions } = await pool.query(
      `SELECT action, COUNT(*) AS count FROM admin_audit_log
        GROUP BY action ORDER BY count DESC LIMIT 30`
    );

    sendSuccess(
      res,
      {
        entries: rows,
        total: Number(totals[0]?.total || 0),
        limit,
        offset,
        actions: actions.map((a) => ({ action: a.action, count: Number(a.count) })),
      },
      'Audit log retrieved'
    );
  } catch (err) {
    console.error('audit log error:', err);
    sendError(res, err, 'Failed to load audit log', 500);
  }
});

// ── Login attempts (fraud / brute-force view) ────────────────────────────────

router.get('/login-attempts', adminAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { rows } = await pool.query(
      `SELECT id, email, admin_id, successful, failure_reason, ip_address, user_agent, created_at
         FROM admin_login_attempts
        ORDER BY created_at DESC LIMIT ${limit}`
    );
    const { rows: summary } = await pool.query(
      `SELECT
          SUM(CASE WHEN successful = 1 THEN 1 ELSE 0 END) AS successes,
          SUM(CASE WHEN successful = 0 THEN 1 ELSE 0 END) AS failures,
          COUNT(DISTINCT ip_address) AS distinct_ips
         FROM admin_login_attempts
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );

    sendSuccess(
      res,
      {
        attempts: rows,
        last7Days: {
          successes: Number(summary[0]?.successes || 0),
          failures: Number(summary[0]?.failures || 0),
          distinctIps: Number(summary[0]?.distinct_ips || 0),
        },
        lockout: {
          threshold: sec.LOCKOUT_THRESHOLD,
          ipThreshold: sec.IP_LOCKOUT_THRESHOLD,
          windowMinutes: sec.LOCKOUT_WINDOW_MINUTES,
        },
      },
      'Login attempts retrieved'
    );
  } catch (err) {
    console.error('login attempts error:', err);
    sendError(res, err, 'Failed to load login attempts', 500);
  }
});

module.exports = router;
