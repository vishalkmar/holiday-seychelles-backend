/**
 * The ingestion job queue and its in-process worker (DESIGN.md §3.3).
 *
 * cPanel can't host Redis/BullMQ, so jobs live in rag_ingestion_jobs and one
 * worker per Node process polls them, one job at a time:
 *
 *   queued → processing → indexed
 *                      ↘ failed (after max_attempts, with the error) ─ retry → queued
 *
 *  - Claiming is atomic (UPDATE … WHERE status='queued'), so two processes on
 *    the same database (live + a developer's machine) never run one job twice.
 *  - Jobs for uploaded files carry required_host: only the machine holding
 *    the file may take them.
 *  - A heartbeat marks progress; a job silent for STUCK_MS (process crashed
 *    mid-job) is put back in the queue. On start-up the worker also resumes
 *    whatever it was running when the process stopped.
 *  - Failed attempts back off: 30 s, 2 min, 8 min…
 */

const os = require('os');
const { db, audit } = require('../ports');
const { ensureAiTables } = require('../db');
const { ingestSourceVersion } = require('./pipeline');

const HOST = os.hostname().slice(0, 120);
const WORKER = `${HOST}:${process.pid}`.slice(0, 160);
const POLL_MS = 3000;
const STUCK_MS = 10 * 60 * 1000;
// Jobs run in parallel lanes: most of a small job's time is database round
// trips (the database is remote), so one-at-a-time leaves the queue crawling.
// Claiming is atomic, so lanes never take the same job. The embedding rate
// limit is shared by all lanes.
const LANES = Math.min(8, Math.max(1, Number.parseInt(process.env.RAG_WORKER_CONCURRENCY, 10) || 4));

let timer = null;
let busy = false;
const currentJobs = new Set();

/** Queue a source version for indexing. Returns the job id. */
async function enqueue({ sourceId, version, requiredHost = null, createdBy = null, maxAttempts = 3 }) {
  await ensureAiTables();
  // A newer request for the same source replaces queued (not yet started) ones.
  await db.query("UPDATE rag_ingestion_jobs SET status = 'cancelled', finished_at = NOW() WHERE source_id = $1 AND status = 'queued'", [sourceId]);
  const r = await db.query(
    `INSERT INTO rag_ingestion_jobs (source_id, source_version, status, max_attempts, required_host, created_by)
     VALUES ($1, $2, 'queued', $3, $4, $5)`,
    [sourceId, version, maxAttempts, requiredHost, createdBy]
  );
  kick();
  return r.insertId || r.rows?.insertId || null;
}

async function claimNext(tries = 5) {
  const { rows } = await db.query(
    `SELECT id FROM rag_ingestion_jobs
      WHERE status = 'queued' AND next_run_at <= NOW() AND (required_host IS NULL OR required_host = $1)
      ORDER BY next_run_at, id LIMIT 1`,
    [HOST]
  );
  if (!rows[0]) return null;
  const id = Number(rows[0].id);
  const upd = await db.query(
    `UPDATE rag_ingestion_jobs SET status = 'processing', worker = $1, attempts = attempts + 1,
       started_at = NOW(), heartbeat_at = NOW(), error = NULL
     WHERE id = $2 AND status = 'queued'`,
    [WORKER, id]
  );
  if (!upd.rowCount) return tries > 1 ? claimNext(tries - 1) : null; // another lane or process took it
  const { rows: job } = await db.query('SELECT * FROM rag_ingestion_jobs WHERE id = $1', [id]);
  return job[0];
}

async function heartbeat(jobId, stage) {
  await db.query(
    `UPDATE rag_ingestion_jobs SET heartbeat_at = NOW(),
       stats_json = JSON_SET(COALESCE(stats_json, JSON_OBJECT()), '$.stage', $1)
     WHERE id = $2`,
    [stage, jobId]
  ).catch(() => {});
}

async function setSourceStatus(sourceId, status) {
  await db.query('UPDATE rag_sources SET status = $1 WHERE id = $2', [status, sourceId]).catch(() => {});
}

