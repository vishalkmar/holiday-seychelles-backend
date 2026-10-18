/**
 * Conversations and the feedback queue (Phase 19).
 *
 * Transcripts are shown with personal details masked (emails, phones, card
 * and passport numbers); our own published contact details stay readable.
 * A 👎 answer can be fixed by creating or updating an FAQ in one step; the
 * review row records what was done.
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { mask } = require('../memory/pii');
const faqs = require('../knowledge/faqs');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const j = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v || null; } catch { return null; } };
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || d));

const OURS = ['+248 437 6666', 'info@holidays-seychelles.com'];
/** Mask a visitor's personal details, but not the company's own phone and email. */
function maskText(text) {
  let s = String(text ?? '');
  OURS.forEach((o, i) => { s = s.split(o).join(`\u0000${i}\u0000`); });
  s = mask(s);
  OURS.forEach((o, i) => { s = s.split(`\u0000${i}\u0000`).join(o); });
  return s;
}

/**
 * filters: { q, days, feedback: 'down'|'up'|'any', handoff, signedIn, limit, offset }
 */
async function listConversations({ q, days, feedback, handoff, signedIn, limit, offset } = {}) {
  await ensureAiTables();
  const where = [`s.created_at >= (NOW() - INTERVAL ${clamp(days, 1, 365, 30)} DAY)`];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (q) where.push(`EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id AND m.content LIKE ${p(`%${String(q).slice(0, 100)}%`)})`);
  if (feedback === 'down' || feedback === 'up') where.push(`EXISTS (SELECT 1 FROM chat_feedback f WHERE f.session_id = s.id AND f.rating = ${p(feedback)})`);
  if (feedback === 'any') where.push('EXISTS (SELECT 1 FROM chat_feedback f WHERE f.session_id = s.id)');
  if (handoff === true || handoff === 'true') where.push(`EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id AND m.route = 'handoff')`);
  if (signedIn === true || signedIn === 'true') where.push('s.user_id IS NOT NULL');
  const lim = clamp(limit, 1, 100, 25);
  const off = clamp(offset, 0, 1e6, 0);
  const sql = `SELECT s.id, s.user_id, s.language, s.turns, s.tokens_in, s.tokens_out, s.created_at, s.last_active_at,
      (SELECT m.content FROM chat_messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first_message,
      (SELECT COUNT(*) FROM chat_feedback f WHERE f.session_id = s.id AND f.rating = 'down') AS downs,
      (SELECT COUNT(*) FROM chat_feedback f WHERE f.session_id = s.id AND f.rating = 'up') AS ups
    FROM chat_sessions s WHERE ${where.join(' AND ')} ORDER BY s.last_active_at DESC LIMIT ${lim} OFFSET ${off}`;
  const [{ rows }, count] = await Promise.all([db.query(sql, params), db.query(`SELECT COUNT(*) AS n FROM chat_sessions s WHERE ${where.join(' AND ')}`, params)]);
  return {
    total: Number(count.rows[0]?.n || 0),
    items: rows.map((r) => ({
      id: r.id,
      signedIn: Boolean(r.user_id),
      language: r.language,
      turns: Number(r.turns),
      tokens: Number(r.tokens_in) + Number(r.tokens_out),
      firstMessage: maskText(r.first_message || '').slice(0, 160),
      ups: Number(r.ups),
      downs: Number(r.downs),
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
    })),
  };
}

async function getConversation(id) {
  await ensureAiTables();
  const { rows: s } = await db.query('SELECT id, user_id, language, turns, tokens_in, tokens_out, created_at, last_active_at FROM chat_sessions WHERE id = $1', [String(id)]);
  if (!s[0]) throw bad('Conversation not found', 404);
  const [{ rows: msgs }, { rows: fb }] = await Promise.all([
    db.query('SELECT id, role, content, reply_json, route, created_at FROM chat_messages WHERE session_id = $1 ORDER BY id', [String(id)]),
    db.query('SELECT message_id, rating, comment FROM chat_feedback WHERE session_id = $1', [String(id)]),
  ]);
  const byMsg = new Map(fb.map((f) => [Number(f.message_id), f]));
  return {
    id: s[0].id,
    signedIn: Boolean(s[0].user_id),
    language: s[0].language,
    turns: Number(s[0].turns),
    tokens: Number(s[0].tokens_in) + Number(s[0].tokens_out),
    createdAt: s[0].created_at,
    lastActiveAt: s[0].last_active_at,
    messages: msgs.map((m) => {
      const reply = j(m.reply_json);
      const f = byMsg.get(Number(m.id));
      return {
        id: Number(m.id),
        role: m.role,
        text: maskText(m.content),
        route: m.route,
        cards: (reply?.cards || []).map((c) => ({ title: c.title, price: c.price, currency: c.currency, url: c.url })),
        sources: (reply?.sources || []).map((x) => x.title),
        feedback: f ? { rating: f.rating, comment: f.comment ? maskText(f.comment) : null } : null,
        createdAt: m.created_at,
      };
    }),
  };
}

