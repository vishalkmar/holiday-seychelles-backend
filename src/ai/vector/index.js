/**
 * The vector store (DESIGN.md §3.2): the only way the rest of the module reads
 * or writes embeddings.
 *
 *  - MySQL (rag_chunks) is always the source of truth: text, metadata and the
 *    Float32 embedding of every chunk.
 *  - The active search driver is `mysql` (built in) or `pinecone`
 *    (RAG_VECTOR_DRIVER). With Pinecone active, writes are mirrored there and
 *    searches go there; if Pinecone fails, search falls back to MySQL so the
 *    assistant keeps answering.
 *  - Switching driver = "Sync to Pinecone" (copies vectors, no re-embedding).
 *
 *   writeSource({ sourceId, version, chunks, vectors, embedModel })
 *   deleteSource(sourceId)
 *   search({ vector, k, filter }) → [{ chunkId, score, text, sourceId, title, sourceType, metadata }]
 *   stats() / syncToPinecone() / checkPinecone()
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { config } = require('../config');
const { toBuffer } = require('./math');
const mysqlDriver = require('./mysqlDriver');
const { createPinecone } = require('./pineconeDriver');

let pinecone = null;
function getPinecone() {
  if (!config.vector.pinecone.configured) return null;
  if (!pinecone) pinecone = createPinecone(config.vector.pinecone);
  return pinecone;
}
const pineconeActive = () => config.vector.driver === 'pinecone' && Boolean(getPinecone());

let lastPineconeError = null;

function parseMeta(m) {
  if (!m) return {};
  if (typeof m === 'string') {
    try { return JSON.parse(m); } catch { return {}; }
  }
  return m;
}

function filterMeta(meta, sourceId) {
  return {
    sourceId: Number(sourceId),
    sourceType: meta.sourceType || null,
    visibility: meta.visibility || 'public',
    destination: meta.destination || null,
    category: meta.category || null,
    language: meta.language || null,
  };
}

/**
 * Refuse to mix embedding models or sizes in one index: vectors from two
 * models are not comparable, so a mixed index returns nonsense.
 */
async function assertCompatible(embedModel, dim) {
  const { rows } = await db.query(
    'SELECT embed_model, embed_dim, COUNT(*) AS n FROM rag_chunks WHERE embedding IS NOT NULL GROUP BY embed_model, embed_dim'
  );
  const other = rows.find((r) => r.embed_model !== embedModel || Number(r.embed_dim) !== dim);
  if (other) {
    const err = new Error(
      `The index holds ${other.n} chunk(s) embedded with ${other.embed_model} (${other.embed_dim}-dim); ` +
        `this write uses ${embedModel} (${dim}-dim). Re-index everything with one model first.`
    );
    err.code = 'MIXED_EMBEDDINGS';
    err.status = 409;
    throw err;
  }
}

/**
 * Replace a source's chunks with a new version. chunks: [{ text, tokens, sha256, metadata }],
 * vectors: Float32Array[] in the same order. Old versions are removed after the
 * new rows are written, so search never sees a half-written source.
 */