async function runJob(job) {
  currentJobs.add(Number(job.id));
  const sourceId = Number(job.source_id);
  const version = Number(job.source_version);
  try {
    const { rows } = await db.query('SELECT status FROM rag_sources WHERE id = $1', [sourceId]);
    const firstIndex = rows[0] && rows[0].status !== 'published';
    if (firstIndex) await setSourceStatus(sourceId, 'processing');
    const stats = await ingestSourceVersion({ sourceId, version, onProgress: (stage) => heartbeat(job.id, stage) });
    await db.query(
      "UPDATE rag_ingestion_jobs SET status = 'indexed', finished_at = NOW(), stats_json = $1 WHERE id = $2",
      [JSON.stringify({ ...stats, stage: 'done' }), job.id]
    );
    await setSourceStatus(sourceId, 'published');
    await audit({
      adminId: job.created_by ? Number(job.created_by) : null,
      action: 'rag.source.indexed',
      entityType: 'rag_source',
      entityId: sourceId,
      summary: `Indexed v${version}: ${stats.chunks} chunks (${stats.embedded} embedded, ${stats.reused} reused)`,
      metadata: stats,
    });
  } catch (err) {
    const permanent = Boolean(err.permanent) || ['MIXED_EMBEDDINGS', 'AUTH', 'NOT_CONFIGURED'].includes(err.code);
    const attempts = Number(job.attempts);
    const giveUp = permanent || attempts >= Number(job.max_attempts);
    const backoffSec = 30 * 4 ** Math.max(0, attempts - 1);
    await db.query(
      `UPDATE rag_ingestion_jobs SET status = $1, error = $2, finished_at = ${giveUp ? 'NOW()' : 'NULL'},
         next_run_at = DATE_ADD(NOW(), INTERVAL $3 SECOND)
       WHERE id = $4`,
      [giveUp ? 'failed' : 'queued', String(err.message || err).slice(0, 2000), giveUp ? 0 : backoffSec, job.id]
    );
    if (giveUp) {
      // A source that was never indexed shows as failed; a live one keeps its old version.
      const { rows } = await db.query('SELECT status FROM rag_sources WHERE id = $1', [sourceId]);
      if (rows[0] && rows[0].status === 'processing') await setSourceStatus(sourceId, 'failed');
      await audit({
        adminId: job.created_by ? Number(job.created_by) : null,
        action: 'rag.source.index_failed',
        entityType: 'rag_source',
        entityId: sourceId,
        status: 'failure',
        summary: `Indexing v${version} failed: ${String(err.message).slice(0, 300)}`,
      });
    }
  } finally {
    currentJobs.delete(Number(job.id));
  }
}

/** Put back jobs whose worker went silent (crash, restart, deploy). */
async function recoverStuck() {
  await db.query(
    `UPDATE rag_ingestion_jobs SET status = 'queued', next_run_at = NOW(), error = 'Resumed after the worker stopped'
      WHERE status = 'processing' AND (worker = $1 OR heartbeat_at < (NOW() - INTERVAL $2 SECOND))`,
    [WORKER, Math.round(STUCK_MS / 1000)]
  );
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await ensureAiTables();
    await recoverStuck();
    const lane = async () => {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const job = await claimNext();
        if (!job) return;
        // eslint-disable-next-line no-await-in-loop
        await runJob(job);
      }
    };
    await Promise.all(Array.from({ length: LANES }, lane));
  } catch (err) {
    console.error('[ai] ingestion worker:', err.message);
  } finally {
    busy = false;
  }
}

/** Run soon instead of waiting for the next poll (after enqueue). */
function kick() {
  if (timer) setImmediate(tick);
}

function start() {
  if (timer || process.env.RAG_WORKER_ENABLED === 'false') return;
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  setImmediate(tick);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  const [first = null] = currentJobs;
  return { running: Boolean(timer), busy, host: HOST, worker: WORKER, lanes: LANES, currentJob: first, currentJobs: [...currentJobs] };
}

module.exports = { enqueue, start, stop, tick, status, HOST };
