/**
 * Vector maths for the built-in MySQL store. Pure functions — no I/O — so the
 * search logic is tested without a database.
 *
 * Memory: the embedding model is 2048-dim, so a Float32 vector is 8 KB and
 * 50k chunks would need ~400 MB — too much for the cPanel box. The in-memory
 * index therefore keeps each vector as Int8 (2 KB, 4× smaller) with its scale,
 * ranks candidates on that, and re-scores the shortlist exactly from the
 * Float32 copy held in MySQL.
 */

/** Float32Array ↔ Buffer (little-endian), the format stored in rag_chunks.embedding. */
function toBuffer(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function fromBuffer(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Copy so the Float32Array is aligned and owns its memory.
  const copy = new Uint8Array(b.length);
  copy.set(b);
  return new Float32Array(copy.buffer, 0, Math.floor(b.length / 4));
}

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  return Math.sqrt(s);
}

function normalize(v) {
  const n = norm(v) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n;
  return out;
}

function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`Vector size mismatch (${a.length} vs ${b.length})`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Normalised vector → { q: Int8Array, scale } where v[i] ≈ q[i] * scale. */
function quantize(v) {
  const u = normalize(v);
  let max = 0;
  for (let i = 0; i < u.length; i += 1) max = Math.max(max, Math.abs(u[i]));
  const scale = max / 127 || 1;
  const q = new Int8Array(u.length);
  for (let i = 0; i < u.length; i += 1) q[i] = Math.round(u[i] / scale);
  return { q, scale };
}

/** Approximate cosine between a normalised query (Float32) and a quantized vector. */
function approxScore(queryUnit, entry) {
  const { q, scale } = entry;
  let dot = 0;
  for (let i = 0; i < q.length; i += 1) dot += queryUnit[i] * q[i];
  return dot * scale;
}

/**
 * filter: { visibility?, sourceType?: string | string[], destination?, category?, language?, sourceIds?: number[] }
 * meta:   the same fields on one chunk.
 */
function matches(meta, filter = {}) {
  for (const [key, want] of Object.entries(filter)) {
    if (want === undefined || want === null || want === '') continue;
    const have = key === 'sourceIds' ? meta.sourceId : meta[key];
    const list = key === 'sourceIds' ? want : Array.isArray(want) ? want : [want];
    if (!list.map(String).includes(String(have))) return false;
  }
  return true;
}

/**
 * Rank cached entries for a query. entries: [{ id, q, scale, meta }].
 * Returns the best `limit` as [{ id, score }] (approximate scores).
 */
function shortlist(queryVec, entries, { limit = 40, filter } = {}) {
  const qUnit = normalize(queryVec);
  const scored = [];
  for (const e of entries) {
    if (e.q.length !== qUnit.length) continue;
    if (filter && !matches(e.meta, filter)) continue;
    scored.push({ id: e.id, score: approxScore(qUnit, e) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Bytes the in-memory index uses for n vectors of `dim` (Int8 + per-entry overhead). */
function estimateCacheBytes(n, dim) {
  return n * (dim + 120);
}

module.exports = { toBuffer, fromBuffer, normalize, cosine, quantize, approxScore, matches, shortlist, estimateCacheBytes };
