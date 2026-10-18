/**
 * Knowledge sources: create, edit (new version), archive, restore, delete.
 *
 * A source's `version` is the version that is live in search. New content is
 * stored as the next version and queued; the worker makes it live when it has
 * been indexed, so search keeps answering from the old version meanwhile.
 *
 * Status: draft → processing → published | failed;  published → archived → (restore) → published
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const store = require('../vector');
const worker = require('../ingest/worker');

const TYPES = ['text', 'faq', 'destination', 'document'];
const FORMATS = ['text', 'markdown', 'html', 'records', 'faq'];
const VISIBILITY = ['public', 'internal'];
const MAX_CONTENT = 5 * 1024 * 1024; // 5 MB of text per version

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function cleanMeta(input = {}) {
  const out = {};
  if (input.title !== undefined) {
    const t = String(input.title || '').trim();
    if (!t) throw bad('Title is required');
    out.title = t.slice(0, 255);
  }
  if (input.destination !== undefined) out.destination = String(input.destination || '').trim().toLowerCase().slice(0, 80) || null;
  if (input.category !== undefined) out.category = String(input.category || '').trim().slice(0, 80) || null;
  if (input.language !== undefined) out.language = String(input.language || 'en').trim().toLowerCase().slice(0, 10) || 'en';
  if (input.visibility !== undefined) {
    if (!VISIBILITY.includes(input.visibility)) throw bad('Visibility must be public or internal');
    out.visibility = input.visibility;
  }
  return out;
}

function cleanContent(content, format) {
  const f = format || 'text';
  if (!FORMATS.includes(f)) throw bad(`Unknown format "${f}"`);
  const text = (f === 'records' || f === 'faq') && typeof content !== 'string' ? JSON.stringify(content) : String(content ?? '');
  if (!text.trim()) throw bad('Content is empty');
  if (Buffer.byteLength(text) > MAX_CONTENT) throw bad('Content is larger than 5 MB');
  return { format: f, content: text };
}

/** Highest version with content or an uploaded file (a fresh upload has a file before it has text). */
async function latestContentVersion(sourceId) {
  const { rows } = await db.query(
    `SELECT GREATEST(COALESCE((SELECT MAX(version) FROM rag_source_content WHERE source_id = $1), 0),
                     COALESCE((SELECT MAX(version) FROM rag_documents WHERE source_id = $1), 0)) AS v`,
    [sourceId]
  );
  return Number(rows[0]?.v || 0);
}

async function getSource(id) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM rag_sources WHERE id = $1', [id]);
  if (!rows[0]) throw Object.assign(new Error('Source not found'), { status: 404 });
  return rows[0];
}

/** { type, title, content, format, destination, category, language, visibility } */
async function createSource(input, adminId, { requiredHost = null } = {}) {
  await ensureAiTables();
  const type = input.type || 'text';
  if (!TYPES.includes(type)) throw bad(`Unknown source type "${type}"`);
  const meta = cleanMeta({ title: input.title, destination: input.destination, category: input.category, language: input.language, visibility: input.visibility || 'public' });
  const { format, content } = cleanContent(input.content, input.format);
  const r = await db.query(
    `INSERT INTO rag_sources (type, title, status, destination, category, language, visibility, version, created_by)
     VALUES ($1, $2, 'draft', $3, $4, $5, $6, 0, $7)`,
    [type, meta.title, meta.destination || null, meta.category || null, meta.language || 'en', meta.visibility, adminId || null]
  );
  const sourceId = Number(r.insertId);
  await db.query('INSERT INTO rag_source_content (source_id, version, format, content, created_by) VALUES ($1, 1, $2, $3, $4)', [sourceId, format, content, adminId || null]);
  const jobId = await worker.enqueue({ sourceId, version: 1, requiredHost, createdBy: adminId });
  return { sourceId, version: 1, jobId };
}

/**
 * Change metadata and/or content. New content → next version. Metadata only →
 * re-index the latest version (embeddings come from the cache, so it's cheap),
 * because the metadata is stored on every chunk.
 */
