/**
 * Admin security: audit trail, login throttling, MFA challenges, recovery codes.
 *
 * The threat this module exists for: an admin password leaking. The panel can
 * move money, read every customer record and email the whole list, so a
 * password on its own is not enough to get in.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/db');

// Per-account limit: tight, because an attacker grinding one password list
// against one admin should stop fast.
const LOCKOUT_THRESHOLD = Number(process.env.ADMIN_LOCKOUT_ATTEMPTS || 5);
// Per-IP limit: deliberately looser. Admins often share an office NAT, and a
// threshold as tight as the per-account one would let anyone lock the whole
// team out from the same network.
const IP_LOCKOUT_THRESHOLD = Number(process.env.ADMIN_LOCKOUT_IP_ATTEMPTS || 20);
const LOCKOUT_WINDOW_MINUTES = Number(process.env.ADMIN_LOCKOUT_WINDOW_MINUTES || 15);
const CHALLENGE_TTL_MINUTES = Number(process.env.ADMIN_MFA_TTL_MINUTES || 10);
const CHALLENGE_MAX_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

/** High-entropy values, so a fast hash is the right tool — these are not passwords. */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || null;
}

/**
 * A stable-enough identifier for "this browser on this network".
 *
 * Not a security control on its own — it only decides whether to send a
 * "new sign-in" heads-up, so a false positive costs an email, not access.
 */
function deviceFingerprint(req) {
  return sha256(`${req.get('user-agent') || ''}|${clientIp(req) || ''}`);
}

// ── Audit ────────────────────────────────────────────────────────────────────

/**
 * Record an admin action. Never throws — an audit write failing must not take
 * down the action being audited, but it is logged loudly.
 */
async function audit({
  req,
  adminId = null,
  adminEmail = null,
  action,
  entityType = null,
  entityId = null,
  summary = null,
  metadata = null,
  status = 'success',
}) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log
         (admin_id, admin_email, action, entity_type, entity_id, summary, metadata,
          ip_address, user_agent, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        adminId,
        adminEmail,
        action,
        entityType,
        entityId ? String(entityId) : null,
        summary,
        metadata ? JSON.stringify(metadata) : null,
        req ? clientIp(req) : null,
        req ? (req.get('user-agent') || '').slice(0, 500) : null,
        status,
      ]
    );
  } catch (err) {
    console.error('[adminSecurity] audit write failed:', err.message);
  }
}

// ── Login attempts & lockout ─────────────────────────────────────────────────

async function recordAttempt({ req, email, adminId = null, successful, reason = null }) {
  try {
    await pool.query(
      `INSERT INTO admin_login_attempts
         (email, admin_id, successful, failure_reason, ip_address, user_agent, device_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        String(email || '').toLowerCase(),
        adminId,
        successful ? 1 : 0,
        reason,
        clientIp(req),
        (req.get('user-agent') || '').slice(0, 500),
        deviceFingerprint(req),
      ]
    );
  } catch (err) {
    console.error('[adminSecurity] attempt log failed:', err.message);
  }
}

/**
 * Failures are counted per email AND per IP, so neither spraying one account
 * from many addresses nor many accounts from one address slips through.
 *
 * A success resets the counter, but only the counter it belongs to: signing in
 * successfully as one account clears that email's tally and that IP's tally
 * from that moment on. It deliberately does not wipe failures recorded against
 * a *different* email, so an attacker who owns one valid login cannot use it to
 * keep resetting the limit while grinding through other accounts.
 */
async function checkLockout({ req, email }) {
  const lower = String(email || '').toLowerCase();
  const ip = clientIp(req);

  const { rows } = await pool.query(
    `SELECT
        (SELECT MAX(created_at) FROM admin_login_attempts
          WHERE email = $1 AND successful = 1
            AND created_at >= DATE_SUB(NOW(), INTERVAL ${LOCKOUT_WINDOW_MINUTES} MINUTE)
        ) AS email_success_at,
        (SELECT MAX(created_at) FROM admin_login_attempts
          WHERE ip_address = $2 AND successful = 1
            AND created_at >= DATE_SUB(NOW(), INTERVAL ${LOCKOUT_WINDOW_MINUTES} MINUTE)
        ) AS ip_success_at`,
    [lower, ip]
  );

  const emailSuccessAt = rows[0]?.email_success_at || null;
  const ipSuccessAt = rows[0]?.ip_success_at || null;

  const { rows: counts } = await pool.query(
    `SELECT
        SUM(CASE WHEN email = $1 AND successful = 0
                  AND ($3 IS NULL OR created_at > $3) THEN 1 ELSE 0 END) AS email_failures,
        SUM(CASE WHEN ip_address = $2 AND successful = 0
                  AND ($4 IS NULL OR created_at > $4) THEN 1 ELSE 0 END) AS ip_failures
       FROM admin_login_attempts
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${LOCKOUT_WINDOW_MINUTES} MINUTE)`,
    [lower, ip, emailSuccessAt, ipSuccessAt]
  );

  const emailFailures = Number(counts[0]?.email_failures || 0);
  const ipFailures = Number(counts[0]?.ip_failures || 0);

  const emailLocked = emailFailures >= LOCKOUT_THRESHOLD;
  const ipLocked = ipFailures >= IP_LOCKOUT_THRESHOLD;

  return {
    locked: emailLocked || ipLocked,
    reason: emailLocked ? 'account' : ipLocked ? 'network' : null,
    remaining: Math.max(0, LOCKOUT_THRESHOLD - emailFailures),
    windowMinutes: LOCKOUT_WINDOW_MINUTES,
  };
}

/** Has this admin signed in from this browser/network before? */
async function isKnownDevice(adminId, fingerprint) {
  const { rows } = await pool.query(
    `SELECT 1 FROM admin_login_attempts
      WHERE admin_id = $1 AND device_fingerprint = $2 AND successful = 1
      LIMIT 1`,
    [adminId, fingerprint]
  );
  return rows.length > 0;
}

// ── Security settings ────────────────────────────────────────────────────────

async function getSecurity(adminId) {
  const { rows } = await pool.query('SELECT * FROM admin_security WHERE admin_id = $1', [adminId]);
  if (rows.length) return rows[0];

  await pool.query('INSERT IGNORE INTO admin_security (admin_id) VALUES ($1)', [adminId]);
  const { rows: created } = await pool.query('SELECT * FROM admin_security WHERE admin_id = $1', [
    adminId,
  ]);
  return created[0];
}

/** True when the admin must pass a second factor to sign in. */
function mfaEnabled(security) {
  return !!(security && (security.totp_enabled || security.email_otp_enabled));
}

// ── MFA challenges ───────────────────────────────────────────────────────────

/**
 * Issue a challenge after the password step.
 *
 * Nothing that can be used as a session is returned here — only an opaque id.
 * The session token is minted after the second factor verifies.
 */
async function createChallenge({ req, adminId, method }) {
  const challengeId = uuidv4();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60000);

  let emailCode = null;
  let emailCodeHash = null;
  if (method === 'email') {
    emailCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    emailCodeHash = sha256(emailCode);
  }

  await pool.query(
    `INSERT INTO admin_mfa_challenges
       (challenge_id, admin_id, method, email_code_hash, expires_at, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      challengeId,
      adminId,
      method,
      emailCodeHash,
      expiresAt,
      clientIp(req),
      (req.get('user-agent') || '').slice(0, 500),
    ]
  );

  return { challengeId, expiresAt, emailCode };
}

