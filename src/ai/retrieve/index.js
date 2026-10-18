/**
 * Retriever (DESIGN.md §3.4): question → the knowledge the answer may use.
 *
 *   1. Embed the query (inputType 'query'), cached for a few minutes.
 *   2. Hybrid search: vector top-N plus MySQL FULLTEXT top-N over the same
 *      published chunks. Keyword search catches names ("Vallée de Mai",
 *      "Cat Cocos") that embeddings blur.
 *   3. Fusion: the semantic score, boosted by keyword rank
 *      (× 1 + w/(1+rank), w = retrievalKeywordWeight). Plain reciprocal-rank
 *      fusion was tried first: it ignores how strong a match is, so a 0.65
 *      FAQ found only by vectors lost to 0.33 chunks found by both.
 *   4. Optional rerank (setting), then collapse: one chunk per FAQ (all its
 *      phrasings carry the same answer), at most two per other source.
 *   5. Threshold on the best semantic score → `insufficient` when nothing is
 *      relevant enough; the answer step must then say so, not guess.
 *   6. Context within a token budget, one citation id per source: [S1]…[Sn].
 *
 * Visibility: audience 'public' (website chat) never sees internal chunks,
 * whatever filter the caller passes. Only 'admin' (playground/tests) can.
 */

const { db } = require('../ports');
const llm = require('../llm');
const settingsStore = require('../settings');
const store = require('../vector');
const mysqlDriver = require('../vector/mysqlDriver');
const { estimateTokens } = require('../llm/tokens');

// ── Query embedding cache ────────────────────────────────────────────────────
const QUERY_TTL_MS = 10 * 60 * 1000;
const QUERY_MAX = 500;
const queryCache = new Map(); // `${model}\0${text}` → { vector, at }

async function embedQuery(query, model) {
  const key = `${model}\u0000${query.toLowerCase()}`;
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < QUERY_TTL_MS) return { vector: hit.vector, cached: true };
  const { vectors } = await llm.embed({ inputs: [query], inputType: 'query', purpose: 'retrieve' });
  queryCache.delete(key);
  queryCache.set(key, { vector: vectors[0], at: Date.now() });
  if (queryCache.size > QUERY_MAX) queryCache.delete(queryCache.keys().next().value);
  return { vector: vectors[0], cached: false };
}

// ── Keyword search ───────────────────────────────────────────────────────────
// Natural-language FULLTEXT; MySQL ignores stopwords and words under 3 letters.
async function keywordSearch(query, { limit, filter }) {
  const terms = query.replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').trim();
  if (!terms) return [];
  const where = [];
  const params = [terms];
  if (filter.visibility) {
    params.push(filter.visibility);
    where.push(`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.metadata_json, '$.visibility')), 'public') = $${params.length}`);
  }
  if (filter.destination) {
    params.push(filter.destination);
    where.push(`(JSON_EXTRACT(c.metadata_json, '$.destination') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(c.metadata_json, '$.destination')) IN ('', 'null', $${params.length}))`);
  }
  const lim = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const { rows } = await db.query(
    `SELECT c.id, MATCH(c.text) AGAINST($1 IN NATURAL LANGUAGE MODE) AS kw
       FROM rag_chunks c
       JOIN rag_sources s ON s.id = c.source_id AND s.version = c.source_version AND s.status = 'published'
      WHERE MATCH(c.text) AGAINST($1 IN NATURAL LANGUAGE MODE) ${where.length ? `AND ${where.join(' AND ')}` : ''}
      ORDER BY kw DESC LIMIT ${lim}`,
    params
  );
  return rows.map((r) => ({ id: Number(r.id), keyword: Number(r.kw) }));
}

