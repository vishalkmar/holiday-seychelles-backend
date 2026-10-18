/**
 * Step-up verification for sensitive AI changes (DESIGN.md §3.8, Phase 12).
 *
 *   start(password)  → re-check the password, email a 6-digit code (10 min,
 *                      5 attempts, 60 s resend cooldown, max 5 sends)
 *   verify(code)     → a change token: random, single-use, 15 minutes, bound
 *                      to this admin + action + target
 *   consume(token)   → the gated route spends it; reuse, expiry, another admin,
 *                      another action or another target are all refused
 *
 * D5: email OTP only (owner, 2026-10-16). Codes and tokens are stored hashed.
 * The pure rule checks (challengeProblem, tokenProblem) are exported for tests.
 */

const crypto = require('crypto');
const { db, security } = require('../ports');
const { ensureAiTables } = require('../db');
const emails = require('./emails');
const events = require('./events');

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_S = 60;
const MAX_SENDS = 5;
const TOKEN_TTL_MIN = 15;

/** Every action that needs a step-up, with the words used in emails and the UI. */
const ACTIONS = {
  'prompt.publish': 'Publish the assistant’s business instructions',
  'prompt.rollback': 'Roll back the assistant’s business instructions',
  'prompt.approve': 'Approve a pending change to the assistant',
  'tools.permission': 'Change who can use a live tool',
  'settings.models': 'Change the AI models or approval setting',
  'settings.key': 'Replace or remove the NVIDIA API key',
};

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/** Pure: why a challenge can't be used now, or null. */
function challengeProblem(c, now = new Date()) {
  if (!c) return ['NOT_FOUND', 'This verification has expired. Start again.'];
  if (c.verified_at) return ['USED', 'This code has already been used. Start again.'];
  if (new Date(c.expires_at) < now) return ['EXPIRED', 'This code has expired. Send a new one.'];
  if (Number(c.attempts) >= MAX_ATTEMPTS) return ['LOCKED', 'Too many wrong codes. Start again.'];
  return null;
}

/** Pure: why a token can't authorise this change, or null. */
function tokenProblem(t, { adminId, action, target }, now = new Date()) {
  if (!t) return ['TOKEN_INVALID', 'Verification is missing or invalid. Verify again.'];
  if (t.used_at) return ['TOKEN_USED', 'This verification was already used. Verify again.'];
  if (new Date(t.expires_at) < now) return ['TOKEN_EXPIRED', 'Your verification expired (15 minutes). Verify again.'];
  if (Number(t.admin_id) !== Number(adminId)) return ['TOKEN_WRONG_ADMIN', 'This verification belongs to another admin.'];
  if (t.action !== action) return ['TOKEN_WRONG_ACTION', 'This verification was for a different action. Verify again.'];
  if (t.target !== target) return ['TOKEN_WRONG_TARGET', 'What you verified has changed since (e.g. the draft was edited). Verify again.'];
  return null;
}

async function adminRow(adminId) {
  const { rows } = await db.query('SELECT id, name, email, password_hash, status FROM admins WHERE id = $1', [adminId]);
  return rows[0] || null;
}

