/**
 * Health alerts (Phase 20): every 15 minutes, look at the last 15 minutes of
 * model calls, live-tool calls and visitor answers; email the owners when the
 * assistant is failing. One email per kind of problem every 2 hours at most.
 */

const { db } = require('./ports');
const { ensureAiTables } = require('./db');

const EVERY_MS = 15 * 60 * 1000;
const QUIET_MS = 2 * 60 * 60 * 1000;
const last = new Map(); // kind → time of the last email

/**
 * Pure: numbers → problems worth an email. Small samples never alert.
 * { calls, errors, toolCalls, toolFails, turns, fallbacks }
 */
function evaluateHealth(n) {
  const out = [];
  if (n.calls >= 8 && n.errors / n.calls >= 0.25) out.push({ kind: 'llm', summary: `${n.errors} of ${n.calls} AI model calls failed in the last 15 minutes` });
  if (n.toolCalls >= 5 && n.toolFails / n.toolCalls >= 0.3) out.push({ kind: 'tools', summary: `${n.toolFails} of ${n.toolCalls} live searches (hotels, excursions, transfers) failed in the last 15 minutes` });
  if (n.turns >= 6 && n.fallbacks / n.turns >= 0.3) out.push({ kind: 'fallback', summary: `${n.fallbacks} of ${n.turns} visitor answers were canned "can't answer" replies in the last 15 minutes` });
  return out;
}

async function numbers() {
  await ensureAiTables();
  const since = '(NOW() - INTERVAL 15 MINUTE)';
  const [u, t] = await Promise.all([
    db.query(`SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN ok THEN 0 ELSE 1 END), 0) AS errors FROM rag_usage WHERE created_at >= ${since} AND purpose <> 'embed'`),
    db.query(`SELECT trace_json, fallback FROM rag_traces WHERE audience = 'public' AND created_at >= ${since} LIMIT 2000`),
  ]);
  let toolCalls = 0;
  let toolFails = 0;
  let fallbacks = 0;
  for (const r of t.rows) {
    if (r.fallback) fallbacks += 1;
    let trace = r.trace_json;
    try { trace = typeof trace === 'string' ? JSON.parse(trace) : trace || {}; } catch { trace = {}; }
    for (const x of trace.tools || []) {
      toolCalls += 1;
      if (!x.ok) toolFails += 1;
    }
  }
  return { calls: Number(u.rows[0]?.calls || 0), errors: Number(u.rows[0]?.errors || 0), toolCalls, toolFails, turns: t.rows.length, fallbacks };
}

async function check({ now = Date.now(), send } = {}) {
  const problems = evaluateHealth(await numbers());
  const emails = require('./security/emails');
  const fresh = problems.filter((p) => !last.has(p.kind) || now - last.get(p.kind) >= QUIET_MS);
  if (!fresh.length) return { problems, sent: 0 };
  const to = [...new Set([...(await emails.recipients()), ...String(process.env.AI_ALERT_EMAIL || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)])];
  if (!to.length) return { problems, sent: 0 };
  for (const p of fresh) last.set(p.kind, now);
  await (send || emails.sendHealthAlert)({ to, problems: fresh });
  return { problems, sent: fresh.length };
}

let timer = null;
function start() {
  if (timer || process.env.AI_ALERTS_ENABLED === 'false') return;
  timer = setInterval(() => check().catch((err) => console.error('[ai] health check failed:', err.message)), EVERY_MS);
  timer.unref?.();
}

module.exports = { evaluateHealth, check, start };
