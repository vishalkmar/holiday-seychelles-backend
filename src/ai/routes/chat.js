/**
 * /api/chat — the public website assistant API.
 *
 * Anonymous by design (no cookies), so it is rate limited per IP from day one.
 * The chat endpoints are built in Phase 14; until then they answer 503 so the
 * widget (Phase 15) can show "assistant unavailable" cleanly. Read-only tool
 * access (GET /tools, /tools/:name) works from Phase 9.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { config } = require('../config');

const router = express.Router();

/**
 * The visitor's IP for rate limits. On cPanel the app runs behind a proxy, so
 * req.ip is the proxy (127.0.0.1) for everyone — limiting on it would throttle
 * the whole website as one visitor. The proxy appends the real address to
 * X-Forwarded-For, so the LAST entry is the one a visitor can't fake (the
 * first entries are whatever the client sent).
 */
function chatIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.ip || 'unknown';
}
const limiterOptions = { keyGenerator: chatIp, validate: { xForwardedForHeader: false, ip: false } };

router.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.CHAT_IP_LIMIT_PER_MIN) || 40, // per IP; each visitor also has its own per-minute limit (settings)
    ...limiterOptions,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many messages. Please wait a moment.' },
    handler: (req, res, next, options) => err(res, options.statusCode, 'RATE_LIMITED', 'Too many messages. Please wait a moment.'),
  })
);

// Read-only tool access (DESIGN.md §3.5): the same contract the assistant
// uses, for the widget's flows and debugging. Public tools only — a tool that
// needs a signed-in visitor answers LOGIN_REQUIRED here. Tighter limit than
// chat, because each call can reach the supplier.
const tools = require('../tools');

const toolLimit = rateLimit({
  ...limiterOptions,
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment.' },
});

router.get('/tools', toolLimit, async (req, res) => {
  try {
    const list = (await tools.list()).filter((t) => t.enabled && t.permission === 'public');
    res.json({ status: 'success', data: { tools: list.map((t) => ({ name: t.name, title: t.title, description: t.description, input: t.schema })) } });
  } catch {
    res.status(500).json({ status: 'error', code: 'ERROR', message: 'Tools are unavailable right now.' });
  }
});

router.get('/tools/:name', toolLimit, async (req, res) => {
  const r = await tools.run(req.params.name, req.query, { audience: 'public', coerce: true });
  const status = r.ok ? 200 : { NOT_FOUND: 404, DISABLED: 403, LOGIN_REQUIRED: 401, INVALID_INPUT: 400, TIMEOUT: 504, SUPPLIER_DOWN: 503 }[r.error.code] || 502;
  const { detail, ...error } = r.error || {};
  res.status(status).json(r.ok ? { status: 'success', data: r.data, cached: r.cached, ms: r.ms } : { status: 'error', code: error.code, message: error.message });
});

// ── Assistant memory for signed-in customers (dashboard → Profile) ───────────
// Opt-in preferences (island, party size, language) and "clear everything".
const { auth } = require('../ports');
const memoryStore = require('../memory/store');

router.get('/memory', auth.user, async (req, res) => {
  try {
    const profile = await memoryStore.getProfile(req.user.id);
    const { rows } = await require('../ports').db.query('SELECT COUNT(*) AS n FROM chat_sessions WHERE user_id = $1', [req.user.id]);
    res.json({ status: 'success', data: { ...profile, conversations: Number(rows[0]?.n || 0) } });
  } catch {
    res.status(500).json({ status: 'error', message: 'Could not load assistant memory.' });
  }
});

router.put('/memory', auth.user, async (req, res) => {
  try {
    res.json({ status: 'success', data: await memoryStore.setConsent(req.user.id, Boolean(req.body?.consent)), message: req.body?.consent ? 'The assistant will remember your preferences.' : 'The assistant will no longer remember your preferences.' });
  } catch {
    res.status(500).json({ status: 'error', message: 'Could not save.' });
  }
});

router.delete('/memory', auth.user, async (req, res) => {
  try {
    const r = await memoryStore.clearUser(req.user.id);
    res.json({ status: 'success', data: r, message: 'Assistant memory and chat history cleared.' });
  } catch {
    res.status(500).json({ status: 'error', message: 'Could not clear.' });
  }
});

