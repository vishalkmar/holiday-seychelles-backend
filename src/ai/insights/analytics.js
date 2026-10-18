/**
 * Assistant analytics and usage (Phase 19), from what is already recorded:
 *   rag_traces       one row per answered turn (route, tools, fallback, tokens)
 *   chat_sessions    one row per visitor conversation
 *   chat_feedback    👍 / 👎 on answers
 *   rag_usage        one row per model call (tokens, estimated cost)
 *   rag_limit_hits   visitors stopped by a chat limit
 * Admin playground turns (audience 'admin') are left out of visitor numbers.
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');

const clampDays = (d) => Math.min(365, Math.max(1, Number.parseInt(d, 10) || 30));
const j = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v || {}; } catch { return {}; } };
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** Every day in the window, oldest first, so charts have no gaps. */
function daysBack(days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
  return out;
}

/** "Hotels on Praslin?" and "hotels on praslin" count as one question. */
function normalizeQuestion(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Turn-level numbers from the traces: tool success, handoffs, fallbacks, top
 * questions. Pure, so it is tested without a database.
 */
function summarizeTraces(rows) {
  const routes = {};
  const questions = new Map();
  const tools = {};
  let handoffs = 0;
  let fallbacks = 0;
  for (const r of rows) {
    routes[r.route || 'unknown'] = (routes[r.route || 'unknown'] || 0) + 1;
    if (r.fallback) fallbacks += 1;
    const trace = j(r.trace_json);
    // A handoff: the visitor asked for the team, or a flow ended in its handoff step.
    if (r.route === 'handoff' || trace.flow?.handoff) handoffs += 1;
    for (const t of trace.tools || []) {
      if (!t?.tool) continue;
      const s = (tools[t.tool] = tools[t.tool] || { tool: t.tool, calls: 0, ok: 0 });
      s.calls += 1;
      if (t.ok) s.ok += 1;
    }
    const n = normalizeQuestion(r.message);
    if (n.length >= 3 && r.route !== 'flow') {
      const q = questions.get(n) || { question: String(r.message).slice(0, 200), count: 0 };
      q.count += 1;
      questions.set(n, q);
    }
  }
  const turns = rows.length;
  return {
    turns,
    routes: Object.entries(routes).map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count),
    topQuestions: [...questions.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    tools: Object.values(tools).map((t) => ({ ...t, successRate: t.calls ? Number((t.ok / t.calls).toFixed(3)) : null })).sort((a, b) => b.calls - a.calls),
    handoffs,
    handoffRate: turns ? Number((handoffs / turns).toFixed(3)) : 0,
    fallbacks,
    fallbackRate: turns ? Number((fallbacks / turns).toFixed(3)) : 0,
  };
}

async function analytics({ days } = {}) {
  await ensureAiTables();
  const d = clampDays(days);
  const since = `(NOW() - INTERVAL ${d} DAY)`;
  const [sessions, turnsPerDay, traceRows, feedback] = await Promise.all([
    db.query(`SELECT DATE(created_at) AS day, COUNT(*) AS n FROM chat_sessions WHERE created_at >= ${since} GROUP BY DATE(created_at)`),
    db.query(`SELECT DATE(created_at) AS day, COUNT(*) AS n FROM rag_traces WHERE audience = 'public' AND created_at >= ${since} GROUP BY DATE(created_at)`),
    // The newest 5000 turns are enough for rates and top questions.
    db.query(`SELECT route, message, reply_json, trace_json, fallback FROM rag_traces WHERE audience = 'public' AND created_at >= ${since} ORDER BY id DESC LIMIT 5000`),
    db.query(`SELECT rating, COUNT(*) AS n FROM chat_feedback WHERE created_at >= ${since} GROUP BY rating`),
  ]);
  const chats = new Map(sessions.rows.map((r) => [day(r.day), Number(r.n)]));
  const turns = new Map(turnsPerDay.rows.map((r) => [day(r.day), Number(r.n)]));
  const up = Number(feedback.rows.find((r) => r.rating === 'up')?.n || 0);
  const down = Number(feedback.rows.find((r) => r.rating === 'down')?.n || 0);
  return {
    days: d,
    perDay: daysBack(d).map((x) => ({ day: x, chats: chats.get(x) || 0, turns: turns.get(x) || 0 })),
    totals: { chats: [...chats.values()].reduce((a, b) => a + b, 0), turns: [...turns.values()].reduce((a, b) => a + b, 0) },
    ...summarizeTraces(traceRows.rows),
    feedback: { up, down, csat: up + down ? Number((up / (up + down)).toFixed(3)) : null },
  };
}

async function usage({ days } = {}) {
  await ensureAiTables();
  const d = clampDays(days);
  const since = `(NOW() - INTERVAL ${d} DAY)`;
  const [perDay, perModel, limits, sessions] = await Promise.all([
    db.query(`SELECT DATE(created_at) AS day, COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout, COALESCE(SUM(cost_est), 0) AS cost, COALESCE(SUM(CASE WHEN ok THEN 0 ELSE 1 END), 0) AS errors FROM rag_usage WHERE created_at >= ${since} GROUP BY DATE(created_at)`),
    db.query(`SELECT model, purpose, COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout, COALESCE(SUM(cost_est), 0) AS cost, COALESCE(SUM(CASE WHEN ok THEN 0 ELSE 1 END), 0) AS errors, COALESCE(AVG(latency_ms), 0) AS ms FROM rag_usage WHERE created_at >= ${since} GROUP BY model, purpose ORDER BY calls DESC`),
    db.query(`SELECT code, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions FROM rag_limit_hits WHERE created_at >= ${since} GROUP BY code`),
    db.query(`SELECT COUNT(*) AS n, COALESCE(AVG(tokens_in + tokens_out), 0) AS avg_tokens FROM chat_sessions WHERE created_at >= ${since}`),
  ]);
  const byDay = new Map(perDay.rows.map((r) => [day(r.day), r]));
  const num = (v) => Number(v) || 0;
  const days2 = daysBack(d).map((x) => {
    const r = byDay.get(x);
    return { day: x, calls: num(r?.calls), tokensIn: num(r?.tin), tokensOut: num(r?.tout), cost: Number(num(r?.cost).toFixed(4)), errors: num(r?.errors) };
  });
  return {
    days: d,
    perDay: days2,
    perModel: perModel.rows.map((r) => ({ model: r.model, purpose: r.purpose, calls: num(r.calls), tokensIn: num(r.tin), tokensOut: num(r.tout), cost: Number(num(r.cost).toFixed(4)), errors: num(r.errors), avgMs: Math.round(num(r.ms)) })),
    totals: days2.reduce((t, x) => ({ calls: t.calls + x.calls, tokens: t.tokens + x.tokensIn + x.tokensOut, cost: Number((t.cost + x.cost).toFixed(4)), errors: t.errors + x.errors }), { calls: 0, tokens: 0, cost: 0, errors: 0 }),
    limitHits: limits.rows.map((r) => ({ code: r.code, hits: num(r.n), sessions: num(r.sessions) })),
    sessions: { count: num(sessions.rows[0]?.n), avgTokens: Math.round(num(sessions.rows[0]?.avg_tokens)) },
  };
}

/** Rows → CSV text (quoted where needed), for the export buttons. */
function toCsv(rows, columns) {
  const q = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => q(c.label)).join(','), ...rows.map((r) => columns.map((c) => q(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','))].join('\r\n');
}

module.exports = { analytics, usage, summarizeTraces, normalizeQuestion, toCsv, daysBack };
