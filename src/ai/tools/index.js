/**
 * Live API tools (DESIGN.md §3.5). The assistant never calls URLs, only these.
 *
 * A tool: { name, title, description, permission, minPermission?, schema,
 *           timeoutMs, cacheSec, maxResults?, run(input, ctx) }
 *
 * The admin can switch a tool off, edit what the model is told about it, and
 * set its limits (rag_tools); code and credentials stay in code. `run()` here
 * is the single door: enabled check → permission → input validation → cache →
 * timeout → result trimmed to maxResults → errors mapped to stable codes.
 *
 * Every call returns { ok, tool, data?, error?: { code, message }, cached, ms }
 * and never throws, so the orchestrator can always hand the model something.
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { validate } = require('./schema');
const { defaultSupplier } = require('./supplier');

const CATALOG = [
  ...require('./catalog/content').tools,
  ...require('./catalog/hotels').tools,
  ...require('./catalog/excursions').tools,
  ...require('./catalog/transfers').tools,
  ...require('./catalog/site').tools,
];
const BY_NAME = new Map(CATALOG.map((t) => [t.name, t]));
const PERMISSIONS = ['public', 'user'];

// ── Admin overrides (rag_tools), cached briefly ─────────────────────────────
let overrides = null;
let overridesAt = 0;
async function loadOverrides(force = false) {
  if (!force && overrides && Date.now() - overridesAt < 30 * 1000) return overrides;
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM rag_tools');
  overrides = new Map(rows.map((r) => [r.name, r]));
  overridesAt = Date.now();
  return overrides;
}

function effective(def, row) {
  const num = (v, d) => (v === null || v === undefined ? d : Number(v));
  let permission = row?.permission || def.permission;
  if (def.minPermission === 'user') permission = 'user'; // never widened to anonymous
  return {
    name: def.name,
    title: def.title,
    description: row?.description || def.description,
    defaultDescription: def.description,
    enabled: row ? Boolean(Number(row.enabled)) : true,
    permission,
    lockedPermission: def.minPermission || null,
    timeoutMs: num(row?.timeout_ms, def.timeoutMs),
    cacheSec: num(row?.cache_sec, def.cacheSec),
    maxResults: num(row?.max_results, def.maxResults ?? null),
    schema: def.schema,
    updatedAt: row?.updated_at || null,
  };
}

async function list() {
  const o = await loadOverrides();
  return CATALOG.map((d) => effective(d, o.get(d.name)));
}

async function getTool(name) {
  const def = BY_NAME.get(name);
  if (!def) return null;
  return effective(def, (await loadOverrides()).get(name));
}

async function configure(name, changes, adminId) {
  const def = BY_NAME.get(name);
  if (!def) throw Object.assign(new Error('Unknown tool'), { status: 404 });
  const cur = effective(def, (await loadOverrides(true)).get(name));
  const int = (v, min, max, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`${label} must be ${min}–${max}`), { status: 400 });
    return n;
  };
  const next = {
    enabled: changes.enabled === undefined ? cur.enabled : Boolean(changes.enabled),
    permission: changes.permission === undefined ? cur.permission : String(changes.permission),
    description: changes.description === undefined ? cur.description : String(changes.description || '').trim(),
    timeoutMs: changes.timeoutMs === undefined ? cur.timeoutMs : int(changes.timeoutMs, 1000, 60000, 'Timeout (ms)'),
    cacheSec: changes.cacheSec === undefined ? cur.cacheSec : int(changes.cacheSec, 0, 3600, 'Cache (s)'),
    maxResults: changes.maxResults === undefined || changes.maxResults === null ? cur.maxResults : int(changes.maxResults, 1, 100, 'Max results'),
  };
  if (!PERMISSIONS.includes(next.permission)) throw Object.assign(new Error('Permission must be public or user'), { status: 400 });
  if (def.minPermission === 'user' && next.permission !== 'user') throw Object.assign(new Error('This tool reads personal data and must stay “signed-in visitors only”'), { status: 400 });
  if (next.description.length < 20 || next.description.length > 1000) throw Object.assign(new Error('Description must be 20–1000 characters'), { status: 400 });
  await db.query(
    `INSERT INTO rag_tools (name, enabled, permission, description, timeout_ms, cache_sec, max_results, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), permission = VALUES(permission), description = VALUES(description),
       timeout_ms = VALUES(timeout_ms), cache_sec = VALUES(cache_sec), max_results = VALUES(max_results), updated_by = VALUES(updated_by)`,
    // A value equal to the code default is stored as NULL ("use the default"), so a
    // later change of the default in code (e.g. a longer timeout) still applies.
    [name, next.enabled ? 1 : 0, next.permission, next.description === def.description ? null : next.description,
      next.timeoutMs === def.timeoutMs ? null : next.timeoutMs, next.cacheSec === def.cacheSec ? null : next.cacheSec,
      next.maxResults === (def.maxResults ?? null) ? null : next.maxResults, adminId || null]
  );
  await loadOverrides(true);
  clearCache(name);
  return { before: cur, after: await getTool(name) };
}

// ── Result cache ─────────────────────────────────────────────────────────────
// The shared cache (services/cache.js): Redis when REDIS_URL is set, memory otherwise (extra track 2.5).
const cache = require('../../services/cache');
const crypto = require('crypto');
const cacheKey = (name, user, input) => `tool:${name}:${user || ''}:${crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex')}`;
function clearCache(name) {
  return cache.delPrefix(name ? `tool:${name}:` : 'tool:').catch(() => {});
}

function trim(data, max) {
  if (!max || !data || !Array.isArray(data.items) || data.items.length <= max) return data;
  return { ...data, items: data.items.slice(0, max), truncated: true, shown: max };
}

const ERRORS = {
  NOT_FOUND: 'There is no such tool.',
  DISABLED: 'This tool is switched off.',
  LOGIN_REQUIRED: 'The visitor has to be logged in for this.',
  TIMEOUT: 'The supplier took too long to answer. Please try again.',
};

/**
 * ctx: { audience: 'public'|'admin', userId?, coerce?, supplier?, deps?, skipCache? }
 * 'admin' (Test call) may run disabled tools and user tools with ctx.userId.
 */