async function loadChallenge(challengeId) {
  const { rows } = await pool.query(
    'SELECT * FROM admin_mfa_challenges WHERE challenge_id = $1 LIMIT 1',
    [challengeId]
  );
  return rows[0] || null;
}

async function markChallengeUsed(challengeId) {
  await pool.query(
    'UPDATE admin_mfa_challenges SET consumed_at = NOW() WHERE challenge_id = $1',
    [challengeId]
  );
}

async function bumpChallengeAttempts(challengeId) {
  await pool.query(
    'UPDATE admin_mfa_challenges SET attempts = attempts + 1 WHERE challenge_id = $1',
    [challengeId]
  );
}

/** Validate a challenge is still usable. Returns a reason string when it isn't. */
function challengeProblem(challenge) {
  if (!challenge) return 'This sign-in request is no longer valid. Please start again.';
  if (challenge.consumed_at) return 'This code has already been used.';
  if (new Date(challenge.expires_at) < new Date()) return 'This code has expired. Please sign in again.';
  if (challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    return 'Too many incorrect codes. Please sign in again.';
  }
  return null;
}

function verifyEmailCode(challenge, code) {
  if (!challenge.email_code_hash) return false;
  const a = Buffer.from(sha256(String(code || '').trim()));
  const b = Buffer.from(challenge.email_code_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Recovery codes ───────────────────────────────────────────────────────────

/** Generates a fresh set and invalidates the old one. Plaintext is returned once. */
async function generateRecoveryCodes(adminId) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-')
  );

  await pool.query('DELETE FROM admin_recovery_codes WHERE admin_id = $1', [adminId]);
  for (const code of codes) {
    await pool.query(
      'INSERT INTO admin_recovery_codes (admin_id, code_hash) VALUES ($1, $2)',
      [adminId, sha256(normaliseRecoveryCode(code))]
    );
  }
  await pool.query(
    'UPDATE admin_security SET recovery_codes_generated_at = NOW() WHERE admin_id = $1',
    [adminId]
  );

  return codes;
}

function normaliseRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Spend a recovery code. Returns false if it is unknown or already used. */
async function consumeRecoveryCode(adminId, code) {
  const hash = sha256(normaliseRecoveryCode(code));
  const { rowCount } = await pool.query(
    `UPDATE admin_recovery_codes SET used_at = NOW()
      WHERE admin_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [adminId, hash]
  );
  return rowCount > 0;
}

async function recoveryCodeStatus(adminId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS unused
       FROM admin_recovery_codes WHERE admin_id = $1`,
    [adminId]
  );
  return {
    total: Number(rows[0]?.total || 0),
    remaining: Number(rows[0]?.unused || 0),
  };
}

module.exports = {
  sha256,
  clientIp,
  deviceFingerprint,
  audit,
  recordAttempt,
  checkLockout,
  isKnownDevice,
  getSecurity,
  mfaEnabled,
  createChallenge,
  loadChallenge,
  markChallengeUsed,
  bumpChallengeAttempts,
  challengeProblem,
  verifyEmailCode,
  generateRecoveryCodes,
  consumeRecoveryCode,
  recoveryCodeStatus,
  normaliseRecoveryCode,
  LOCKOUT_THRESHOLD,
  IP_LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_MINUTES,
  CHALLENGE_TTL_MINUTES,
};
