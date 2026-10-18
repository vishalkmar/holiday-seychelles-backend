/**
 * Document Training Center: uploaded files (PDF, Word, Excel, CSV, Text).
 *
 * Upload stores the file privately and queues it; the worker parses it into
 * text (rag_source_content) and indexes it like any other source. Parsing in
 * the worker, not the request, keeps a 20 MB PDF from timing out the upload.
 *
 * Files live on one machine's disk, so their jobs carry required_host and
 * only that machine's worker processes them (see ingest/worker.js).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { config } = require('../config');
const { ensureStorage } = require('../storage');
const { detect, parse, KINDS, kindFromMime } = require('../ingest/parsers');
const worker = require('../ingest/worker');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function safeName(name) {
  const base = path.basename(String(name || 'document')).replace(/[^\w.\- ()]+/g, '_').trim();
  return (base || 'document').slice(0, 200);
}

function storeFile(buffer, ext) {
  const now = new Date();
  const rel = path.posix.join(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), `${crypto.randomUUID()}.${ext}`);
  const full = path.join(ensureStorage(), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer, { flag: 'wx' });
  return rel;
}

/** Absolute path of a stored file, refusing anything that escapes the storage folder. */
function resolveStored(rel) {
  const root = path.resolve(config.storageDir);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw bad('Invalid storage path');
  return full;
}

function checkUpload(file, expectedKind) {
  if (!file?.buffer?.length) throw bad('Choose a file to upload');
  const detected = detect(file.buffer, file.originalname);
  if (expectedKind && expectedKind !== detected.kind) {
    throw bad(`This is a ${KINDS[detected.kind].label} file — upload it in the ${KINDS[detected.kind].label} tab.`);
  }
  return detected;
}

async function findDuplicate(hash) {
  const { rows } = await db.query(
    `SELECT s.id, s.title, s.status FROM rag_documents d JOIN rag_sources s ON s.id = d.source_id
      WHERE d.sha256 = $1 ORDER BY d.id DESC LIMIT 1`,
    [hash]
  );
  return rows[0] || null;
}

