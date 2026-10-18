/**
 * Anonymous visitor identity — no login needed, no IP-based guessing.
 *
 * The first time the chat opens, the server mints a random visitor id and
 * returns it as a signed token: `v1.<visitorId>.<hmac>`. The widget keeps it
 * in localStorage and sends it with every chat request (header
 * X-Chat-Visitor). Only a request carrying a valid token can read or continue
 * that visitor's sessions, so one visitor's searches are never shown to
 * another, even on the same Wi-Fi.
 *
 * IP addresses are not identity (offices and mobile carriers share them, and
 * they change); they are only hashed for rate limiting and abuse checks.
 * Clearing the browser storage simply starts a fresh, empty chat.
 */

const crypto = require('crypto');
const { config } = require('../config');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function secret() {
  const s = config.secretKey || process.env.RAG_SECRET_KEY;
  if (!s) throw Object.assign(new Error('RAG_SECRET_KEY is not set'), { status: 503 });
  return `chat-visitor:${s}`;
}

const mac = (id) => crypto.createHmac('sha256', secret()).update(id).digest('base64url');

function issue(visitorId = crypto.randomUUID()) {
  return { visitorId, token: `v1.${visitorId}.${mac(visitorId)}` };
}

/** → visitorId, or null for a missing, malformed or forged token. */
function verify(token) {
  const m = /^v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m || !UUID.test(m[1])) return null;
  const a = Buffer.from(mac(m[1]));
  const b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}

/** For rate limits and abuse checks only — never to look up a visitor's chats. */
function ipHash(ip) {
  return ip ? crypto.createHmac('sha256', secret()).update(`ip:${ip}`).digest('hex') : null;
}

module.exports = { issue, verify, ipHash };