/** Public website pages a source maps to (destinations → /islands/<slug>). */
async function linksFor(sourceIds) {
  if (!sourceIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT source_id, website_slug FROM rag_destinations WHERE website_slug IS NOT NULL AND source_id IN (${sourceIds.map((_, i) => `$${i + 1}`).join(',')})`,
    sourceIds
  ).catch(() => ({ rows: [] }));
  return new Map(rows.map((r) => [Number(r.source_id), `/islands/${r.website_slug}`]));
}

function headingOf(text) {
  // Chunks carry their heading path / question on the first line.
  const first = String(text).split('\n')[0];
  return first.length <= 160 ? first.replace(/^Q:\s*/, '') : null;
}

/**
 * opts: { audience: 'public'|'admin', destination?, k?, includeInternal? (admin only) }
 * → { insufficient, bestScore, context, sources, hits, timings, settings }
 */
async function retrieve(query, opts = {}) {
  const t0 = Date.now();
  const q = String(query || '').trim().slice(0, 1000);
  if (!q) throw Object.assign(new Error('Empty question'), { status: 400 });
  const s = await settingsStore.getEffective();
  const audience = opts.audience === 'admin' ? 'admin' : 'public';
  const filter = { visibility: audience === 'admin' && opts.includeInternal ? null : 'public' };
  const destination = opts.destination ? String(opts.destination).toLowerCase() : null;
  const candidates = s.retrievalCandidates;
  const k = Math.min(20, Math.max(1, Number(opts.k) || s.retrievalTopK));

  const { vector, cached } = await embedQuery(q, s.embedModel);
  const tEmbed = Date.now() - t0;

  // Destination slot: that island's chunks plus general ones (no island).
  const vFilter = destination ? { ...filter, destination: [destination, null] } : filter;
  const [vecHits, kwHits] = await Promise.all([
    store.search({ vector, k: candidates, filter: vFilter }),
    keywordSearch(q, { limit: candidates, filter: { ...filter, destination } }).catch((err) => {
      console.warn('[ai] keyword search failed:', err.message);
      return [];
    }),
  ]);
  const tSearch = Date.now() - t0 - tEmbed;

  // Keyword-only hits get their real semantic score too, so the threshold
  // below means the same thing for every candidate.
  const fused = new Map(); // chunkId → { semantic, vectorRank, keywordRank }
  vecHits.forEach((h, i) => fused.set(h.chunkId, { semantic: h.score, vectorRank: i + 1, keywordRank: null }));
  const kwOnly = kwHits.filter((h) => !fused.has(h.id)).map((h) => h.id);
  const kwScores = kwOnly.length ? await mysqlDriver.scoreIds(vector, kwOnly) : new Map();
  kwHits.forEach((h, i) => {
    const cur = fused.get(h.id);
    if (cur) { cur.keywordRank = i + 1; return; }
    fused.set(h.id, { semantic: kwScores.get(h.id) || 0, vectorRank: null, keywordRank: i + 1 });
  });
  for (const f of fused.values()) f.rrf = f.semantic * (1 + (f.keywordRank ? s.retrievalKeywordWeight / (1 + f.keywordRank) : 0));

  const byVec = new Map(vecHits.map((h) => [h.chunkId, h]));
  const missing = [...fused.keys()].filter((id) => !byVec.has(id));
  const extra = missing.length ? await store.hydrate(missing.map((id) => ({ id, score: fused.get(id).semantic }))) : [];
  const chunks = [...vecHits, ...extra].map((c) => ({ ...c, ...fused.get(c.chunkId) }));
  chunks.sort((a, b) => b.rrf - a.rrf);

  let ranked = chunks;
  let reranked = false;
  if (s.rerankEnabled && chunks.length > 1) {
    try {
      const top = chunks.slice(0, candidates);
      const order = await llm.rerank({ query: q, passages: top.map((c) => c.text) });
      ranked = order.map((o) => ({ ...top[o.index], rerank: o.score }));
      reranked = true;
    } catch (err) {
      console.warn('[ai] rerank failed, using fused order:', err.message);
    }
  }

  // Collapse: one chunk per FAQ, two per other source; drop weak tail.
  const perSource = new Map();
  const picked = [];
  for (const c of ranked) {
    if (c.semantic < s.retrievalMinScore * 0.8) continue;
    const n = perSource.get(c.sourceId) || 0;
    if (n >= (c.sourceType === 'faq' ? 1 : 2)) continue;
    perSource.set(c.sourceId, n + 1);
    picked.push(c);
    if (picked.length >= k) break;
  }

  const bestScore = chunks.reduce((m, c) => Math.max(m, c.semantic || 0), 0);
  const insufficient = !picked.length || bestScore < s.retrievalMinScore;

  // Context: one citation id per source, chunks grouped under it, within budget.
  const links = await linksFor([...new Set(picked.map((c) => c.sourceId))]);
  const sources = [];
  const sid = new Map();
  const blocks = [];
  let used = 0;
  for (const c of insufficient ? [] : picked) {
    const cost = estimateTokens(c.text) + 12;
    if (used + cost > s.retrievalContextTokens && blocks.length) break;
    if (!sid.has(c.sourceId)) {
      const id = `S${sid.size + 1}`;
      sid.set(c.sourceId, id);
      sources.push({ id, sourceId: c.sourceId, title: c.title, type: c.sourceType, url: links.get(c.sourceId) || null });
    }
    blocks.push(`[${sid.get(c.sourceId)}] ${c.title}\n${c.text}`);
    used += cost;
  }

  return {
    query: q,
    audience,
    insufficient,
    bestScore: Number(bestScore.toFixed(4)),
    context: blocks.join('\n\n---\n\n'),
    contextTokens: used,
    sources,
    hits: picked.map((c) => ({
      chunkId: c.chunkId,
      sourceId: c.sourceId,
      citation: sid.get(c.sourceId) || null,
      title: c.title,
      type: c.sourceType,
      heading: headingOf(c.text),
      text: c.text,
      semantic: Number((c.semantic || 0).toFixed(4)),
      fused: Number(c.rrf.toFixed(5)),
      vectorRank: c.vectorRank,
      keywordRank: c.keywordRank,
      rerank: c.rerank ?? null,
      visibility: c.metadata?.visibility || 'public',
      destination: c.metadata?.destination || null,
    })),
    candidates: { vector: vecHits.length, keyword: kwHits.length, fused: chunks.length },
    reranked,
    driver: vecHits.driver,
    timings: { embedMs: tEmbed, embedCached: cached, searchMs: tSearch, totalMs: Date.now() - t0 },
  };
}

module.exports = { retrieve, keywordSearch, embedQuery };