async function run(name, rawInput, ctx = {}) {
  const t0 = Date.now();
  const done = (out) => ({ tool: name, ms: Date.now() - t0, cached: false, ...out });
  // API connectors added in the admin (extra track 2.3 / 2.4): "api.<slug>".
  if (String(name).startsWith('api.')) {
    const r = await require('./connectors').runByTool(name, rawInput);
    if (r) return done(r);
  }
  const def = BY_NAME.get(name);
  if (!def) return done({ ok: false, error: { code: 'NOT_FOUND', message: ERRORS.NOT_FOUND } });
  let tool;
  try {
    tool = effective(def, (await loadOverrides()).get(name));
  } catch (err) {
    return done({ ok: false, error: { code: 'ERROR', message: 'Tool settings could not be loaded.', detail: err.message } });
  }
  const admin = ctx.audience === 'admin';
  if (!tool.enabled && !admin) return done({ ok: false, error: { code: 'DISABLED', message: ERRORS.DISABLED } });
  if (tool.permission === 'user' && !ctx.userId) return done({ ok: false, error: { code: 'LOGIN_REQUIRED', message: ERRORS.LOGIN_REQUIRED } });

  let input;
  try {
    input = validate(rawInput, def.schema, { coerce: Boolean(ctx.coerce) });
  } catch (err) {
    return done({ ok: false, error: { code: 'INVALID_INPUT', message: err.message } });
  }

  const key = cacheKey(name, tool.permission === 'user' ? ctx.userId : '', input);
  const hit = !ctx.skipCache && tool.cacheSec > 0 ? await cache.get(key).catch(() => null) : null;
  if (hit) return done({ ok: true, data: hit, cached: true });

  let timer;
  try {
    const work = def.run(input, { ...ctx, supplier: ctx.supplier || defaultSupplier });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(ERRORS.TIMEOUT), { code: 'TIMEOUT' })), tool.timeoutMs);
    });
    const data = trim(await Promise.race([work, timeout]), tool.maxResults);
    if (tool.cacheSec > 0 && !data?.error) await cache.set(key, data, tool.cacheSec).catch(() => {});
    return done({ ok: !data?.error, data, ...(data?.error ? { error: { code: data.error, message: data.message } } : {}) });
  } catch (err) {
    const code = err.code && /^[A-Z_]+$/.test(err.code) ? err.code : 'ERROR';
    return done({ ok: false, error: { code, message: code === 'ERROR' ? 'Something went wrong with this lookup.' : err.message, detail: err.detail || (code === 'ERROR' ? err.message : undefined) } });
  } finally {
    clearTimeout(timer);
  }
}

/** What the model sees: enabled tools it may call, in OpenAI tool format. */
async function forModel({ userId } = {}) {
  return (await list())
    .filter((t) => t.enabled && (t.permission === 'public' || userId))
    .map((t) => ({ type: 'function', function: { name: t.name.replace('.', '_'), description: t.description, parameters: t.schema } }))
    .concat(await require('./connectors').forModel().catch(() => []));
}

module.exports = { list, getTool, configure, run, forModel, clearCache, CATALOG };
