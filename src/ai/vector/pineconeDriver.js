/**
 * Pinecone serverless over its REST data-plane API (no SDK, so nothing new to
 * check against Node 18). Pinecone holds only id + vector + small filter
 * metadata; chunk text stays in MySQL.
 *
 * Vector ids are "c<chunkId>". Serverless indexes can't delete by metadata
 * filter, so deletes always pass explicit ids (MySQL knows them).
 */

const API_VERSION = '2024-07';
const UPSERT_BATCH = 20; // 2048 floats ≈ 30 KB JSON each: ~600 KB a request, fine on a slow uplink
const CONTROL = 'https://api.pinecone.io';

class PineconeError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = 'PineconeError';
    this.code = status === 401 || status === 403 ? 'AUTH' : status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE';
    this.status = status;
    this.detail = detail;
  }
}

const vectorId = (chunkId) => `c${chunkId}`;
const chunkIdOf = (vid) => Number(String(vid).replace(/^c/, ''));

function createPinecone({ apiKey, index, indexHost, namespace }, { fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  let host = indexHost ? (indexHost.startsWith('http') ? indexHost : `https://${indexHost}`) : '';

  async function call(url, { method = 'POST', body, timeoutMs = 20000 } = {}) {
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers: { 'Api-Key': apiKey, 'X-Pinecone-API-Version': API_VERSION, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new PineconeError(`Could not reach Pinecone: ${err.message}`);
    }
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = res.status === 401
        ? 'Pinecone rejected the API key. The key must belong to the same Pinecone project as the index.'
        : `Pinecone error ${res.status}: ${json?.message || json?.error?.message || text.slice(0, 200)}`;
      throw new PineconeError(msg, { status: res.status, detail: json });
    }
    return json;
  }

  async function resolveHost() {
    if (host) return host;
    if (!index) throw new PineconeError('Set PINECONE_INDEX or PINECONE_INDEX_HOST.');
    const d = await call(`${CONTROL}/indexes/${encodeURIComponent(index)}`, { method: 'GET' });
    host = `https://${d.host}`;
    return host;
  }

  return {
    namespace,

    async describe() {
      const h = await resolveHost();
      const s = await call(`${h}/describe_index_stats`, { body: {} });
      return {
        host: h,
        dim: s.dimension || 0,
        totalVectors: s.totalVectorCount ?? s.total_vector_count ?? 0,
        namespaceVectors: s.namespaces?.[namespace]?.vectorCount ?? s.namespaces?.[namespace]?.vector_count ?? 0,
      };
    },

    /** items: [{ chunkId, vector: Float32Array, meta }] */
    async upsert(items) {
      const h = await resolveHost();
      for (let i = 0; i < items.length; i += UPSERT_BATCH) {
        const vectors = items.slice(i, i + UPSERT_BATCH).map((it) => ({
          id: vectorId(it.chunkId),
          values: Array.from(it.vector),
          metadata: Object.fromEntries(Object.entries(it.meta || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')),
        }));
        // A slow uplink (the dev laptop on mobile data) needs longer than a
        // search: 60 s per batch, and one retry before giving up.
        const send = () => call(`${h}/vectors/upsert`, { body: { vectors, namespace }, timeoutMs: 60000 });
        // eslint-disable-next-line no-await-in-loop
        await send().catch(send);
      }
    },

    async deleteIds(chunkIds) {
      if (!chunkIds.length) return;
      const h = await resolveHost();
      for (let i = 0; i < chunkIds.length; i += 1000) {
        // eslint-disable-next-line no-await-in-loop
        await call(`${h}/vectors/delete`, { body: { ids: chunkIds.slice(i, i + 1000).map(vectorId), namespace } });
      }
    },

    async deleteAll() {
      const h = await resolveHost();
      try {
        await call(`${h}/vectors/delete`, { body: { deleteAll: true, namespace } });
      } catch (err) {
        if (err.code !== 'NOT_FOUND') throw err; // an empty namespace is fine
      }
    },

    /** → [{ id: chunkId, score }] */
    async query({ vector, k = 10, filter }) {
      const h = await resolveHost();
      const pf = {};
      for (const [key, want] of Object.entries(filter || {})) {
        if (want === undefined || want === null || want === '') continue;
        if (key === 'sourceIds') pf.sourceId = { $in: want.map(Number) };
        else pf[key] = Array.isArray(want) ? { $in: want } : { $eq: want };
      }
      const r = await call(`${h}/query`, {
        body: { namespace, vector: Array.from(vector), topK: k, includeValues: false, includeMetadata: false, ...(Object.keys(pf).length ? { filter: pf } : {}) },
      });
      return (r.matches || []).map((m) => ({ id: chunkIdOf(m.id), score: Number(m.score) }));
    },
  };
}

module.exports = { createPinecone, PineconeError, vectorId, chunkIdOf };