/** 👎 answers with the question that led to them. status: open | fixed | dismissed | all */
async function feedbackQueue({ status = 'open', limit } = {}) {
  await ensureAiTables();
  const lim = clamp(limit, 1, 200, 50);
  const st = ['open', 'fixed', 'dismissed', 'all'].includes(status) ? status : 'open';
  const { rows } = await db.query(
    `SELECT f.id, f.session_id, f.message_id, f.comment, f.created_at, m.content AS answer, m.route,
        (SELECT u.content FROM chat_messages u WHERE u.session_id = f.session_id AND u.role = 'user' AND u.id < f.message_id ORDER BY u.id DESC LIMIT 1) AS question,
        r.status AS review_status, r.faq_id, r.note, r.resolved_at
       FROM chat_feedback f
       LEFT JOIN chat_messages m ON m.id = f.message_id
       LEFT JOIN rag_feedback_review r ON r.feedback_id = f.id
      WHERE f.rating = 'down' ${st === 'all' ? '' : st === 'open' ? "AND (r.status IS NULL OR r.status = 'open')" : `AND r.status = '${st}'`}
      ORDER BY f.id DESC LIMIT ${lim}`
  );
  const { rows: counts } = await db.query(
    `SELECT COALESCE(r.status, 'open') AS status, COUNT(*) AS n FROM chat_feedback f LEFT JOIN rag_feedback_review r ON r.feedback_id = f.id WHERE f.rating = 'down' GROUP BY COALESCE(r.status, 'open')`
  );
  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    items: rows.map((r) => ({
      id: Number(r.id),
      sessionId: r.session_id,
      question: maskText(r.question || '').slice(0, 1000),
      answer: maskText(r.answer || '').slice(0, 2000),
      route: r.route,
      comment: r.comment ? maskText(r.comment) : null,
      status: r.review_status || 'open',
      faqId: r.faq_id ? Number(r.faq_id) : null,
      note: r.note,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    })),
  };
}

async function setReview(feedbackId, { status, faqId = null, note = null }, adminId) {
  await db.query(
    `INSERT INTO rag_feedback_review (feedback_id, status, faq_id, note, resolved_by, resolved_at) VALUES ($1, $2, $3, $4, $5, ${status === 'open' ? 'NULL' : 'NOW()'})
     ON DUPLICATE KEY UPDATE status = VALUES(status), faq_id = VALUES(faq_id), note = VALUES(note), resolved_by = VALUES(resolved_by), resolved_at = VALUES(resolved_at)`,
    [feedbackId, status, faqId, note ? String(note).slice(0, 500) : null, adminId || null]
  );
}

/**
 * Fix a 👎 with an FAQ in one step: { question, answer, variations?, category?, faqId? }.
 * With faqId the existing FAQ is updated (the visitor's wording added as a
 * variation); otherwise a new one is created. publish: true makes it live now.
 */
async function fixWithFaq(feedbackId, input = {}, adminId) {
  await ensureAiTables();
  const { rows } = await db.query("SELECT id FROM chat_feedback WHERE id = $1 AND rating = 'down'", [feedbackId]);
  if (!rows[0]) throw bad('Feedback not found', 404);
  let faq;
  if (input.faqId) {
    const cur = await faqs.get(Number(input.faqId));
    const variations = [...new Set([...(cur.variations || []), ...[].concat(input.variations || [])].filter(Boolean))];
    faq = await faqs.update(cur.id, { answer: input.answer || cur.answer, variations, note: `Fixed from feedback #${feedbackId}` }, adminId);
  } else {
    faq = await faqs.create({ question: input.question, answer: input.answer, variations: input.variations || [], category: input.category || null, tags: ['from-feedback'] }, adminId);
  }
  if (input.publish) await faqs.publish(faq.id, adminId);
  await setReview(feedbackId, { status: 'fixed', faqId: faq.id, note: input.note }, adminId);
  return { faqId: faq.id, published: Boolean(input.publish) };
}

async function dismissFeedback(feedbackId, note, adminId) {
  await setReview(feedbackId, { status: 'dismissed', note }, adminId);
  return { ok: true };
}

module.exports = { listConversations, getConversation, feedbackQueue, fixWithFaq, dismissFeedback, maskText };
