/**
 * One rag_usage row per model call. Written after the call and never awaited
 * by the caller's critical path: a logging failure must not fail an answer.
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');

function costOf(tokensIn, tokensOut, settings) {
  const cin = Number(settings?.costPer1kIn) || 0;
  const cout = Number(settings?.costPer1kOut) || 0;
  return Number(((tokensIn / 1000) * cin + (tokensOut / 1000) * cout).toFixed(6));
}

function logUsage({ sessionId = null, purpose, model, tokensIn = 0, tokensOut = 0, latencyMs = 0, ok = true, errorCode = null, settings }) {
  return ensureAiTables()
    .then(() =>
      db.query(
        `INSERT INTO rag_usage (session_id, purpose, model, tokens_in, tokens_out, latency_ms, cost_est, ok, error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [sessionId, purpose, String(model || '').slice(0, 160), tokensIn, tokensOut, Math.round(latencyMs), costOf(tokensIn, tokensOut, settings), ok, errorCode]
      )
    )
    .catch((err) => console.error('[ai] usage log failed:', err.message));
}

/** Totals for the overview: today and the last 30 days. */
async function usageSummary() {
  await ensureAiTables();
  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN created_at >= CURDATE() THEN 1 ELSE 0 END), 0) AS calls_today,
       COALESCE(SUM(CASE WHEN created_at >= CURDATE() THEN tokens_in + tokens_out ELSE 0 END), 0) AS tokens_today,
       COUNT(*) AS calls_30d,
       COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens_30d,
       COALESCE(SUM(cost_est), 0) AS cost_30d,
       COALESCE(SUM(CASE WHEN ok THEN 0 ELSE 1 END), 0) AS errors_30d
     FROM rag_usage WHERE created_at >= (NOW() - INTERVAL 30 DAY)`
  );
  const r = rows[0] || {};
  return {
    callsToday: Number(r.calls_today || 0),
    tokensToday: Number(r.tokens_today || 0),
    calls30d: Number(r.calls_30d || 0),
    tokens30d: Number(r.tokens_30d || 0),
    cost30d: Number(r.cost_30d || 0),
    errors30d: Number(r.errors_30d || 0),
  };
}

module.exports = { logUsage, usageSummary, costOf };