async function start({ req, adminId, action, target, password }) {
  await ensureAiTables();
  if (!ACTIONS[action]) throw fail('BAD_ACTION', 'Unknown action');
  if (!target || String(target).length > 160) throw fail('BAD_TARGET', 'Unknown target');
  const admin = await adminRow(adminId);
  if (!admin || admin.status !== 'active') throw fail('FORBIDDEN', 'Your account cannot do this.', 403);
  const ok = password && admin.password_hash && (await require('bcryptjs').compare(String(password), admin.password_hash));
  if (!ok) {
    await events.record({ req, adminId, kind: 'stepup_bad_password', summary: `Wrong password when verifying “${ACTIONS[action]}”` });
    throw fail('BAD_PASSWORD', 'That password is not correct.', 401);
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO rag_stepup_challenges (id, admin_id, action, target, code_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, DATE_ADD(NOW(), INTERVAL ${CODE_TTL_MIN} MINUTE), $6, $7)`,
    [id, adminId, action, String(target), sha(code), security.clientIp(req), String(req.get?.('user-agent') || '').slice(0, 500)]
  );
  const sent = await emails.sendStepUpCode({ to: admin.email, name: admin.name, code, what: ACTIONS[action], ttlMinutes: CODE_TTL_MIN, ip: security.clientIp(req) });
  if (!sent.success) throw fail('EMAIL_FAILED', 'The code could not be emailed. Try again shortly.', 502);
  return { challengeId: id, email: maskEmail(admin.email), expiresInSec: CODE_TTL_MIN * 60, resendInSec: RESEND_COOLDOWN_S };
}

async function load(id) {
  const { rows } = await db.query('SELECT *, TIMESTAMPDIFF(SECOND, last_sent_at, NOW()) AS since_sent FROM rag_stepup_challenges WHERE id = $1', [id]);
  return rows[0] || null;
}

async function resend({ req, adminId, challengeId }) {
  const c = await load(challengeId);
  if (!c || Number(c.admin_id) !== Number(adminId)) throw fail('NOT_FOUND', 'This verification has expired. Start again.', 404);
  const p = challengeProblem(c);
  if (p && p[0] !== 'EXPIRED') throw fail(p[0], p[1]);
  const wait = RESEND_COOLDOWN_S - Number(c.since_sent || 0);
  if (wait > 0) throw fail('COOLDOWN', `Wait ${wait} seconds before asking for another code.`, 429);
  if (Number(c.sends) >= MAX_SENDS) throw fail('TOO_MANY_SENDS', 'Too many codes sent. Start again later.', 429);
  const admin = await adminRow(adminId);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(
    `UPDATE rag_stepup_challenges SET code_hash = $1, attempts = 0, sends = sends + 1, last_sent_at = NOW(),
       expires_at = DATE_ADD(NOW(), INTERVAL ${CODE_TTL_MIN} MINUTE) WHERE id = $2`,
    [sha(code), challengeId]
  );
  const sent = await emails.sendStepUpCode({ to: admin.email, name: admin.name, code, what: ACTIONS[c.action], ttlMinutes: CODE_TTL_MIN, ip: security.clientIp(req) });
  if (!sent.success) throw fail('EMAIL_FAILED', 'The code could not be emailed. Try again shortly.', 502);
  return { resendInSec: RESEND_COOLDOWN_S };
}

async function verify({ req, adminId, challengeId, code }) {
  const c = await load(challengeId);
  if (!c || Number(c.admin_id) !== Number(adminId)) throw fail('NOT_FOUND', 'This verification has expired. Start again.', 404);
  const p = challengeProblem(c);
  if (p) throw fail(p[0], p[1]);
  const a = Buffer.from(sha(String(code || '').trim()));
  const b = Buffer.from(c.code_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await db.query('UPDATE rag_stepup_challenges SET attempts = attempts + 1 WHERE id = $1', [challengeId]);
    const attempts = Number(c.attempts) + 1;
    if (attempts === 3 || attempts === MAX_ATTEMPTS) {
      await events.record({ req, adminId, kind: 'otp_failures', summary: `${attempts} wrong codes while verifying “${ACTIONS[c.action]}”`, alert: true });
    }
    throw fail('BAD_CODE', attempts >= MAX_ATTEMPTS ? 'Too many wrong codes. Start again.' : `That code is not correct. ${MAX_ATTEMPTS - attempts} tries left.`);
  }
  await db.query('UPDATE rag_stepup_challenges SET verified_at = NOW() WHERE id = $1 AND verified_at IS NULL', [challengeId]);
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO rag_change_tokens (token_hash, admin_id, action, target, challenge_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, DATE_ADD(NOW(), INTERVAL ${TOKEN_TTL_MIN} MINUTE))`,
    [sha(token), adminId, c.action, c.target, challengeId]
  );
  return { changeToken: token, action: c.action, target: c.target, expiresInSec: TOKEN_TTL_MIN * 60 };
}

/** Spend a token for exactly this admin + action + target. Throws 403 with a code. */
async function consume({ adminId, token, action, target }) {
  await ensureAiTables();
  if (!token) throw fail('STEP_UP_REQUIRED', 'This change needs verification.', 428);
  const { rows } = await db.query('SELECT * FROM rag_change_tokens WHERE token_hash = $1', [sha(token)]);
  const p = tokenProblem(rows[0], { adminId, action, target });
  if (p) throw fail(p[0], p[1], 403);
  // Single use, even under a race: only one UPDATE can flip used_at.
  const r = await db.query('UPDATE rag_change_tokens SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL', [sha(token)]);
  if (!r.rowCount) throw fail('TOKEN_USED', 'This verification was already used. Verify again.', 403);
  return true;
}

function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}`;
}

module.exports = { start, resend, verify, consume, challengeProblem, tokenProblem, ACTIONS, maskEmail, CODE_TTL_MIN, TOKEN_TTL_MIN, MAX_ATTEMPTS };