async function updateSource(id, input, adminId, { requiredHost = null } = {}) {
  const src = await getSource(id);
  if (src.status === 'archived') throw bad('Restore the source before editing it');
  const meta = cleanMeta(input);
  const sets = Object.keys(meta);
  if (sets.length) {
    await db.query(
      `UPDATE rag_sources SET ${sets.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${sets.length + 1}`,
      [...sets.map((k) => meta[k]), id]
    );
  }
  let version = await latestContentVersion(id);
  if (input.content !== undefined) {
    const { format, content } = cleanContent(input.content, input.format);
    const { rows } = await db.query('SELECT content, format FROM rag_source_content WHERE source_id = $1 AND version = $2', [id, version]);
    const unchanged = rows[0] && rows[0].content === content && rows[0].format === format;
    if (!unchanged) {
      version += 1;
      await db.query('INSERT INTO rag_source_content (source_id, version, format, content, created_by) VALUES ($1, $2, $3, $4, $5)', [id, version, format, content, adminId || null]);
    } else if (!sets.length) {
      return { sourceId: Number(id), version, jobId: null, unchanged: true };
    }
  }
  const jobId = await worker.enqueue({ sourceId: Number(id), version, requiredHost, createdBy: adminId });
  return { sourceId: Number(id), version, jobId };
}

async function reindex(id, adminId) {
  const src = await getSource(id);
  if (src.status === 'archived') throw bad('Restore the source before re-indexing it');
  const version = await latestContentVersion(id);
  if (!version) throw bad('This source has no content to index');
  const { rows } = await db.query('SELECT required_host FROM rag_ingestion_jobs WHERE source_id = $1 ORDER BY id DESC LIMIT 1', [id]);
  const jobId = await worker.enqueue({ sourceId: Number(id), version, requiredHost: rows[0]?.required_host || null, createdBy: adminId });
  return { sourceId: Number(id), version, jobId };
}

/** Archive: out of search (vectors removed), content kept for restore. */
async function archive(id) {
  await getSource(id);
  await db.query("UPDATE rag_ingestion_jobs SET status = 'cancelled', finished_at = NOW() WHERE source_id = $1 AND status = 'queued'", [id]);
  const r = await store.deleteSource(Number(id));
  await db.query("UPDATE rag_sources SET status = 'archived', version = 0 WHERE id = $1", [id]);
  return { sourceId: Number(id), removedChunks: r.removed };
}

async function restore(id, adminId) {
  const src = await getSource(id);
  if (src.status !== 'archived') throw bad('Only archived sources can be restored');
  await db.query("UPDATE rag_sources SET status = 'draft' WHERE id = $1", [id]);
  return reindex(id, adminId);
}

async function remove(id) {
  await getSource(id);
  const r = await store.deleteSource(Number(id));
  await db.query("UPDATE rag_ingestion_jobs SET status = 'cancelled', finished_at = NOW() WHERE source_id = $1 AND status IN ('queued')", [id]);
  const { rows: docs } = await db.query('SELECT storage_path, storage_host FROM rag_documents WHERE source_id = $1', [id]);
  await db.query('DELETE FROM rag_source_content WHERE source_id = $1', [id]);
  await db.query('DELETE FROM rag_documents WHERE source_id = $1', [id]);
  await db.query('DELETE FROM rag_sources WHERE id = $1', [id]);
  return { sourceId: Number(id), removedChunks: r.removed, files: docs };
}

async function list({ type, status, q, limit = 50, offset = 0 } = {}) {
  await ensureAiTables();
  const where = ["s.type <> 'sample'"];
  const params = [];
  if (type) { params.push(type); where.push(`s.type = $${params.length}`); }
  if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`s.title LIKE $${params.length}`); }
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
  const { rows } = await db.query(
    `SELECT s.*,
       (SELECT COUNT(*) FROM rag_chunks c WHERE c.source_id = s.id AND c.source_version = s.version) AS chunk_count,
       (SELECT COALESCE(MAX(version), 0) FROM rag_source_content sc WHERE sc.source_id = s.id) AS latest_version
     FROM rag_sources s WHERE ${where.join(' AND ')}
     ORDER BY s.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const ids = rows.map((r) => Number(r.id));
  const jobs = ids.length
    ? (await db.query(
        `SELECT j.* FROM rag_ingestion_jobs j
           JOIN (SELECT source_id, MAX(id) AS id FROM rag_ingestion_jobs WHERE source_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')}) GROUP BY source_id) m ON m.id = j.id`,
        ids
      )).rows
    : [];
  const jobBy = new Map(jobs.map((j) => [Number(j.source_id), j]));
  return rows.map((r) => shape(r, jobBy.get(Number(r.id))));
}

