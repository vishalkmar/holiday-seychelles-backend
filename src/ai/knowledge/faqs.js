/**
 * AI Questions Training (DESIGN.md §5): approved question → answer pairs.
 *
 *  - Each FAQ has variations (other ways visitors ask it); every phrasing is
 *    indexed as its own chunk carrying the same answer.
 *  - Workflow: draft → review → published → archived. Publishing makes it a
 *    'faq' knowledge source; the worker indexes it.
 *  - Every save snapshots a version (history + rollback).
 *  - Duplicates: same normalised text, or the same meaning by embedding.
 *    Thresholds were measured on this account's embedding model (2026-10-16):
 *    true paraphrases score 0.83–0.96, related-but-different questions ~0.6,
 *    unrelated < 0.3. So ≥ 0.90 = duplicate, 0.80–0.90 = similar (warn).
 */

const crypto = require('crypto');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const sources = require('./sources');
const llm = require('../llm');
const settingsStore = require('../settings');
const { cosine, toBuffer, fromBuffer } = require('../vector/math');

const STATUSES = ['draft', 'review', 'published', 'archived'];
const DUPLICATE_AT = 0.9;
const SIMILAR_AT = 0.8;
const MAX_Q = 500;
const MAX_A = 8000;
const MAX_VARIATIONS = 15;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** "What's the best time to visit the Seychelles?" → "whats the best time to visit the seychelles" */
function normalize(q) {
  return String(q || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, MAX_Q);
}

function splitList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v || '').split(/\s*(?:\||\n|;)\s*/).map((x) => x.trim()).filter(Boolean);
}

function cleanInput(input = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || input.question !== undefined) {
    const q = String(input.question || '').replace(/\s+/g, ' ').trim();
    if (!q) throw bad('Question is required');
    if (q.length > MAX_Q) throw bad(`Question is longer than ${MAX_Q} characters`);
    out.question = q;
  }
  if (!partial || input.answer !== undefined) {
    const a = String(input.answer || '').replace(/\r\n?/g, '\n').trim();
    if (!a) throw bad('Answer is required');
    if (a.length > MAX_A) throw bad(`Answer is longer than ${MAX_A} characters`);
    out.answer = a;
  }
  if (input.variations !== undefined) {
    const qn = normalize(out.question ?? input.question);
    const seen = new Set([qn]);
    out.variations = splitList(input.variations)
      .map((v) => v.replace(/\s+/g, ' ').slice(0, MAX_Q))
      .filter((v) => { const n = normalize(v); if (!n || seen.has(n)) return false; seen.add(n); return true; })
      .slice(0, MAX_VARIATIONS);
  }
  if (input.category !== undefined) out.category = String(input.category || '').trim().slice(0, 80) || null;
  if (input.tags !== undefined) out.tags = [...new Set(splitList(input.tags).map((t) => t.toLowerCase().slice(0, 40)))].slice(0, 20);
  if (input.destination !== undefined) out.destination = String(input.destination || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 80) || null;
  if (input.language !== undefined) out.language = String(input.language || 'en').trim().toLowerCase().slice(0, 10) || 'en';
  if (input.visibility !== undefined) out.visibility = input.visibility === 'internal' ? 'internal' : 'public';
  return out;
}

const parseJson = (v, d) => {
  if (v === null || v === undefined) return d;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return d; }
};

async function variationsOf(ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(`SELECT faq_id, question FROM rag_faq_variations WHERE faq_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')}) ORDER BY id`, ids);
  const m = new Map();
  rows.forEach((r) => { const k = Number(r.faq_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r.question); });
  return m;
}

function contentOf(f) {
  return { question: f.question, answer: f.answer, variations: f.variations || [] };
}
const hashOf = (f) => sha(JSON.stringify([f.question, f.answer, f.variations || [], f.category, f.destination, f.visibility]));

function shape(row, variations = [], src = null) {
  const f = {
    id: Number(row.id),
    question: row.question,
    answer: row.answer,
    variations,
    category: row.category,
    tags: parseJson(row.tags_json, []),
    destination: row.destination,
    language: row.language,
    visibility: row.visibility,
    status: row.status,
    version: Number(row.version),
    sourceId: row.source_id ? Number(row.source_id) : null,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
  f.changed = row.status === 'published' && row.published_hash && row.published_hash !== hashOf(f);
  if (src) f.index = { status: src.job_status, error: src.job_error, chunks: Number(src.chunks || 0) };
  return f;
}

async function getRow(id) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM rag_faqs WHERE id = $1', [id]);
  if (!rows[0]) throw bad('Question not found', 404);
  return rows[0];
}

