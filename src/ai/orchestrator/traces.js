/** Per-turn traces (rag_traces) for the playground and debugging. */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { mask } = require('../memory/pii'); // traces are analytics: no emails, phones or card numbers

async function save({ sessionId, audience = 'public', message, reply, trace }) {
  await ensureAiTables();
  const tokensIn = (trace.llm || []).reduce((n, c) => n + (c.tokensIn || 0), 0);
  const tokensOut = (trace.llm || []).reduce((n, c) => n + (c.tokensOut || 0), 0);
  const r = await db.query(
    `INSERT INTO rag_traces (session_id, audience, route, message, reply_json, trace_json, tokens_in, tokens_out, ms, fallback)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [sessionId || null, audience, trace.route || null, mask(String(message || '')).slice(0, 4000), JSON.stringify(reply), JSON.stringify(trace), tokensIn, tokensOut, trace.ms || 0, trace.fallback ? 1 : 0]
  );
  return Number(r.insertId) || null;
}

async function recent({ sessionId, limit = 20 } = {}) {
  await ensureAiTables();
  const lim = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const { rows } = await db.query(
    `SELECT id, session_id, audience, route, message, reply_json, trace_json, tokens_in, tokens_out, ms, fallback, created_at
       FROM rag_traces ${sessionId ? 'WHERE session_id = $1' : ''} ORDER BY id DESC LIMIT ${lim}`,
    sessionId ? [sessionId] : []
  );
  const j = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  return rows.map((r) => ({ id: Number(r.id), sessionId: r.session_id, audience: r.audience, route: r.route, message: r.message, reply: j(r.reply_json), trace: j(r.trace_json), tokensIn: r.tokens_in, tokensOut: r.tokens_out, ms: r.ms, fallback: Boolean(r.fallback), createdAt: r.created_at }));
}

module.exports = { save, recent };