/** meta: { title?, destination?, category?, language?, visibility?, kind? } */
async function upload(file, meta, adminId) {
  await ensureAiTables();
  const detected = checkUpload(file, meta.kind);
  const hash = sha(file.buffer);
  const dup = await findDuplicate(hash);
  if (dup) throw bad(`This file is already uploaded as “${dup.title}” (${dup.status}).`, 409);

  const fileName = safeName(file.originalname);
  const title = String(meta.title || fileName.replace(/\.[^.]+$/, '')).trim().slice(0, 255);
  const visibility = meta.visibility === 'internal' ? 'internal' : 'public';
  const rel = storeFile(file.buffer, detected.ext);
  try {
    const r = await db.query(
      `INSERT INTO rag_sources (type, title, status, destination, category, language, visibility, version, created_by)
       VALUES ('document', $1, 'draft', $2, $3, $4, $5, 0, $6)`,
      [title, String(meta.destination || '').trim().toLowerCase().slice(0, 80) || null, String(meta.category || '').trim().slice(0, 80) || null, String(meta.language || 'en').slice(0, 10), visibility, adminId || null]
    );
    const sourceId = Number(r.insertId);
    await db.query(
      `INSERT INTO rag_documents (source_id, version, file_name, mime, size_bytes, sha256, storage_path, storage_host, created_by)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
      [sourceId, fileName, detected.mime, file.buffer.length, hash, rel, worker.HOST, adminId || null]
    );
    const jobId = await worker.enqueue({ sourceId, version: 1, requiredHost: worker.HOST, createdBy: adminId });
    return { sourceId, version: 1, jobId, kind: detected.kind, fileName };
  } catch (err) {
    fs.rmSync(resolveStored(rel), { force: true });
    throw err;
  }
}

/** A new file for an existing document → next version (old version stays live until indexed). */
async function replace(sourceId, file, adminId) {
  await ensureAiTables();
  const { rows } = await db.query("SELECT * FROM rag_sources WHERE id = $1 AND type = 'document'", [sourceId]);
  const src = rows[0];
  if (!src) throw bad('Document not found', 404);
  if (src.status === 'archived') throw bad('Restore the document before replacing its file');
  const { rows: cur } = await db.query('SELECT mime FROM rag_documents WHERE source_id = $1 ORDER BY version DESC LIMIT 1', [sourceId]);
  const detected = checkUpload(file, cur[0] ? kindFromMime(cur[0].mime) : undefined);
  const hash = sha(file.buffer);
  const { rows: same } = await db.query('SELECT 1 FROM rag_documents WHERE source_id = $1 AND sha256 = $2 LIMIT 1', [sourceId, hash]);
  if (same.length) throw bad('That is the same file as the current one.', 409);
  const { rows: v } = await db.query(
    `SELECT GREATEST(COALESCE((SELECT MAX(version) FROM rag_documents WHERE source_id = $1), 0),
                     COALESCE((SELECT MAX(version) FROM rag_source_content WHERE source_id = $1), 0)) AS v`,
    [sourceId]
  );
  const version = Number(v[0].v) + 1;
  const rel = storeFile(file.buffer, detected.ext);
  await db.query(
    `INSERT INTO rag_documents (source_id, version, file_name, mime, size_bytes, sha256, storage_path, storage_host, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [sourceId, version, safeName(file.originalname), detected.mime, file.buffer.length, hash, rel, worker.HOST, adminId || null]
  );
  const jobId = await worker.enqueue({ sourceId: Number(sourceId), version, requiredHost: worker.HOST, createdBy: adminId });
  return { sourceId: Number(sourceId), version, jobId };
}

/**
 * Called by the pipeline when a version has a file but no parsed text yet:
 * parse the file and store the text. Returns { format, content } or throws.
 */
async function parseStoredVersion(sourceId, version) {
  const { rows } = await db.query('SELECT * FROM rag_documents WHERE source_id = $1 AND version = $2', [sourceId, version]);
  const doc = rows[0];
  if (!doc) return null;
  const full = resolveStored(doc.storage_path);
  if (!fs.existsSync(full)) {
    throw Object.assign(new Error(`The uploaded file is not on this server (${doc.storage_host || 'unknown host'}). Upload it again here.`), { permanent: true });
  }
  const parsed = await parse(fs.readFileSync(full), kindFromMime(doc.mime), { fileName: doc.file_name });
  await db.query('UPDATE rag_documents SET pages = $1, ocr_needed = $2 WHERE id = $3', [parsed.pages ?? null, Boolean(parsed.ocrNeeded), doc.id]);
  if (parsed.ocrNeeded && !String(parsed.content || '').trim()) {
    throw Object.assign(new Error('This looks like a scanned PDF (images, no text). OCR is not supported yet — upload a text PDF or the Word original.'), { permanent: true });
  }
  await db.query(
    `INSERT INTO rag_source_content (source_id, version, format, content, created_by) VALUES ($1, $2, $3, $4, $5)
     ON DUPLICATE KEY UPDATE format = VALUES(format), content = VALUES(content)`,
    [sourceId, version, parsed.format, parsed.content, doc.created_by]
  );
  return { format: parsed.format, content: parsed.content };
}

async function list({ kind, status, q } = {}) {
  await ensureAiTables();
  const where = ["s.type = 'document'"];
  const params = [];
  if (kind && KINDS[kind]) { params.push(KINDS[kind].mime); where.push(`d.mime = $${params.length}`); }
  if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(s.title LIKE $${params.length} OR d.file_name LIKE $${params.length})`); }
  const { rows } = await db.query(
    `SELECT s.id, s.title, s.status, s.destination, s.category, s.language, s.visibility, s.version AS live_version, s.updated_at,
            d.version AS file_version, d.file_name, d.mime, d.size_bytes, d.pages, d.ocr_needed, d.storage_host, d.created_at AS uploaded_at,
            (SELECT COUNT(*) FROM rag_chunks c WHERE c.source_id = s.id AND c.source_version = s.version) AS chunk_count,
            j.id AS job_id, j.status AS job_status, j.error AS job_error, j.attempts AS job_attempts, j.stats_json AS job_stats
       FROM rag_sources s
       JOIN rag_documents d ON d.source_id = s.id AND d.version = (SELECT MAX(version) FROM rag_documents WHERE source_id = s.id)
       LEFT JOIN rag_ingestion_jobs j ON j.id = (SELECT MAX(id) FROM rag_ingestion_jobs WHERE source_id = s.id)
      WHERE ${where.join(' AND ')}
      ORDER BY s.updated_at DESC LIMIT 500`,
    params
  );
  return rows.map((r) => {
    let stats = r.job_stats;
    if (typeof stats === 'string') { try { stats = JSON.parse(stats); } catch { stats = null; } }
    return {
      id: Number(r.id),
      title: r.title,
      status: r.status,
      kind: kindFromMime(r.mime),
      fileName: r.file_name,
      sizeBytes: Number(r.size_bytes),
      pages: r.pages === null ? null : Number(r.pages),
      ocrNeeded: Boolean(r.ocr_needed),
      fileVersion: Number(r.file_version),
      liveVersion: Number(r.live_version),
      destination: r.destination,
      category: r.category,
      language: r.language,
      visibility: r.visibility,
      chunks: Number(r.chunk_count || 0),
      onThisServer: !r.storage_host || r.storage_host === worker.HOST,
      uploadedAt: r.uploaded_at,
      updatedAt: r.updated_at,
      job: r.job_id ? { id: Number(r.job_id), status: r.job_status, error: r.job_error, attempts: Number(r.job_attempts), stats } : null,
    };
  });
}

async function fileFor(sourceId, version) {
  const params = [sourceId];
  let sql = 'SELECT * FROM rag_documents WHERE source_id = $1';
  if (version) { params.push(version); sql += ' AND version = $2'; }
  const { rows } = await db.query(`${sql} ORDER BY version DESC LIMIT 1`, params);
  const doc = rows[0];
  if (!doc) throw bad('File not found', 404);
  const full = resolveStored(doc.storage_path);
  if (!fs.existsSync(full)) throw bad(`The file is stored on another server (${doc.storage_host || 'unknown'}).`, 404);
  return { full, fileName: doc.file_name, mime: doc.mime };
}

/** Delete stored files after their source was removed (only those on this machine). */
function removeFiles(files = []) {
  let removed = 0;
  for (const f of files) {
    if (f.storage_host && f.storage_host !== worker.HOST) continue;
    try {
      fs.rmSync(resolveStored(f.storage_path), { force: true });
      removed += 1;
    } catch { /* already gone */ }
  }
  return removed;
}

module.exports = { upload, replace, parseStoredVersion, list, fileFor, removeFiles, KINDS };
