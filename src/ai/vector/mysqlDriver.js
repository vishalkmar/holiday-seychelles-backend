/**
 * The built-in vector search: vectors live in rag_chunks.embedding (Float32),
 * searched from an in-memory Int8 index that reloads when chunks change.
 * No extra service, so it runs on cPanel. DESIGN.md §3.2.
 */

const { db } = require('../ports');
const { fromBuffer, quantize, shortlist, cosine, normalize, approxScore, estimateCacheBytes } = require('./math');

let cache = null; // { entries, dim, loadedAt }
let dirty = true;
let loading = null;

function markDirty() {
  dirty = true;
}

function metaOf(row) {
  let m = row.metadata_json;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch { m = {}; }
  }
  return {
    sourceId: Number(row.source_id),
    sourceType: m?.sourceType || null,
    visibility: m?.visibility || 'public',
    destination: m?.destination || null,
    category: m?.category || null,
    language: m?.language || null,
  };
}

async function load() {
  // Only published sources, current version only.
  const { rows } = await db.query(
    `SELECT c.id, c.source_id, c.embedding, c.metadata_json
       FROM rag_chunks c
       JOIN rag_sources s ON s.id = c.source_id AND s.version = c.source_version
      WHERE c.embedding IS NOT NULL AND s.status = 'published'`
  );
  const entries = [];
  let dim = 0;
  for (const r of rows) {
    const v = fromBuffer(r.embedding);
    if (!v || !v.length) continue;
    dim = dim || v.length;
    if (v.length !== dim) continue; // guarded at write time; never mix sizes
    const { q, scale } = quantize(v);
    entries.push({ id: Number(r.id), q, scale, meta: metaOf(r) });
  }
  cache = { entries, dim, loadedAt: new Date() };
  dirty = false;
  return cache;
}

async function ensureLoaded() {
  if (cache && !dirty) return cache;
  if (!loading) {
    loading = load().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/**
 * [{ id, score }] best first, scored on the in-memory Int8 copies.
 * The first version re-scored the shortlist exactly from the Float32 copies in
 * MySQL; with the database remote that was ~3 s per search (80 × 8 KB), for a
 * score change in the third decimal. `exact: true` still does it (admin tools).
 */
async function search({ vector, k = 10, filter, exact = false }) {
  const c = await ensureLoaded();
  const short = shortlist(vector, c.entries, { limit: exact ? Math.max(k * 4, 20) : k, filter });
  if (!short.length || !exact) return short;
  const ids = short.map((s) => s.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.query(`SELECT id, embedding FROM rag_chunks WHERE id IN (${placeholders})`, ids);
  const scored = rows.map((r) => ({ id: Number(r.id), score: cosine(vector, fromBuffer(r.embedding)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Map(id → approximate cosine) for given chunk ids, from the in-memory index. */
async function scoreIds(vector, ids) {
  const c = await ensureLoaded();
  const want = new Set(ids.map(Number));
  const qUnit = normalize(vector);
  const out = new Map();
  for (const e of c.entries) if (want.has(e.id) && e.q.length === qUnit.length) out.set(e.id, approxScore(qUnit, e));
  return out;
}

async function stats() {
  const c = await ensureLoaded();
  return {
    driver: 'mysql',
    vectors: c.entries.length,
    dim: c.dim,
    cacheBytes: estimateCacheBytes(c.entries.length, c.dim),
    loadedAt: c.loadedAt,
  };
}

module.exports = { search, scoreIds, stats, markDirty, ensureLoaded };
