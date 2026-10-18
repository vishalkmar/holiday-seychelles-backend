/**
 * API connectors (extra track 2.3 / 2.4): GET endpoints the assistant may call
 * as tools, added from the admin without code.
 *
 *   internal  one of our own read-only GET routes (discovered from the app,
 *             only under ALLOWED prefixes — never admin, user, auth, payment
 *             or booking routes), called on this server.
 *   external  an outside https GET API. Headers (API keys) are stored
 *             encrypted; private / local addresses are refused (SSRF);
 *             redirects are not followed; the response is capped.
 *
 * Every answer is cached (services/cache.js, Redis or memory) for the
 * connector's cache_sec — the newest answer is served and the API is only
 * called again when it is older than that. If the API then fails, the last
 * good answer is used (marked stale) so visitors aren't left without data.
 * Tool name: "api.<slug>"; excluding a connector only removes it from the
 * assistant, the route itself is untouched.
 */

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { encrypt, decrypt } = require('../secrets');
const cache = require('../../services/cache');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const j = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : v ?? d; } catch { return d; } };

// Our routes the assistant may use: public, read-only content. Everything else is listed but locked.
const ALLOWED = [/^\/api\/blogs(\/|$)/, /^\/api\/site(\/|$)/, /^\/api\/destinations(\/|$)/];
const LOCKED_REASON = [
  [/^\/api\/admin/, 'Admin data'],
  [/^\/api\/user/, 'A customer’s own data'],
  [/^\/api\/(auth|payments|bookings|unsubscribe)/, 'Bookings, payments or sign-in'],
  [/^\/api\/chat/, 'The assistant itself'],
  [/^\/api\/tourvisio/, 'Supplier proxy (hotels, excursions and transfers are built-in tools)'],
];
const MAX_BYTES = 1024 * 1024;
const RESPONSE_CHARS = 12000;

let app = null;
function setApp(a) { app = a; }

// ── Discovery of our own GET routes (Express 4) ──────────────────────────────
function mountPath(layer) {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  const src = layer.regexp.source.replace('\\/?(?=\\/|$)', '').replace(/^\^/, '').replace(/\$$/, '');
  return src.replace(/\\\//g, '/');
}

function routesOf(stack, prefix = '') {
  const out = [];
  for (const layer of stack || []) {
    if (layer.route) {
      if (layer.route.methods?.get) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) if (typeof p === 'string') out.push(`${prefix}${p === '/' ? '' : p}` || '/');
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const m = mountPath(layer);
      if (!/[()[\]*+?|]/.test(m)) out.push(...routesOf(layer.handle.stack, prefix + m));
    }
  }
  return out;
}

/** Our GET routes with whether the assistant may use them. */
function discover() {
  if (!app?._router) return [];
  const seen = new Set();
  return routesOf(app._router.stack)
    .filter((p) => p.startsWith('/api/') && !seen.has(p) && seen.add(p))
    .sort()
    .map((path) => {
      const locked = LOCKED_REASON.find(([re]) => re.test(path));
      const allowed = !locked && ALLOWED.some((re) => re.test(path));
      return { path, allowed, reason: allowed ? null : locked ? locked[1] : 'Not a public content route', params: [...path.matchAll(/:(\w+)/g)].map((m) => m[1]) };
    });
}

// ── Validation ────────────────────────────────────────────────────────────────
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);

function cleanParams(list) {
  return (Array.isArray(list) ? list : []).slice(0, 15).map((p) => {
    const name = String(p.name || '').trim();
    if (!/^[A-Za-z_][\w.-]{0,40}$/.test(name)) throw bad(`Parameter name “${name}” is not valid`);
    return {
      name,
      in: p.in === 'path' ? 'path' : 'query',
      required: Boolean(p.required),
      description: String(p.description || '').slice(0, 200),
      ...(p.value !== undefined && p.value !== null && String(p.value) !== '' ? { value: String(p.value).slice(0, 300) } : {}),
    };
  });
}