// ── The chat itself (Phase 14) ───────────────────────────────────────────────
//
//   POST /session        create or resume → { visitorToken, sessionId, greeting, chips, history }
//   POST /message        { sessionId, text | action } → reply; `?stream=1` streams SSE:
//                          event meta  { sessionId }
//                          event token { t }            (already grounding-checked text)
//                          event done  { messageId, reply, warnings }
//                          event error { code, message }
//   POST /feedback       { messageId, rating: up|down, comment? }
//   GET  /widget-config  enabled, texts, entry chips, theme
//
// Identity: header X-Chat-Visitor (signed anonymous token, memory/identity.js).
// Optional login: Authorization: Bearer <customer token> links the chat to the
// account. No cookies are read, so there is nothing for CSRF to ride on.
//
// Error codes the widget understands: RATE_LIMITED, TOO_LONG, BUDGET_EXCEEDED,
// INVALID_SESSION, DISABLED, LLM_DOWN, TOOL_DOWN (the last two arrive as
// warnings on a normal reply, which still carries a fallback answer).

const identity = require('../memory/identity');
const memory = require('../memory');
const orchestrator = require('../orchestrator');
const settingsStore = require('../settings');
const { db, security } = require('../ports');
const { verifyUserToken, verifyAdminToken } = require('../../utils/jwt');

// Limit hits are counted for the analytics (Phase 19); a logging failure never blocks the reply.
const LIMIT_CODES = new Set(['RATE_LIMITED', 'TOO_LONG', 'BUDGET_EXCEEDED']);
const err = (res, status, code, message, extra = {}) => {
  if (LIMIT_CODES.has(code)) {
    const sid = res.req?.body?.sessionId;
    db.query('INSERT INTO rag_limit_hits (code, session_id) VALUES ($1, $2)', [code, typeof sid === 'string' && sid.length === 36 ? sid : null]).catch(() => {});
  }
  return res.status(status).json({ status: 'error', code, message, ...extra });
};

// Only the website's own origins may call the chat from a browser. Requests
// without an Origin (curl, server-to-server) carry no cookies and are allowed.
function allowedOrigins() {
  const list = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.HS_FRONTEND_URL) list.push(process.env.HS_FRONTEND_URL.replace(/\/$/, ''));
  if (process.env.NODE_ENV !== 'production') list.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173');
  return list;
}
function originGuard(req, res, next) {
  const origin = req.get('origin');
  if (!origin || allowedOrigins().includes(origin.replace(/\/$/, ''))) return next();
  return err(res, 403, 'ORIGIN_NOT_ALLOWED', 'This website may not use the assistant.');
}

/**
 * Soft launch: X-Admin-Preview carries a signed-in admin's token. Valid only
 * for an active admin whose token isn't revoked; never fails the request.
 */
async function isAdminPreview(req) {
  const token = req.get('x-admin-preview');
  if (!token) return false;
  const decoded = verifyAdminToken(token);
  if (!decoded?.sub) return false;
  try {
    const { rows } = await db.query('SELECT a.status, t.revoked_at FROM admins a LEFT JOIN auth_tokens t ON t.jti = $2 WHERE a.id = $1', [decoded.sub, decoded.jti]);
    return Boolean(rows[0] && (!rows[0].status || rows[0].status === 'active') && !rows[0].revoked_at);
  } catch { return false; }
}

/** On for this request? Off everywhere, or admins-only during a soft launch. */
async function isOn(req, s) {
  if (!config.chatEnabled || s.widgetEnabled === false) return false;
  return s.widgetAudience !== 'admins' || isAdminPreview(req);
}

async function enabled(res) {
  const s = await settingsStore.getEffective();
  if (!(await isOn(res.req, s))) {
    err(res, 503, 'DISABLED', 'The travel assistant is switched off.');
    return null;
  }
  return s;
}

/** Bearer customer token → user id, or null. Never fails the request. */
async function optionalUser(req) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const decoded = verifyUserToken(token);
  if (!decoded?.sub) return null;
  try {
    const { rows } = await db.query('SELECT revoked_at FROM auth_tokens WHERE jti = $1', [decoded.jti]);
    if (rows[0]?.revoked_at) return null;
  } catch { return null; }
  return Number(decoded.sub);
}

