/**
 * One ingestion run: a source version's stored content → clean → chunk →
 * embed (only what isn't cached) → write to the vector store.
 *
 *   ingestSourceVersion({ sourceId, version, onProgress }) → stats
 *
 * Embeddings are cached by (sha256 of the chunk text, embedding model), so an
 * edit that changes one paragraph re-embeds one chunk, and restoring or
 * re-indexing an archived source costs no model calls at all.
 */

const crypto = require('crypto');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const settingsStore = require('../settings');
const llm = require('../llm');
const store = require('../vector');
const { toBuffer, fromBuffer } = require('../vector/math');
const { basic, fromHtml } = require('./clean');
const { chunkContent } = require('./chunk');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function loadSource(sourceId, version) {
  const { rows: src } = await db.query('SELECT * FROM rag_sources WHERE id = $1', [sourceId]);
  if (!src[0]) throw Object.assign(new Error(`Source ${sourceId} no longer exists`), { permanent: true });
  const { rows: content } = await db.query('SELECT format, content FROM rag_source_content WHERE source_id = $1 AND version = $2', [sourceId, version]);
  if (content[0]) return { source: src[0], format: content[0].format, content: content[0].content };
  // An uploaded file not parsed yet: parse it now (worker runs on the file's host).
  // eslint-disable-next-line global-require
  const parsed = await require('../knowledge/documents').parseStoredVersion(sourceId, version);
  if (parsed) return { source: src[0], ...parsed };
  throw Object.assign(new Error(`No content stored for source ${sourceId} v${version}`), { permanent: true });
}

async function cachedEmbeddings(hashes, model) {
  if (!hashes.length) return new Map();
  const out = new Map();
  for (let i = 0; i < hashes.length; i += 500) {
    const part = hashes.slice(i, i + 500);
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await db.query(
      `SELECT sha256, embedding FROM rag_embed_cache WHERE embed_model = $1 AND sha256 IN (${part.map((_, j) => `$${j + 2}`).join(',')})`,
      [model, ...part]
    );
    rows.forEach((r) => out.set(r.sha256, fromBuffer(r.embedding)));
  }
  return out;
}

async function cacheEmbeddings(entries, model) {
  for (const { hash, vector } of entries) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO rag_embed_cache (sha256, embed_model, embed_dim, embedding) VALUES ($1, $2, $3, $4)
       ON DUPLICATE KEY UPDATE embedding = VALUES(embedding), embed_dim = VALUES(embed_dim)`,
      [hash, model, vector.length, toBuffer(vector)]
    );
  }
}

/** Clean the stored content according to its format. */
function prepare(format, content) {
  if (format === 'records' || format === 'faq') return content; // structured JSON, handled by its chunker
  if (format === 'html') return fromHtml(content);
  return basic(content);
}

async function ingestSourceVersion({ sourceId, version, onProgress = () => {} }) {
  await ensureAiTables();
  const s = await settingsStore.getEffective();
  onProgress('reading');
  const { source, format, content } = await loadSource(sourceId, version);

  onProgress('chunking');
  const cleaned = prepare(format, content);
  const chunks = chunkContent(
    { format: format === 'html' ? 'markdown' : format, content: cleaned },
    {
      targetTokens: s.chunkTokens,
      overlapPct: s.chunkOverlapPct,
      maxChunks: s.maxChunksPerSource,
      context: format === 'records' ? source.title : undefined,
      // Destination profiles: one chunk per section, so each answers one kind of question.
      mergeSmall: source.type !== 'destination',
    }
  ).filter((c) => c.text.trim());
  if (!chunks.length) throw Object.assign(new Error('The content has no readable text to index.'), { permanent: true });

  const meta = {
    sourceType: source.type,
    visibility: source.visibility || 'public',
    destination: source.destination || null,
    category: source.category || null,
    language: source.language || 'en',
    title: source.title,
  };
  const withHash = chunks.map((c) => ({ ...c, sha256: sha(c.text), metadata: { ...meta, heading: c.heading || null } }));

  onProgress('embedding');
  const model = s.embedModel;
  const cache = await cachedEmbeddings([...new Set(withHash.map((c) => c.sha256))], model);
  const missing = [...new Map(withHash.filter((c) => !cache.has(c.sha256)).map((c) => [c.sha256, c.text]))];
  if (missing.length) {
    const { vectors, model: used } = await llm.embed({ inputs: missing.map(([, text]) => text), inputType: 'passage', purpose: 'embed' });
    const fresh = missing.map(([hash], i) => ({ hash, vector: vectors[i] }));
    await cacheEmbeddings(fresh, used);
    fresh.forEach(({ hash, vector }) => cache.set(hash, vector));
  }

  onProgress('writing');
  const vectors = withHash.map((c) => cache.get(c.sha256));
  const written = await store.writeSource({
    sourceId,
    version,
    chunks: withHash.map(({ text, tokens, sha256, metadata }) => ({ text, tokens, sha256, metadata })),
    vectors,
    embedModel: model,
  });

  return {
    chunks: chunks.length,
    embedded: missing.length,
    reused: chunks.length - missing.length,
    tokens: chunks.reduce((n, c) => n + c.tokens, 0),
    removedOld: written.removed,
    dim: written.dim,
  };
}

module.exports = { ingestSourceVersion, prepare, sha };