function cleanInput(input = {}, { partial = false, existing = null } = {}) {
  const out = {};
  const kind = input.kind ?? existing?.kind;
  if (!['internal', 'external'].includes(kind)) throw bad('Choose our own API or an outside API');
  out.kind = kind;
  if (!partial || input.name !== undefined) {
    out.name = String(input.name || '').trim().slice(0, 120);
    if (!out.name) throw bad('Give the API a name');
  }
  if (!partial || input.description !== undefined) {
    out.description = String(input.description || '').trim().slice(0, 600);
    if (out.description.length < 15) throw bad('Describe what the data is, so the assistant knows when to use it (at least a sentence)');
  }
  if (!partial || input.url !== undefined) {
    const url = String(input.url || '').trim();
    if (kind === 'internal') {
      const route = discover().find((r) => r.path === url);
      if (!route) throw bad('Pick one of our GET routes from the list');
      if (!route.allowed) throw bad(`This route can't be used by the assistant: ${route.reason}`);
    } else {
      let u;
      try { u = new URL(url.replace(/\{(\w+)\}/g, 'x')); } catch { throw bad('Enter a full URL, e.g. https://api.example.com/v1/weather'); }
      if (u.protocol !== 'https:') throw bad('Outside APIs must use https');
      if (u.username || u.password) throw bad('Put credentials in a header, not in the URL');
    }
    out.url = url.slice(0, 600);
  }
  if (input.params !== undefined || !partial) out.params = cleanParams(input.params);
  if (input.headers !== undefined) {
    const h = input.headers && typeof input.headers === 'object' ? input.headers : {};
    const clean = Object.fromEntries(Object.entries(h).filter(([k, v]) => /^[A-Za-z0-9-]{1,60}$/.test(k) && String(v ?? '') !== '').map(([k, v]) => [k, String(v).slice(0, 500)]));
    if (kind === 'internal' && Object.keys(clean).length) throw bad('Our own APIs need no headers');
    out.headers = clean;
  }
  if (input.responsePath !== undefined) out.responsePath = String(input.responsePath || '').trim().replace(/^\$\.?/, '').slice(0, 200) || null;
  const int = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || d));
  if (input.maxItems !== undefined) out.maxItems = int(input.maxItems, 1, 50, 10);
  if (input.cacheSec !== undefined) out.cacheSec = int(input.cacheSec, 0, 86400, 300);
  if (input.timeoutMs !== undefined) out.timeoutMs = int(input.timeoutMs, 2000, 30000, 10000);
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
  return out;
}

// ── Store ─────────────────────────────────────────────────────────────────────
function shape(r, { withHeaders = false } = {}) {
  if (!r) return null;
  const headers = r.headers_enc ? j(decrypt(r.headers_enc), {}) || {} : {};
  return {
    id: Number(r.id),
    kind: r.kind,
    slug: r.slug,
    tool: `api.${r.slug}`,
    name: r.name,
    description: r.description,
    url: r.url,
    params: j(r.params_json, []),
    // Header values are secrets: only their names leave the server.
    headerNames: Object.keys(headers),
    ...(withHeaders ? { headers } : {}),
    responsePath: r.response_path,
    maxItems: r.max_items,
    cacheSec: r.cache_sec,
    timeoutMs: r.timeout_ms,
    enabled: Boolean(r.enabled),
    lastStatus: r.last_status,
    lastError: r.last_error,
    lastCheckedAt: r.last_checked_at,
    updatedAt: r.updated_at,
  };
}

let listCache = null;
async function list({ fresh = false } = {}) {
  await ensureAiTables();
  if (!fresh && listCache && Date.now() - listCache.at < 15000) return listCache.items;
  const { rows } = await db.query('SELECT * FROM rag_api_connectors ORDER BY kind, name');
  const items = rows.map((r) => shape(r));
  listCache = { at: Date.now(), items };
  return items;
}

async function getRow(id) {
  const { rows } = await db.query('SELECT * FROM rag_api_connectors WHERE id = $1', [id]);
  if (!rows[0]) throw bad('Connector not found', 404);
  return rows[0];
}