async function get(id) {
  const row = await getRow(id);
  const vars = (await variationsOf([Number(id)])).get(Number(id)) || [];
  let src = null;
  if (row.source_id) {
    const { rows } = await db.query(
      `SELECT j.status AS job_status, j.error AS job_error,
              (SELECT COUNT(*) FROM rag_chunks c JOIN rag_sources s ON s.id = c.source_id AND s.version = c.source_version WHERE c.source_id = $1) AS chunks
         FROM rag_ingestion_jobs j WHERE j.id = (SELECT MAX(id) FROM rag_ingestion_jobs WHERE source_id = $1)`,
      [row.source_id]
    );
    src = rows[0] || null;
  }
  return shape(row, vars, src);
}

async function snapshot(faqId, version, data, note, adminId) {
  await db.query(
    `INSERT INTO rag_faq_versions (faq_id, version, snapshot_json, note, created_by) VALUES ($1, $2, $3, $4, $5)
     ON DUPLICATE KEY UPDATE snapshot_json = VALUES(snapshot_json), note = VALUES(note)`,
    [faqId, version, JSON.stringify(data), note || null, adminId || null]
  );
}

async function setVariations(faqId, variations) {
  await db.query('DELETE FROM rag_faq_variations WHERE faq_id = $1', [faqId]);
  for (const v of variations || []) {
    // eslint-disable-next-line no-await-in-loop
    await db.query('INSERT INTO rag_faq_variations (faq_id, question, question_norm) VALUES ($1, $2, $3)', [faqId, v, normalize(v)]);
  }
}

async function create(input, adminId, { status = 'draft' } = {}) {
  await ensureAiTables();
  const c = cleanInput({ variations: [], ...input });
  const r = await db.query(
    `INSERT INTO rag_faqs (question, question_norm, answer, category, tags_json, destination, language, visibility, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $9)`,
    [c.question, normalize(c.question), c.answer, c.category ?? null, JSON.stringify(c.tags || []), c.destination ?? null, c.language || 'en', c.visibility || 'public', adminId || null]
  );
  const id = Number(r.insertId);
  await setVariations(id, c.variations);
  await snapshot(id, 1, c, 'Created', adminId);
  questionVectors([c.question, ...(c.variations || [])]).catch(() => {}); // warm the duplicate index
  if (status === 'review') await db.query("UPDATE rag_faqs SET status = 'review' WHERE id = $1", [id]);
  if (status === 'published') await publish(id, adminId);
  return get(id);
}

/**
 * Many already-clean FAQs at once (bulk import), as drafts: a few multi-row
 * inserts per 200 rows instead of ~8 round trips per FAQ. Returns the new ids.
 */
async function createMany(list, adminId) {
  await ensureAiTables();
  const ids = [];
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200);
    const params = [];
    const rowsSql = part.map((c) => {
      params.push(c.question, normalize(c.question), c.answer, c.category ?? null, JSON.stringify(c.tags || []), c.destination ?? null, c.language || 'en', c.visibility || 'public', adminId || null);
      const b = params.length - 8;
      return `($${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, 'draft', $${b + 8}, $${b + 8})`;
    });
    // eslint-disable-next-line no-await-in-loop
    const r = await db.query(
      `INSERT INTO rag_faqs (question, question_norm, answer, category, tags_json, destination, language, visibility, status, created_by, updated_by)
       VALUES ${rowsSql.join(', ')}`,
      params
    );
    // A multi-row insert gets consecutive ids from insertId; verify rather than assume.
    const first = Number(r.insertId);
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await db.query(`SELECT id, question_norm FROM rag_faqs WHERE id >= $1 AND id < $2 ORDER BY id`, [first, first + part.length]);
    const partIds = part.map((c, j) => {
      const row = rows[j];
      if (!row || row.question_norm !== normalize(c.question)) throw bad('Bulk insert ids did not line up — nothing after this batch was imported', 500);
      return Number(row.id);
    });

    const vParams = [];
    const vSql = [];
    const sParams = [];
    const sSql = [];
    part.forEach((c, j) => {
      for (const v of c.variations || []) {
        vParams.push(partIds[j], v, normalize(v));
        vSql.push(`($${vParams.length - 2}, $${vParams.length - 1}, $${vParams.length})`);
      }
      sParams.push(partIds[j], JSON.stringify(c), adminId || null);
      sSql.push(`($${sParams.length - 2}, 1, $${sParams.length - 1}, 'Imported', $${sParams.length})`);
    });
    // eslint-disable-next-line no-await-in-loop
    if (vSql.length) await db.query(`INSERT INTO rag_faq_variations (faq_id, question, question_norm) VALUES ${vSql.join(', ')}`, vParams);
    // eslint-disable-next-line no-await-in-loop
    await db.query(`INSERT INTO rag_faq_versions (faq_id, version, snapshot_json, note, created_by) VALUES ${sSql.join(', ')}`, sParams);
    ids.push(...partIds);
  }
  return ids;
}