function shape(r, job) {
  let stats = job?.stats_json;
  if (typeof stats === 'string') { try { stats = JSON.parse(stats); } catch { stats = null; } }
  return {
    id: Number(r.id),
    type: r.type,
    title: r.title,
    status: r.status,
    destination: r.destination,
    category: r.category,
    language: r.language,
    visibility: r.visibility,
    liveVersion: Number(r.version),
    latestVersion: Number(r.latest_version ?? r.version),
    chunks: Number(r.chunk_count || 0),
    updatedAt: r.updated_at,
    createdAt: r.created_at,
    job: job
      ? { id: Number(job.id), status: job.status, version: Number(job.source_version), attempts: Number(job.attempts), error: job.error, stats, finishedAt: job.finished_at, createdAt: job.created_at }
      : null,
  };
}

async function detail(id) {
  const src = await getSource(id);
  const { rows: versions } = await db.query('SELECT version, format, CHAR_LENGTH(content) AS chars, created_at FROM rag_source_content WHERE source_id = $1 ORDER BY version DESC', [id]);
  const { rows: jobs } = await db.query('SELECT * FROM rag_ingestion_jobs WHERE source_id = $1 ORDER BY id DESC LIMIT 10', [id]);
  const { rows: cnt } = await db.query('SELECT COUNT(*) AS n FROM rag_chunks WHERE source_id = $1 AND source_version = $2', [id, src.version]);
  const { rows: latest } = await db.query('SELECT format, content FROM rag_source_content WHERE source_id = $1 ORDER BY version DESC LIMIT 1', [id]);
  return {
    ...shape({ ...src, chunk_count: cnt[0]?.n, latest_version: versions[0]?.version }, jobs[0]),
    content: latest[0]?.content ?? '',
    format: latest[0]?.format ?? 'text',
    versions: versions.map((v) => ({ version: Number(v.version), format: v.format, chars: Number(v.chars), createdAt: v.created_at })),
    jobs: jobs.map((j) => shape(src, j).job),
  };
}

async function chunks(id) {
  const src = await getSource(id);
  const { rows } = await db.query(
    'SELECT id, chunk_index, text, tokens, metadata_json FROM rag_chunks WHERE source_id = $1 AND source_version = $2 ORDER BY chunk_index',
    [id, src.version]
  );
  return rows.map((r) => {
    let m = r.metadata_json;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = {}; } }
    return { id: Number(r.id), index: Number(r.chunk_index), text: r.text, tokens: Number(r.tokens), heading: m?.heading || null };
  });
}

async function jobs({ status, limit = 50 } = {}) {
  await ensureAiTables();
  const params = [];
  let where = '';
  if (status) { params.push(status); where = 'WHERE j.status = $1'; }
  // MySQL 8 rejects a bound LIMIT on its own in prepared statements, so the
  // (clamped) integer is inlined.
  const lim = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  const { rows } = await db.query(
    `SELECT j.*, s.title, s.type FROM rag_ingestion_jobs j LEFT JOIN rag_sources s ON s.id = j.source_id ${where}
     ORDER BY j.id DESC LIMIT ${lim}`,
    params
  );
  return rows.map((j) => {
    let stats = j.stats_json;
    if (typeof stats === 'string') { try { stats = JSON.parse(stats); } catch { stats = null; } }
    return {
      id: Number(j.id), sourceId: Number(j.source_id), title: j.title, type: j.type, version: Number(j.source_version),
      status: j.status, attempts: Number(j.attempts), maxAttempts: Number(j.max_attempts), error: j.error, stats,
      requiredHost: j.required_host, createdAt: j.created_at, startedAt: j.started_at, finishedAt: j.finished_at,
    };
  });
}

async function retryJob(jobId) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM rag_ingestion_jobs WHERE id = $1', [jobId]);
  const job = rows[0];
  if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
  if (job.status !== 'failed' && job.status !== 'cancelled') throw bad('Only failed or cancelled jobs can be retried');
  const newId = await worker.enqueue({ sourceId: Number(job.source_id), version: Number(job.source_version), requiredHost: job.required_host, createdBy: job.created_by });
  return { jobId: newId };
}

module.exports = { createSource, updateSource, reindex, archive, restore, remove, list, detail, chunks, jobs, retryJob, TYPES, FORMATS };