async function create(input, adminId) {
  await ensureAiTables();
  const c = cleanInput(input);
  let slug = slugify(input.slug || c.name) || `api_${Date.now()}`;
  const { rows } = await db.query('SELECT slug FROM rag_api_connectors WHERE slug LIKE $1', [`${slug}%`]);
  if (rows.some((r) => r.slug === slug)) slug = `${slug}_${rows.length + 1}`;
  const r = await db.query(
    `INSERT INTO rag_api_connectors (kind, slug, name, description, url, params_json, headers_enc, response_path, max_items, cache_sec, timeout_ms, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [c.kind, slug, c.name, c.description, c.url, JSON.stringify(c.params || []), c.headers && Object.keys(c.headers).length ? encrypt(JSON.stringify(c.headers)) : null, c.responsePath ?? null, c.maxItems ?? 10, c.cacheSec ?? 300, c.timeoutMs ?? 10000, c.enabled ? 1 : 0, adminId || null]
  );
  listCache = null;
  return shape(await getRow(Number(r.insertId)));
}

async function update(id, input) {
  const cur = shape(await getRow(id), { withHeaders: true });
  const c = cleanInput({ kind: cur.kind, ...input }, { partial: true, existing: cur });
  const sets = [];
  const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (c.name !== undefined) add('name', c.name);
  if (c.description !== undefined) add('description', c.description);
  if (c.url !== undefined) add('url', c.url);
  if (c.params !== undefined) add('params_json', JSON.stringify(c.params));
  // Header values left blank in the form keep their saved value.
  if (c.headers !== undefined) {
    const merged = { ...cur.headers, ...c.headers };
    for (const k of Object.keys(merged)) if (input.headers && !(k in input.headers)) delete merged[k];
    add('headers_enc', Object.keys(merged).length ? encrypt(JSON.stringify(merged)) : null);
  }
  if (c.responsePath !== undefined) add('response_path', c.responsePath);
  if (c.maxItems !== undefined) add('max_items', c.maxItems);
  if (c.cacheSec !== undefined) add('cache_sec', c.cacheSec);
  if (c.timeoutMs !== undefined) add('timeout_ms', c.timeoutMs);
  if (c.enabled !== undefined) add('enabled', c.enabled ? 1 : 0);
  if (sets.length) {
    vals.push(id);
    await db.query(`UPDATE rag_api_connectors SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }
  listCache = null;
  await cache.delPrefix(`conn:${id}:`).catch(() => {});
  return shape(await getRow(id));
}

async function remove(id) {
  await db.query('DELETE FROM rag_api_connectors WHERE id = $1', [id]);
  listCache = null;
  await cache.delPrefix(`conn:${id}:`).catch(() => {});
  return { ok: true };
}

// ── Calling ───────────────────────────────────────────────────────────────────
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:') && isPrivateIp(s.slice(7));
}

async function assertPublicHost(hostname) {
  const addrs = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw bad(`Can't find the server “${hostname}”`, 502);
  if (addrs.some((a) => isPrivateIp(a.address))) throw bad('That address points inside a private network and is not allowed', 400);
}