// Per-visitor message rate (on top of the per-IP limit above).
const recent = new Map(); // visitorId → [timestamps]
function sessionRateOk(visitorId, perMinute) {
  const now = Date.now();
  const list = (recent.get(visitorId) || []).filter((t) => now - t < 60000);
  if (list.length >= perMinute) { recent.set(visitorId, list); return false; }
  list.push(now);
  recent.set(visitorId, list);
  if (recent.size > 5000) recent.delete(recent.keys().next().value);
  return true;
}

async function tokensToday(visitorId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(m.tokens), 0) AS n FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
      WHERE s.visitor_id = $1 AND m.created_at >= CURDATE()`,
    [visitorId]
  );
  return Number(rows[0]?.n || 0);
}

router.use(['/session', '/message', '/feedback', '/widget-config'], originGuard);

router.get('/widget-config', async (req, res) => {
  try {
    const s = await settingsStore.getEffective();
    res.json({
      status: 'success',
      data: {
        enabled: Boolean(await isOn(req, s)),
        preview: s.widgetAudience === 'admins', // soft launch: shown to admins only
        title: s.widgetTitle,
        subtitle: s.widgetSubtitle,
        accent: /^#[0-9a-f]{3,8}$/i.test(s.widgetAccent || '') ? s.widgetAccent : '#2563EB',
        position: s.widgetPosition === 'left' ? 'left' : 'right',
        greeting: orchestrator.greeting('en'),
        chips: await require('../flows').greetingChips(orchestrator.START_CHIPS),
        maxMessageChars: s.chatMaxMessageChars,
        privacy: 'Chats are kept for 90 days to improve answers. Don’t share card or passport details.',
      },
    });
  } catch {
    err(res, 500, 'ERROR', 'Could not load the assistant settings.');
  }
});

/** "Welcome back, Asha!" for a signed-in customer; the usual greeting otherwise. */
async function personalGreeting(userId, lang) {
  const base = orchestrator.greeting(lang);
  if (!userId || lang !== 'en') return base;
  const u = await require('../flows').userVars(userId);
  return u.user?.firstName ? `Welcome back, ${u.user.firstName}! ${base.replace(/^Hello! /, '')}` : base;
}

router.post('/session', async (req, res) => {
  try {
    if (!(await enabled(res))) return;
    let visitorId = identity.verify(req.get('x-chat-visitor'));
    let visitorToken = null;
    if (!visitorId) ({ visitorId, token: visitorToken } = identity.issue());
    const userId = await optionalUser(req);
    const store = require('../memory/store');
    let session = null;
    if (req.body?.sessionId) session = await store.getSession({ id: String(req.body.sessionId), visitorId, userId });
    if (!session && !req.body?.fresh) session = await store.latestSession({ visitorId, userId });
    const history = session ? (await store.messages(session.id)).slice(-20).map((m) => ({ id: m.id, role: m.role, text: m.content, reply: m.role === 'assistant' ? m.reply : undefined, at: m.createdAt })) : [];
    res.json({
      status: 'success',
      data: {
        visitorToken, // only when a new one was issued: the widget stores it
        sessionId: session?.id || null, // null → the first message creates the session
        greeting: await personalGreeting(userId, session?.language || 'en'),
        chips: await require('../flows').greetingChips(orchestrator.START_CHIPS, { signedIn: Boolean(userId) }),
        history,
        signedIn: Boolean(userId),
      },
    });
  } catch (e) {
    err(res, 500, 'ERROR', 'Could not start the chat.');
  }
});

router.post('/message', async (req, res) => {
  const stream = req.query.stream === '1';
  let s;
  try {
    s = await enabled(res);
    if (!s) return;
  } catch {
    return err(res, 500, 'ERROR', 'Could not reach the assistant.');
  }
  const visitorId = identity.verify(req.get('x-chat-visitor'));
  if (!visitorId) return err(res, 401, 'INVALID_SESSION', 'Your chat session has expired. Please reopen the chat.');
  const b = req.body || {};
  // A chip sends an action: { type: 'message', text } or a flow action (choice, dates, guests, flow).
  const action = b.action && typeof b.action === 'object' ? b.action : null;
  const text = String(b.text ?? action?.text ?? action?.label ?? (action?.type === 'dates' ? `${action.from} to ${action.to}` : action?.type === 'date' ? action.date : action?.type === 'guests' ? `${action.adults} adults` : '') ?? '').trim();
  if (!text) return err(res, 400, 'EMPTY', 'Type a message.');
  if (text.length > s.chatMaxMessageChars) return err(res, 413, 'TOO_LONG', `Please keep messages under ${s.chatMaxMessageChars} characters.`);
  if (!sessionRateOk(visitorId, s.chatMessagesPerMinute)) return err(res, 429, 'RATE_LIMITED', 'You’re sending messages very quickly. Please wait a moment.');
  try {
    if ((await tokensToday(visitorId)) >= s.chatDailyTokenBudget) return err(res, 429, 'BUDGET_EXCEEDED', 'You’ve reached today’s chat limit. Our team is happy to help by email.', { chips: [{ label: 'Contact our team', action: { type: 'handoff', url: '/dashboard?tab=queries' } }] });
  } catch { /* budget check unavailable: carry on */ }
  const userId = await optionalUser(req);

  let open = false;
  const send = (event, data) => {
    if (!open) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    open = true;
    req.on('close', () => { open = false; });
  }
  const ping = stream ? setInterval(() => open && res.write(': ping\n\n'), 15000) : null;

  try {
    const r = await memory.runTurn(
      { visitorId, userId, sessionId: b.sessionId ? String(b.sessionId) : undefined, message: text, action: action && action.type !== 'message' ? action : undefined, ipHash: identity.ipHash(chatIp(req)), userAgent: req.get('user-agent'), audience: 'public' },
      stream ? { onToken: (t) => send('token', { t }) } : {}
    );
    const warnings = [];
    if (r.trace.fallback === 'canned') warnings.push('LLM_DOWN');
    if ((r.trace.tools || []).some((x) => ['SUPPLIER_DOWN', 'TIMEOUT'].includes(x.error))) warnings.push('TOOL_DOWN');
    require('../orchestrator/traces').save({ sessionId: r.sessionId, audience: 'public', message: text, reply: r.reply, trace: r.trace }).catch(() => {});
    // ai: the answer was written by the model (feedback makes sense); fixed replies (greetings, questions for missing details) are not.
    const payload = { sessionId: r.sessionId, messageId: r.messageId, reply: r.reply, warnings, ai: (r.trace.llm || []).length > 0 };
    if (stream) {
      send('meta', { sessionId: r.sessionId });
      send('done', payload);
      res.end();
    } else {
      res.json({ status: 'success', data: payload });
    }
  } catch (e) {
    const code = e.code === 'QUOTA' ? 'RATE_LIMITED' : e.status === 401 ? 'INVALID_SESSION' : 'LLM_DOWN';
    const message = code === 'RATE_LIMITED' ? 'The assistant is busy. Please try again in a moment.' : 'Sorry, the assistant is unavailable right now. Please try again shortly.';
    if (stream) {
      send('error', { code, message });
      res.end();
    } else {
      err(res, code === 'RATE_LIMITED' ? 429 : 503, code, message);
    }
  } finally {
    if (ping) clearInterval(ping);
  }
});

router.post('/feedback', async (req, res) => {
  try {
    const visitorId = identity.verify(req.get('x-chat-visitor'));
    if (!visitorId) return err(res, 401, 'INVALID_SESSION', 'Your chat session has expired.');
    const messageId = Number(req.body?.messageId);
    const rating = req.body?.rating === 'down' ? 'down' : req.body?.rating === 'up' ? 'up' : null;
    if (!messageId || !rating) return err(res, 400, 'BAD_FEEDBACK', 'Choose thumbs up or down.');
    // Only feedback on an answer in this visitor's own chat.
    const { rows } = await db.query(
      `SELECT m.session_id FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE m.id = $1 AND m.role = 'assistant' AND s.visitor_id = $2`,
      [messageId, visitorId]
    );
    if (!rows[0]) return err(res, 404, 'NOT_FOUND', 'That message was not found.');
    await db.query(
      `INSERT INTO chat_feedback (message_id, session_id, rating, comment) VALUES ($1, $2, $3, $4)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment), created_at = NOW()`,
      [messageId, rows[0].session_id, rating, req.body?.comment ? String(req.body.comment).slice(0, 1000) : null]
    );
    res.json({ status: 'success', data: { messageId, rating }, message: 'Thanks for the feedback!' });
  } catch {
    err(res, 500, 'ERROR', 'Could not save feedback.');
  }
});

router.use((req, res) => err(res, 404, 'NOT_FOUND', 'Unknown assistant endpoint.'));

module.exports = router;
module.exports._internals = { chatIp, sessionRateOk, allowedOrigins };