async function writeSource({ sourceId, version, chunks, vectors, embedModel }) {
  await ensureAiTables();
  if (chunks.length !== vectors.length) throw new Error('chunks and vectors differ in length');
  const dim = vectors[0]?.length || 0;
  if (chunks.length) await assertCompatible(embedModel, dim);

  const written = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO rag_chunks (source_id, source_version, chunk_index, text, tokens, sha256, metadata_json, embedding, embed_model, embed_dim)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON DUPLICATE KEY UPDATE text = VALUES(text), tokens = VALUES(tokens), sha256 = VALUES(sha256),
         metadata_json = VALUES(metadata_json), embedding = VALUES(embedding), embed_model = VALUES(embed_model), embed_dim = VALUES(embed_dim)`,
      [sourceId, version, i, c.text, c.tokens || 0, c.sha256, JSON.stringify(c.metadata || {}), toBuffer(vectors[i]), embedModel, dim]
    );
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await db.query('SELECT id FROM rag_chunks WHERE source_id = $1 AND source_version = $2 AND chunk_index = $3', [sourceId, version, i]);
    written.push({ chunkId: Number(rows[0].id), vector: vectors[i], meta: filterMeta(c.metadata || {}, sourceId) });
  }

  // Make the new version live first, then drop the old one, so search never
  // sees the source without chunks.
  await db.query('UPDATE rag_sources SET version = $1 WHERE id = $2', [version, sourceId]);

  // Drop this source's other versions and any surplus chunks of this version.
  const { rows: stale } = await db.query(
    'SELECT id FROM rag_chunks WHERE source_id = $1 AND (source_version <> $2 OR chunk_index >= $3)',
    [sourceId, version, chunks.length]
  );
  const staleIds = stale.map((r) => Number(r.id));
  if (staleIds.length) {
    await db.query(`DELETE FROM rag_chunks WHERE id IN (${staleIds.map((_, i) => `$${i + 1}`).join(',')})`, staleIds);
  }

  if (pineconeActive()) {
    try {
      await getPinecone().upsert(written);
      if (staleIds.length) await getPinecone().deleteIds(staleIds);
      lastPineconeError = null;
    } catch (err) {
      // MySQL already has the data; "Sync to Pinecone" repairs the mirror.
      lastPineconeError = { at: new Date(), message: err.message };
    }
  }
  mysqlDriver.markDirty();
  return { written: written.length, removed: staleIds.length, dim };
}

async function deleteSource(sourceId) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT id FROM rag_chunks WHERE source_id = $1', [sourceId]);
  const ids = rows.map((r) => Number(r.id));
  await db.query('DELETE FROM rag_chunks WHERE source_id = $1', [sourceId]);
  if (ids.length && pineconeActive()) {
    try {
      await getPinecone().deleteIds(ids);
    } catch (err) {
      lastPineconeError = { at: new Date(), message: err.message };
    }
  }
  mysqlDriver.markDirty();
  return { removed: ids.length };
}

async function hydrate(hits) {
  if (!hits.length) return [];
  const ids = hits.map((h) => h.id);
  const { rows } = await db.query(
    `SELECT c.id, c.source_id, c.chunk_index, c.text, c.metadata_json, s.title, s.type
       FROM rag_chunks c JOIN rag_sources s ON s.id = c.source_id
      WHERE c.id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`,
    ids
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return hits
    .filter((h) => byId.has(h.id))
    .map((h) => {
      const r = byId.get(h.id);
      return {
        chunkId: h.id,
        score: Number(h.score.toFixed(4)),
        text: r.text,
        sourceId: Number(r.source_id),
        chunkIndex: Number(r.chunk_index),
        title: r.title,
        sourceType: r.type,
        metadata: parseMeta(r.metadata_json),
      };
    });
}

/** filter defaults to public chunks only; pass { visibility: null } to include internal (admin tools). */
async function search({ vector, k = 10, filter = { visibility: 'public' } }) {
  await ensureAiTables();
  let hits;
  let driver = 'mysql';
  let fellBack = false;
  if (pineconeActive()) {
    try {
      hits = await getPinecone().query({ vector, k, filter });
      driver = 'pinecone';
      lastPineconeError = null;
    } catch (err) {
      lastPineconeError = { at: new Date(), message: err.message };
      fellBack = true;
    }
  }
  if (!hits) hits = await mysqlDriver.search({ vector, k, filter });
  const results = await hydrate(hits);
  return Object.assign(results, { driver, fellBack });
}

async function checkPinecone() {
  const p = getPinecone();
  if (!p) return { configured: false };
  try {
    const d = await p.describe();
    lastPineconeError = null;
    return { configured: true, ok: true, ...d, namespace: p.namespace };
  } catch (err) {
    lastPineconeError = { at: new Date(), message: err.message };
    return { configured: true, ok: false, code: err.code, message: err.message };
  }
}

async function stats({ withPinecone = false } = {}) {
  await ensureAiTables();
  const [{ rows: s }, { rows: c }, { rows: models }] = await Promise.all([
    db.query("SELECT COUNT(*) AS n, COALESCE(SUM(status = 'published'), 0) AS published FROM rag_sources"),
    db.query('SELECT COUNT(*) AS n, COALESCE(SUM(embedding IS NOT NULL), 0) AS embedded, COALESCE(SUM(tokens), 0) AS tokens FROM rag_chunks'),
    db.query('SELECT embed_model, embed_dim, COUNT(*) AS n FROM rag_chunks WHERE embedding IS NOT NULL GROUP BY embed_model, embed_dim'),
  ]);
  const local = await mysqlDriver.stats();
  return {
    driver: pineconeActive() ? 'pinecone' : 'mysql',
    requestedDriver: config.vector.requested,
    sources: Number(s[0]?.n || 0),
    publishedSources: Number(s[0]?.published || 0),
    chunks: Number(c[0]?.n || 0),
    embeddedChunks: Number(c[0]?.embedded || 0),
    tokens: Number(c[0]?.tokens || 0),
    models: models.map((m) => ({ model: m.embed_model, dim: Number(m.embed_dim), chunks: Number(m.n) })),
    mysqlIndex: local,
    pinecone: withPinecone ? await checkPinecone() : { configured: Boolean(getPinecone()) },
    lastPineconeError,
  };
}

/** Rebuild the Pinecone namespace from MySQL (vectors are copied, not re-embedded). */
async function syncToPinecone() {
  const p = getPinecone();
  if (!p) {
    const err = new Error('Pinecone is not configured (PINECONE_API_KEY and PINECONE_INDEX or PINECONE_INDEX_HOST).');
    err.status = 400;
    throw err;
  }
  const info = await p.describe();
  const { rows: dims } = await db.query('SELECT DISTINCT embed_dim FROM rag_chunks WHERE embedding IS NOT NULL');
  const dim = Number(dims[0]?.embed_dim || 0);
  if (dim && info.dim && dim !== info.dim) {
    const err = new Error(`The Pinecone index is ${info.dim}-dim but the knowledge is ${dim}-dim. Create a ${dim}-dim index.`);
    err.status = 409;
    throw err;
  }
  await p.deleteAll();
  const { rows } = await db.query(
    `SELECT c.id, c.source_id, c.embedding, c.metadata_json FROM rag_chunks c
       JOIN rag_sources s ON s.id = c.source_id AND s.version = c.source_version
      WHERE c.embedding IS NOT NULL AND s.status = 'published'`
  );
  const { fromBuffer } = require('./math');
  const items = rows.map((r) => ({ chunkId: Number(r.id), vector: fromBuffer(r.embedding), meta: filterMeta(parseMeta(r.metadata_json), r.source_id) }));
  await p.upsert(items);
  lastPineconeError = null;
  return { synced: items.length, index: info.host, namespace: p.namespace };
}

module.exports = { writeSource, deleteSource, search, hydrate, stats, syncToPinecone, checkPinecone, pineconeActive };
