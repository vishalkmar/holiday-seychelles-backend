/**
 * Changes waiting for a second admin (D6: setting requireSecondApproval,
 * default off). Today only publishing the business instructions uses it.
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const emails = require('./emails');

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const shape = (r) => r && {
  id: Number(r.id),
  action: r.action,
  target: r.target,
  payload: parse(r.payload_json) || {},
  summary: r.summary,
  requestedBy: Number(r.requested_by),
  requestedByEmail: r.requested_email || null,
  status: r.status,
  decidedBy: r.decided_by ? Number(r.decided_by) : null,
  decidedAt: r.decided_at,
  reason: r.reason,
  createdAt: r.created_at,
};

async function adminById(id) {
  const { rows } = await db.query('SELECT id, name, email FROM admins WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Other active admins whose role can edit the prompt (or owners). */
async function approvers(exceptId) {
  const { rows } = await db.query(
    `SELECT a.email FROM admins a JOIN admin_roles r ON r.role_key = a.role_key
      WHERE a.status = 'active' AND a.id <> $1 AND (r.permissions LIKE '%"*"%' OR r.permissions LIKE '%"rag.prompt.edit"%')`,
    [exceptId]
  ).catch(() => ({ rows: [] }));
  return rows.map((r) => r.email);
}

async function create({ action, target, payload, summary, requestedBy }) {
  await ensureAiTables();
  // One open request per target: a new one replaces the old.
  await db.query("UPDATE rag_pending_changes SET status = 'superseded', decided_at = NOW() WHERE status = 'pending' AND action = $1", [action]);
  const r = await db.query(
    'INSERT INTO rag_pending_changes (action, target, payload_json, summary, requested_by) VALUES ($1, $2, $3, $4, $5)',
    [action, target, JSON.stringify(payload || {}), summary, requestedBy.id]
  );
  const p = await get(Number(r.insertId));
  emails.sendApprovalRequest({ approvers: await approvers(requestedBy.id), actor: requestedBy, summary, pendingId: p.id }).catch(() => {});
  return p;
}

async function get(id) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT p.*, a.email AS requested_email FROM rag_pending_changes p LEFT JOIN admins a ON a.id = p.requested_by WHERE p.id = $1', [id]);
  return shape(rows[0]);
}

async function list() {
  await ensureAiTables();
  const { rows } = await db.query('SELECT p.*, a.email AS requested_email FROM rag_pending_changes p LEFT JOIN admins a ON a.id = p.requested_by ORDER BY p.id DESC LIMIT 30');
  return rows.map(shape);
}

async function decide(id, status, admin, reason = null) {
  await db.query('UPDATE rag_pending_changes SET status = $1, decided_by = $2, decided_at = NOW(), reason = $3 WHERE id = $4', [status, admin?.id || null, reason, id]);
}

module.exports = { create, get, list, decide, adminById, approvers };