async function update(id, input, adminId) {
  const row = await getRow(id);
  if (row.status === 'archived') throw bad('Restore this question before editing it');
  const current = await get(id);
  const c = cleanInput({ ...input, question: input.question ?? current.question }, { partial: true });
  const next = { ...contentOf(current), category: current.category, tags: current.tags, destination: current.destination, language: current.language, visibility: current.visibility, ...c };
  const version = Number(row.version) + 1;
  await db.query(
    `UPDATE rag_faqs SET question = $1, question_norm = $2, answer = $3, category = $4, tags_json = $5, destination = $6,
       language = $7, visibility = $8, version = $9, updated_by = $10 WHERE id = $11`,
    [next.question, normalize(next.question), next.answer, next.category ?? null, JSON.stringify(next.tags || []), next.destination ?? null, next.language || 'en', next.visibility || 'public', version, adminId || null, id]
  );
  if (c.variations) await setVariations(id, next.variations);
  await snapshot(id, version, next, input.note || 'Edited', adminId);
  return get(id);
}

async function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw bad('Unknown status');
  await db.query('UPDATE rag_faqs SET status = $1 WHERE id = $2', [status, id]);
}

async function submitForReview(id) {
  const row = await getRow(id);
  if (row.status !== 'draft') throw bad('Only drafts can be sent for review');
  await setStatus(id, 'review');
  return get(id);
}

/** Make the current text live: create or update its 'faq' source and queue indexing. */
async function publish(id, adminId) {
  const f = await get(id);
  if (f.status === 'archived') throw bad('Restore this question before publishing it');
  const meta = { title: f.question.slice(0, 255), destination: f.destination, category: f.category, language: f.language, visibility: f.visibility };
  let result;
  if (f.sourceId) {
    const { rows } = await db.query('SELECT status FROM rag_sources WHERE id = $1', [f.sourceId]);
    if (rows[0]?.status === 'archived') await sources.restore(f.sourceId, adminId).catch(() => {});
    result = await sources.updateSource(f.sourceId, { ...meta, content: contentOf(f), format: 'faq' }, adminId);
  } else {
    result = await sources.createSource({ type: 'faq', ...meta, content: contentOf(f), format: 'faq' }, adminId);
    await db.query('UPDATE rag_faqs SET source_id = $1 WHERE id = $2', [result.sourceId, id]);
  }
  await db.query("UPDATE rag_faqs SET status = 'published', published_hash = $1 WHERE id = $2", [hashOf(f), id]);
  return { ...result, faqId: Number(id) };
}

async function archive(id) {
  const row = await getRow(id);
  if (row.source_id) await sources.archive(Number(row.source_id));
  await setStatus(id, 'archived');
  return get(id);
}

/** Back to draft (out of archive); publish again to make it live. */
async function restore(id) {
  const row = await getRow(id);
  if (row.status !== 'archived') throw bad('Only archived questions can be restored');
  await setStatus(id, 'draft');
  return get(id);
}

async function remove(id) {
  const row = await getRow(id);
  if (row.source_id) await sources.remove(Number(row.source_id));
  await db.query('DELETE FROM rag_faq_variations WHERE faq_id = $1', [id]);
  await db.query('DELETE FROM rag_faq_versions WHERE faq_id = $1', [id]);
  await db.query('DELETE FROM rag_faqs WHERE id = $1', [id]);
  return { id: Number(id) };
}

async function history(id) {
  await getRow(id);
  const { rows } = await db.query('SELECT version, snapshot_json, note, created_by, created_at FROM rag_faq_versions WHERE faq_id = $1 ORDER BY version DESC', [id]);
  return rows.map((r) => ({ version: Number(r.version), snapshot: parseJson(r.snapshot_json, {}), note: r.note, createdBy: r.created_by, createdAt: r.created_at }));
}

