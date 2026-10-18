/**
 * Flow storage: drafts, published versions, triggers.
 * Published graphs are cached for 30 s (a publish clears the cache at once).
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { validate } = require('./schema');
const tools = require('../tools');

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const parse = (s) => (typeof s === 'string' ? JSON.parse(s) : s);

let cache = null;
function clearCache() {
  cache = null;
}

async function toolList() {
  return (await tools.list()).map((t) => ({ name: t.name, enabled: t.enabled }));
}

function shape(r) {
  return {
    id: Number(r.id),
    key: r.flow_key,
    name: r.name,
    status: r.status,
    publishedVersion: r.published_version ? Number(r.published_version) : null,
    draft: parse(r.draft_json),
    sortOrder: Number(r.sort_order || 0),
    updatedAt: r.updated_at,
  };
}

async function list() {
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM bot_flows ORDER BY sort_order, name');
  return rows.map(shape);
}

async function get(key) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM bot_flows WHERE flow_key = $1', [key]);
  return rows[0] ? shape(rows[0]) : null;
}

/** Create or replace the draft. The key inside the graph must match. */
async function saveDraft(graph, adminId) {
  await ensureAiTables();
  const g = { ...graph, key: String(graph?.key || '').trim() };
  const check = validate(g, { tools: await toolList() });
  const keyOrNameErrors = check.errors.filter((e) => /key|name/i.test(e));
  if (keyOrNameErrors.length) throw bad(keyOrNameErrors[0]);
  const existing = await get(g.key);
  if (existing) {
    await db.query("UPDATE bot_flows SET name = $1, draft_json = $2, updated_by = $3, status = IF(status = 'archived', 'draft', status) WHERE id = $4", [g.name, JSON.stringify(g), adminId || null, existing.id]);
  } else {
    await db.query('INSERT INTO bot_flows (flow_key, name, draft_json, updated_by) VALUES ($1, $2, $3, $4)', [g.key, g.name, JSON.stringify(g), adminId || null]);
  }
  return { flow: await get(g.key), check };
}

async function publish(key, adminId, note) {
  const f = await get(key);
  if (!f) throw bad('Flow not found', 404);
  const check = validate(f.draft, { tools: await toolList() });
  if (!check.ok) throw bad(`Fix these before publishing: ${check.errors.join(' ')}`, 400, { check });
  const version = (f.publishedVersion || 0) + 1;
  await db.query('INSERT INTO bot_flow_versions (flow_id, version, graph_json, note, published_by) VALUES ($1, $2, $3, $4, $5)', [f.id, version, JSON.stringify(f.draft), note || null, adminId || null]);
  await db.query("UPDATE bot_flows SET published_version = $1, status = 'published' WHERE id = $2", [version, f.id]);
  clearCache();
  return { version, check };
}

async function setStatus(key, status) {
  await db.query('UPDATE bot_flows SET status = $1 WHERE flow_key = $2', [status, key]);
  clearCache();
}

/** All published flows (latest versions), for trigger matching. */
async function published() {
  if (cache && Date.now() - cache.at < 30000) return cache.flows;
  await ensureAiTables();
  const { rows } = await db.query(
    `SELECT f.flow_key, v.version, v.graph_json FROM bot_flows f
       JOIN bot_flow_versions v ON v.flow_id = f.id AND v.version = f.published_version
      WHERE f.status = 'published' ORDER BY f.sort_order, f.id`
  );
  const flows = rows.map((r) => ({ key: r.flow_key, version: Number(r.version), graph: parse(r.graph_json) }));
  cache = { at: Date.now(), flows };
  return flows;
}

/** A specific version (sessions stay on the version they started with). */
async function version(key, v) {
  const live = (await published()).find((f) => f.key === key && f.version === Number(v));
  if (live) return live;
  const { rows } = await db.query(
    'SELECT f.flow_key, v.version, v.graph_json FROM bot_flows f JOIN bot_flow_versions v ON v.flow_id = f.id WHERE f.flow_key = $1 AND v.version = $2',
    [key, v]
  );
  return rows[0] ? { key: rows[0].flow_key, version: Number(rows[0].version), graph: parse(rows[0].graph_json) } : null;
}

async function versions(key) {
  const f = await get(key);
  if (!f) return [];
  const { rows } = await db.query('SELECT version, note, published_by, published_at FROM bot_flow_versions WHERE flow_id = $1 ORDER BY version DESC', [f.id]);
  return rows.map((r) => ({ version: Number(r.version), note: r.note, publishedBy: r.published_by, publishedAt: r.published_at }));
}

async function remove(key) {
  const f = await get(key);
  if (!f) return false;
  await db.query('DELETE FROM bot_flow_versions WHERE flow_id = $1', [f.id]);
  await db.query('DELETE FROM bot_flows WHERE id = $1', [f.id]);
  clearCache();
  return true;
}

module.exports = { list, get, saveDraft, publish, setStatus, published, version, versions, remove, clearCache };