/** Pure: the URL to call for these args. Path params fill :name or {name}; the rest go in the query. */
function buildUrl(c, args = {}, base = '') {
  let url = c.url;
  const query = new URLSearchParams();
  for (const p of c.params || []) {
    const v = p.value !== undefined ? p.value : args[p.name];
    if (v === undefined || v === null || v === '') {
      if (p.required) throw bad(`“${p.name}” is needed`);
      continue;
    }
    if (p.in === 'path') url = url.replace(new RegExp(`(:${p.name}\\b|\\{${p.name}\\})`), encodeURIComponent(String(v)));
    else query.set(p.name, String(v));
  }
  if (/:\w+|\{\w+\}/.test(url.replace(/^https?:\/\//, ''))) throw bad('A path parameter has no value');
  const qs = query.toString();
  const full = (c.kind === 'internal' ? base : '') + url;
  return qs ? `${full}${full.includes('?') ? '&' : '?'}${qs}` : full;
}

/** Pure: pick data.items etc. from the answer, keep at most maxItems, cap the size for the prompt. */
function shapeResponse(body, { responsePath, maxItems = 10 } = {}) {
  let data = body;
  if (responsePath) for (const part of responsePath.split('.').filter(Boolean)) data = data == null ? undefined : data[part];
  if (data === undefined) return { error: 'EMPTY', message: `Nothing at “${responsePath}” in the answer` };
  let truncated = false;
  if (Array.isArray(data) && data.length > maxItems) { data = data.slice(0, maxItems); truncated = true; }
  let text = JSON.stringify(data);
  if (text.length > RESPONSE_CHARS) { text = `${text.slice(0, RESPONSE_CHARS)}…`; truncated = true; return { items: null, text, truncated }; }
  return Array.isArray(data) ? { items: data, total: data.length, truncated } : { item: data, truncated };
}

async function fetchJson(url, { headers = {}, timeoutMs = 10000, external }) {
  if (external) await assertPublicHost(new URL(url).hostname);
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  if (res.status >= 300 && res.status < 400) throw bad('The API answered with a redirect, which is not followed', 502);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw bad('The answer is larger than 1 MB', 502);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw bad('The answer is larger than 1 MB', 502);
  if (!res.ok) throw bad(`The API answered ${res.status}`, 502);
  try { return JSON.parse(text); } catch { return { text: text.slice(0, RESPONSE_CHARS) }; }
}

async function markStatus(id, status, error) {
  await db.query('UPDATE rag_api_connectors SET last_status = $1, last_error = $2, last_checked_at = NOW() WHERE id = $3', [status, error ? String(error).slice(0, 500) : null, id]).catch(() => {});
}

/**
 * Call a connector → { data, cached, stale? }. Newest answer within cache_sec
 * is reused; otherwise the API is called; if that fails, the last good answer
 * (kept a day) is returned as stale, or the error is thrown.
 */
async function call(c, args = {}, { skipCache = false, base } = {}) {
  const port = process.env.PORT || 5000;
  const url = buildUrl(c, args, base || `http://127.0.0.1:${port}`);
  const key = `conn:${c.id}:${crypto.createHash('sha1').update(url).digest('hex')}`;
  if (!skipCache && c.cacheSec > 0) {
    const hit = await cache.get(key).catch(() => null);
    if (hit && Date.now() - hit.at < c.cacheSec * 1000) return { data: hit.data, cached: true };
  }
  try {
    const row = c.headers ? c : shape(await getRow(c.id), { withHeaders: true });
    const body = await fetchJson(url, { headers: row.headers || {}, timeoutMs: c.timeoutMs, external: c.kind === 'external' });
    const data = shapeResponse(body, c);
    // Kept a day as the fallback; "fresh" is decided by cache_sec above.
    if (!data.error) await cache.set(key, { at: Date.now(), data }, Math.max(c.cacheSec, 86400)).catch(() => {});
    markStatus(c.id, data.error ? 'empty' : 'ok', data.error ? data.message : null);
    return { data, cached: false };
  } catch (err) {
    markStatus(c.id, 'error', err.message);
    const last = await cache.get(key).catch(() => null);
    if (last) return { data: last.data, cached: true, stale: true };
    throw err;
  }
}

/** For the model: enabled connectors as tool definitions (only the params it fills). */
async function forModel() {
  const items = (await list().catch(() => [])).filter((c) => c.enabled);
  return items.map((c) => {
    const open = c.params.filter((p) => p.value === undefined);
    return {
      type: 'function',
      function: {
        name: `api_${c.slug}`,
        description: `${c.description} (live data from ${c.kind === 'internal' ? 'our website' : 'an outside service'})`,
        parameters: { type: 'object', properties: Object.fromEntries(open.map((p) => [p.name, { type: 'string', description: p.description || p.name }])), required: open.filter((p) => p.required).map((p) => p.name) },
      },
    };
  });
}

const STOP = new Set(['what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'there', 'about', 'have', 'does', 'your', 'some', 'tell', 'show', 'give', 'please', 'today', 'seychelles', 'holidays', 'data', 'live', 'latest', 'information']);
const words = (s) => new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)).map((w) => w.replace(/(ies|es|s)$/, '')) || []);

/**
 * Enabled connectors whose name or description shares words with the
 * visitor's question (pure on the list). A word from the name counts double.
 * Streaming answers only call tools when one matches (orchestrator).
 */
function matchQuestion(message, items) {
  const q = words(message);
  if (!q.size) return [];
  return items
    .filter((c) => c.enabled)
    .map((c) => {
      const name = words(c.name);
      const desc = words(c.description);
      let score = 0;
      for (const w of q) score += name.has(w) ? 2 : desc.has(w) ? 1 : 0;
      return { c, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.c);
}

async function match(message) {
  return matchQuestion(message, await list().catch(() => []));
}

/** Run by tool name ("api.<slug>") — used by tools.run. */
async function runByTool(name, args) {
  const slug = name.replace(/^api\./, '');
  const c = (await list()).find((x) => x.slug === slug);
  if (!c) return null;
  if (!c.enabled) return { ok: false, error: { code: 'DISABLED', message: 'This API is switched off for the assistant.' } };
  try {
    const r = await call(c, args || {});
    return { ok: !r.data.error, data: { ...r.data, source: c.name, ...(r.stale ? { stale: true } : {}) }, cached: r.cached, ...(r.data.error ? { error: { code: r.data.error, message: r.data.message } } : {}) };
  } catch (err) {
    return { ok: false, error: { code: 'API_ERROR', message: err.message } };
  }
}

module.exports = { match, matchQuestion, setApp, discover, list, create, update, remove, call, forModel, runByTool, buildUrl, shapeResponse, isPrivateIp, cleanInput, shape, getRow, ALLOWED };