/** Bring back an old version's text as a new version (publish to make it live). */
async function rollback(id, version, adminId) {
  const { rows } = await db.query('SELECT snapshot_json FROM rag_faq_versions WHERE faq_id = $1 AND version = $2', [id, version]);
  if (!rows[0]) throw bad('Version not found', 404);
  const snap = parseJson(rows[0].snapshot_json, {});
  return update(id, { ...snap, note: `Rolled back to v${version}` }, adminId);
}

async function list({ q, status, category, destination, limit = 50, offset = 0 } = {}) {
  await ensureAiTables();
  const where = [];
  const params = [];
  if (status === 'changed') where.push("status = 'published'");
  else if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (destination) { params.push(destination); where.push(`destination = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    const i = params.length;
    where.push(`(question LIKE $${i} OR answer LIKE $${i} OR id IN (SELECT faq_id FROM rag_faq_variations WHERE question LIKE $${i}))`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 50));
  const off = Math.max(0, Number.parseInt(offset, 10) || 0);
  const { rows } = await db.query(`SELECT * FROM rag_faqs ${w} ORDER BY updated_at DESC, id DESC LIMIT ${lim} OFFSET ${off}`, params);
  const { rows: total } = await db.query(`SELECT COUNT(*) AS n FROM rag_faqs ${w}`, params);
  const vars = await variationsOf(rows.map((r) => Number(r.id)));
  let items = rows.map((r) => shape(r, vars.get(Number(r.id)) || []));
  if (status === 'changed') items = items.filter((f) => f.changed);
  return { items, total: Number(total[0]?.n || 0) };
}

async function counts() {
  await ensureAiTables();
  const { rows } = await db.query('SELECT status, COUNT(*) AS n FROM rag_faqs GROUP BY status');
  const { rows: cats } = await db.query("SELECT COALESCE(category, '') AS category, COUNT(*) AS n FROM rag_faqs WHERE status <> 'archived' GROUP BY category ORDER BY n DESC");
  const { rows: idx } = await db.query(
    `SELECT COUNT(DISTINCT f.id) AS n FROM rag_faqs f
       JOIN rag_sources s ON s.id = f.source_id AND s.status = 'published'
      WHERE f.status = 'published'`
  );
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const published = by.published || 0;
  return {
    total: Object.values(by).reduce((a, b) => a + b, 0),
    draft: by.draft || 0,
    review: by.review || 0,
    published,
    archived: by.archived || 0,
    indexed: Number(idx[0]?.n || 0),
    indexedPct: published ? Math.round((Number(idx[0]?.n || 0) / published) * 100) : 0,
    categories: cats.map((c) => ({ category: c.category || null, count: Number(c.n) })),
  };
}

// ── Question vectors (for duplicate detection) ──────────────────────────────
// Duplicates are judged question-to-question, which is how the thresholds
// were measured — not question-to-indexed-chunk (those also hold the answer).
// Question embeddings are cached in rag_embed_cache under "faq-q:<normalised>".

const qKey = (norm) => sha(`faq-q:${norm}`);

/** Map(normalised question → Float32Array). Embeds (batched) only what isn't cached. */
async function questionVectors(questions) {
  const byNorm = new Map();
  for (const q of questions) {
    const n = normalize(q);
    if (n && !byNorm.has(n)) byNorm.set(n, q);
  }
  const norms = [...byNorm.keys()];
  const out = new Map();
  if (!norms.length) return out;
  const { embedModel: model } = await settingsStore.getEffective();
  const memKey = (n) => `${model}\u0000${n}`;
  norms.forEach((n) => { const v = memVectors.get(memKey(n)); if (v) out.set(n, v); });
  const toLoad = norms.filter((n) => !out.has(n));
  for (let i = 0; i < toLoad.length; i += 400) {
    const part = toLoad.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await db.query(
      `SELECT sha256, embedding FROM rag_embed_cache WHERE embed_model = $1 AND sha256 IN (${part.map((_, j) => `$${j + 2}`).join(',')})`,
      [model, ...part.map(qKey)]
    );
    const byKey = new Map(rows.map((r) => [r.sha256, fromBuffer(r.embedding)]));
    part.forEach((n) => { const v = byKey.get(qKey(n)); if (v) out.set(n, v); });
  }
  const missing = norms.filter((n) => !out.has(n));
  if (missing.length) {
    const { vectors, model: used } = await llm.embed({ inputs: missing.map((n) => byNorm.get(n)), inputType: 'query', purpose: 'embed' });
    missing.forEach((n, i) => out.set(n, vectors[i]));
    // One multi-row insert per 100 vectors — the database is remote, round trips dominate.
    for (let i = 0; i < missing.length; i += 100) {
      const part = missing.slice(i, i + 100);
      const params = [];
      const values = part.map((n, j) => {
        const v = vectors[i + j];
        params.push(qKey(n), used, v.length, toBuffer(v));
        const b = params.length - 3;
        return `($${b}, $${b + 1}, $${b + 2}, $${b + 3})`;
      });
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `INSERT INTO rag_embed_cache (sha256, embed_model, embed_dim, embedding) VALUES ${values.join(', ')}
         ON DUPLICATE KEY UPDATE embedding = VALUES(embedding)`,
        params
      );
    }
  }
  out.forEach((v, n) => remember(memKey(n), v));
  return out;
}

// Recently used question vectors stay in memory (8 KB each at 2048 dims), so a
// second import check or the commit doesn't pull megabytes from the database again.
const MEM_MAX = 6000;
const memVectors = new Map();
function remember(key, v) {
  if (memVectors.has(key)) memVectors.delete(key);
  memVectors.set(key, v);
  if (memVectors.size > MEM_MAX) memVectors.delete(memVectors.keys().next().value);
}

/** Every live phrasing (question + variations) of every non-archived FAQ, with its vector. */
async function existingPhrasings() {
  const { rows } = await db.query(
    `SELECT f.id, f.question, f.status, f.question_norm AS norm FROM rag_faqs f WHERE f.status <> 'archived'
     UNION ALL
     SELECT f.id, f.question, f.status, v.question_norm AS norm FROM rag_faq_variations v JOIN rag_faqs f ON f.id = v.faq_id WHERE f.status <> 'archived'`
  );
  const vecs = await questionVectors(rows.map((r) => r.norm));
  return rows.map((r) => ({ faqId: Number(r.id), question: r.question, status: r.status, norm: r.norm, vector: vecs.get(r.norm) })).filter((e) => e.vector);
}

/** Compare one question against phrasings: exact wording or same meaning, best per FAQ. */
function matchAgainst(norm, vector, phrasings, { excludeId = null, k = 3 } = {}) {
  const best = new Map();
  for (const p of phrasings) {
    if (p.faqId === Number(excludeId)) continue;
    const exact = p.norm === norm;
    const score = exact ? 1 : cosine(vector, p.vector);
    if (score < SIMILAR_AT) continue;
    const kind = score >= DUPLICATE_AT ? 'duplicate' : 'similar';
    const prev = best.get(p.faqId);
    if (!prev || prev.score < score) best.set(p.faqId, { faqId: p.faqId, question: p.question, status: p.status, score: Number(score.toFixed(3)), kind, reason: exact ? 'Same wording' : 'Same meaning' });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** Possible duplicates of one question among existing FAQs (exact wording or same meaning). */
async function findDuplicates(question, { excludeId = null, k = 3 } = {}) {
  await ensureAiTables();
  const norm = normalize(question);
  if (!norm) return [];
  const [phrasings, vecs] = await Promise.all([existingPhrasings(), questionVectors([question])]);
  return matchAgainst(norm, vecs.get(norm), phrasings, { excludeId, k });
}

/** Export as CSV rows (question, answer, variations "|", category, tags "|", destination, language, visibility, status). */
async function exportCsv() {
  await ensureAiTables();
  const { rows } = await db.query("SELECT * FROM rag_faqs WHERE status <> 'archived' ORDER BY category, id");
  const vars = await variationsOf(rows.map((r) => Number(r.id)));
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['question', 'answer', 'variations', 'category', 'tags', 'destination', 'language', 'visibility', 'status'];
  const lines = rows.map((r) =>
    [r.question, r.answer, (vars.get(Number(r.id)) || []).join(' | '), r.category, parseJson(r.tags_json, []).join(' | '), r.destination, r.language, r.visibility, r.status].map(esc).join(',')
  );
  return `﻿${header.join(',')}\n${lines.join('\n')}\n`;
}

module.exports = {
  normalize, splitList, cleanInput, DUPLICATE_AT, SIMILAR_AT, STATUSES, questionVectors, existingPhrasings, matchAgainst,
  create, createMany, update, get, submitForReview, publish, archive, restore, remove, history, rollback, list, counts, findDuplicates, exportCsv,
};
