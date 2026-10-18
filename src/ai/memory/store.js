/**
 * Session and message storage (MySQL). The same interface is faked in tests.
 * Every read is scoped by visitor id (or user id): a session id alone never
 * opens a conversation.
 */

const crypto = require('crypto');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { config } = require('../config');

const parse = (v, d) => {
  if (v === null || v === undefined) return d;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return d; }
};

const shape = (r) => r && {
  id: r.id,
  visitorId: r.visitor_id,
  userId: r.user_id ? Number(r.user_id) : null,
  language: r.language,
  slots: parse(r.slots_json, {}),
  state: parse(r.state_json, {}),
  summary: r.summary || '',
  summaryUpto: Number(r.summary_upto || 0),
  turns: Number(r.turns || 0),
  status: r.status,
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
};

const retentionDays = () => config.chatRetentionDays || 90;

async function createSession({ visitorId, userId = null, ipHash = null, userAgent = null }) {
  await ensureAiTables();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO chat_sessions (id, visitor_id, user_id, ip_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, DATE_ADD(NOW(), INTERVAL ${retentionDays()} DAY))`,
    [id, visitorId, userId, ipHash, userAgent ? String(userAgent).slice(0, 300) : null]
  );
  return getSession({ id, visitorId, userId });
}

/** Only the owning visitor (or the linked logged-in user) gets the session. */
async function getSession({ id, visitorId, userId = null }) {
  await ensureAiTables();
  const { rows } = await db.query(
    `SELECT * FROM chat_sessions WHERE id = $1 AND status <> 'deleted' AND (visitor_id = $2 ${userId ? 'OR user_id = $3' : ''})`,
    userId ? [id, visitorId, userId] : [id, visitorId]
  );
  return shape(rows[0]);
}

/** The visitor's most recent open session (resumes after a page reload). */
async function latestSession({ visitorId, userId = null }) {
  await ensureAiTables();
  const { rows } = await db.query(
    `SELECT * FROM chat_sessions WHERE status = 'open' AND (visitor_id = $1 ${userId ? 'OR user_id = $2' : ''}) ORDER BY last_active_at DESC LIMIT 1`,
    userId ? [visitorId, userId] : [visitorId]
  );
  return shape(rows[0]);
}

async function saveSession(s, { tokensIn = 0, tokensOut = 0, turnAdded = false } = {}) {
  await db.query(
    `UPDATE chat_sessions SET language = $1, slots_json = $2, state_json = $3, summary = $4, summary_upto = $5,
       user_id = COALESCE(user_id, $6), turns = turns + $7, tokens_in = tokens_in + $8, tokens_out = tokens_out + $9,
       last_active_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ${retentionDays()} DAY)
     WHERE id = $10`,
    [s.language || null, JSON.stringify(s.slots || {}), JSON.stringify(s.state || {}), s.summary || null, s.summaryUpto || 0, s.userId || null, turnAdded ? 1 : 0, tokensIn, tokensOut, s.id]
  );
}

async function addMessage({ sessionId, role, content, reply = null, route = null, tokens = 0 }) {
  const r = await db.query(
    'INSERT INTO chat_messages (session_id, role, content, reply_json, route, tokens) VALUES ($1, $2, $3, $4, $5, $6)',
    [sessionId, role, String(content).slice(0, 8000), reply ? JSON.stringify(reply) : null, route, tokens]
  );
  return Number(r.insertId);
}

/** Messages after `afterId`, oldest first. */
async function messages(sessionId, { afterId = 0, limit = 200 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  const { rows } = await db.query(`SELECT id, role, content, reply_json, route, created_at FROM chat_messages WHERE session_id = $1 AND id > $2 ORDER BY id ASC LIMIT ${lim}`, [sessionId, afterId]);
  return rows.map((r) => ({ id: Number(r.id), role: r.role, content: r.content, reply: parse(r.reply_json, null), route: r.route, createdAt: r.created_at }));
}

async function endSession({ id, visitorId, userId = null, erase = false }) {
  const s = await getSession({ id, visitorId, userId });
  if (!s) return false;
  if (erase) {
    await db.query('DELETE FROM chat_messages WHERE session_id = $1', [id]);
    await db.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  } else {
    await db.query("UPDATE chat_sessions SET status = 'closed' WHERE id = $1", [id]);
  }
  return true;
}

// ── Logged-in preference memory (opt-in) ─────────────────────────────────────

async function getProfile(userId) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM chat_user_profile WHERE user_id = $1', [userId]);
  const r = rows[0];
  return r ? { userId, consent: Boolean(Number(r.consent)), prefs: parse(r.prefs_json, {}), consentAt: r.consent_at, updatedAt: r.updated_at } : { userId, consent: false, prefs: {} };
}

async function setConsent(userId, consent) {
  await ensureAiTables();
  await db.query(
    `INSERT INTO chat_user_profile (user_id, consent, prefs_json, consent_at) VALUES ($1, $2, $3, ${consent ? 'NOW()' : 'NULL'})
     ON DUPLICATE KEY UPDATE consent = VALUES(consent), consent_at = VALUES(consent_at), prefs_json = ${consent ? 'prefs_json' : 'NULL'}`,
    [userId, consent ? 1 : 0, JSON.stringify({})]
  );
  return getProfile(userId);
}

async function savePrefs(userId, prefs) {
  await db.query('UPDATE chat_user_profile SET prefs_json = $1 WHERE user_id = $2 AND consent = 1', [JSON.stringify(prefs), userId]);
}

/** "Clear assistant memory": preferences and every chat linked to the account. */
async function clearUser(userId) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT id FROM chat_sessions WHERE user_id = $1', [userId]);
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await db.query('DELETE FROM chat_messages WHERE session_id = $1', [r.id]);
  }
  await db.query('DELETE FROM chat_sessions WHERE user_id = $1', [userId]);
  await db.query('UPDATE chat_user_profile SET prefs_json = NULL WHERE user_id = $1', [userId]);
  return { sessions: rows.length };
}

/** Daily retention purge (D9). */
async function purgeExpired() {
  await ensureAiTables();
  const { rows } = await db.query('SELECT id FROM chat_sessions WHERE expires_at < NOW() LIMIT 2000');
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await db.query('DELETE FROM chat_messages WHERE session_id = $1', [r.id]);
  }
  if (rows.length) await db.query('DELETE FROM chat_sessions WHERE expires_at < NOW() LIMIT 2000');
  return { sessions: rows.length };
}

module.exports = { createSession, getSession, latestSession, saveSession, addMessage, messages, endSession, getProfile, setConsent, savePrefs, clearUser, purgeExpired };
