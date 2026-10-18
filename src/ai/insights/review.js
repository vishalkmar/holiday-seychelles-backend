/**
 * Knowledge review jobs (Phase 19):
 *
 *  - Unanswered questions: visitor questions the assistant could not answer
 *    (nothing relevant in the knowledge, or a canned fallback), grouped by
 *    meaning into FAQ suggestions. A suggestion becomes a DRAFT FAQ only when
 *    an admin writes the answer; nothing is published automatically.
 *  - Knowledge conflicts: published chunks that say nearly the same thing but
 *    with different numbers for the same unit (minutes, km, islands…) or
 *    different dates — flagged for a person to check.
 */

const crypto = require('crypto');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const faqs = require('../knowledge/faqs');
const retriever = require('../retrieve');
const { cosine, fromBuffer } = require('../vector/math');
const { mask } = require('../memory/pii');
const { normalizeQuestion } = require('./analytics');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const j = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : v ?? d; } catch { return d; } };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const CLUSTER_AT = 0.82; // same meaning
const NOT_ANSWERED = /\b(i don.?t have (that|this|any|specific)? ?information|not (in|included in) the information|can.?t answer properly|connect you with (our|the) team)\b/i;

/** Did this turn fail to answer? (pure: trace row → boolean) */
function unanswered(row) {
  if (row.route === 'flow' || row.route === 'smalltalk' || row.route === 'handoff' || row.route === 'out_of_scope') return false;
  if (row.fallback) return true;
  const trace = j(row.trace_json, {});
  if (trace.retrieval?.insufficient) return true;
  const reply = j(row.reply_json, {});
  return NOT_ANSWERED.test(String(reply.text || ''));
}

/**
 * Greedy clustering on unit vectors: most-asked first, each question joins the
 * first cluster whose seed it matches. items: [{ text, count, vector }] → clusters.
 */
function cluster(items, threshold = CLUSTER_AT) {
  const out = [];
  for (const it of [...items].sort((a, b) => b.count - a.count)) {
    const home = out.find((c) => cosine(c.seed, it.vector) >= threshold);
    if (home) {
      home.hits += it.count;
      if (home.samples.length < 8) home.samples.push(it.text);
    } else out.push({ seed: it.vector, question: it.text, hits: it.count, samples: [it.text] });
  }
  return out;
}

/** Scan the last `days` of visitor turns and refresh the suggestions. */
async function refreshSuggestions({ days = 30 } = {}, deps = {}) {
  await ensureAiTables();
  const d = Math.min(180, Math.max(1, Number.parseInt(days, 10) || 30));
  const { rows } = await db.query(`SELECT route, message, reply_json, trace_json, fallback FROM rag_traces WHERE audience = 'public' AND created_at >= (NOW() - INTERVAL ${d} DAY) ORDER BY id DESC LIMIT 3000`);
  const byNorm = new Map();
  for (const r of rows) {
    if (!unanswered(r)) continue;
    const text = mask(String(r.message || '')).trim().slice(0, 300);
    const n = normalizeQuestion(text);
    // A question has words: "2026-11-10 to 2026-11-13" or "2 adults" is an answer to one.
    if (n.length < 6 || (n.match(/\p{L}{3,}/gu) || []).length < 2) continue;
    const e = byNorm.get(n) || { text, count: 0 };
    e.count += 1;
    byNorm.set(n, e);
  }
  const list = [...byNorm.values()].sort((a, b) => b.count - a.count).slice(0, 150);
  if (!list.length) return { scanned: rows.length, unanswered: 0, suggestions: 0 };
  const vecs = await faqs.questionVectors(list.map((x) => x.text));
  const items = [];
  let covered = 0;
  for (const x of list) {
    const v = vecs.get(faqs.normalize(x.text));
    if (!v) continue;
    // Would the assistant answer it now (knowledge added since)? Asked the
    // same way the assistant asks: the retriever, with its own threshold.
    // eslint-disable-next-line no-await-in-loop
    const now = await (deps.retriever || retriever).retrieve(x.text, { audience: 'public' }).catch(() => null);
    if (now && !now.insufficient) { covered += 1; continue; }
    items.push({ ...x, vector: v });
  }
  const clusters = cluster(items);
  // Open suggestions are rebuilt each time (one answered since disappears);
  // drafted and dismissed ones keep their status — the upsert leaves it alone.
  await db.query("DELETE FROM rag_faq_suggestions WHERE status = 'open'");
  for (const c of clusters) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO rag_faq_suggestions (cluster_key, question, samples_json, hits, last_seen_at) VALUES ($1, $2, $3, $4, NOW())
       ON DUPLICATE KEY UPDATE samples_json = VALUES(samples_json), hits = VALUES(hits), last_seen_at = NOW()`,
      [sha(faqs.normalize(c.question)), c.question.slice(0, 500), JSON.stringify(c.samples), c.hits]
    );
  }
  return { scanned: rows.length, unanswered: list.length, alreadyCovered: covered, suggestions: clusters.length };
}

async function listSuggestions({ status = 'open' } = {}) {
  await ensureAiTables();
  const st = ['open', 'drafted', 'dismissed'].includes(status) ? status : 'open';
  const { rows } = await db.query(`SELECT * FROM rag_faq_suggestions WHERE status = $1 ORDER BY hits DESC, id DESC LIMIT 200`, [st]);
  return rows.map((r) => ({ id: Number(r.id), question: r.question, samples: j(r.samples_json, []), hits: r.hits, status: r.status, faqId: r.faq_id ? Number(r.faq_id) : null, lastSeenAt: r.last_seen_at }));
}

/** The admin's answer turns a suggestion into a draft FAQ (never published here). */
async function draftFromSuggestion(id, { question, answer, category } = {}, adminId) {
  const { rows } = await db.query('SELECT * FROM rag_faq_suggestions WHERE id = $1', [id]);
  if (!rows[0]) throw bad('Suggestion not found', 404);
  const s = rows[0];
  const q = String(question || s.question).trim();
  const variations = j(s.samples_json, []).filter((x) => faqs.normalize(x) !== faqs.normalize(q));
  const faq = await faqs.create({ question: q, answer, variations, category: category || null, tags: ['from-unanswered'] }, adminId);
  await db.query("UPDATE rag_faq_suggestions SET status = 'drafted', faq_id = $1 WHERE id = $2", [faq.id, id]);
  return { faqId: faq.id };
}

async function dismissSuggestion(id) {
  await db.query("UPDATE rag_faq_suggestions SET status = 'dismissed' WHERE id = $1", [id]);
  return { ok: true };
}

// ── Conflicts ─────────────────────────────────────────────────────────────────

const UNITS = {
  minutes: /^(minutes?|mins?)$/, hours: /^(hours?|hrs?|h)$/, days: /^days?$/, nights: /^nights?$/, km: /^(km|kilometres?|kilometers?)$/,
  m: /^(m|metres?|meters?)$/, islands: /^islands?$/, percent: /^(%|percent)$/, degrees: /^(°c|°|degrees?)$/, people: /^(people|persons?|residents|inhabitants)$/,
  kg: /^(kg|kilos?|kilograms?)$/, years: /^years?$/,
};
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

/** "about 15 minutes", "1,500 km", "UTC+4" → { minutes: Set(['15']), km: Set(['1500']) }. Pure. */
function factsIn(text) {
  const out = {};
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/(\d{1,3}(?:[,\s]\d{3})+|\d+(?:\.\d+)?)\s*(%|°c|°|[a-z]+)/g)) {
    const unit = Object.keys(UNITS).find((u) => UNITS[u].test(m[2]));
    if (!unit) continue;
    (out[unit] = out[unit] || new Set()).add(m[1].replace(/[,\s]/g, ''));
  }
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\b|\\b(${MONTHS})\\s+(\\d{1,2})\\b`, 'g'))) {
    (out.date = out.date || new Set()).add(`${(m[2] || m[3]).slice(0, 3)} ${m[1] || m[4]}`);
  }
  return out;
}

/** Same unit in both, no value in common → a conflict. Pure. */
function contradictions(a, b) {
  const fa = factsIn(a);
  const fb = factsIn(b);
  const found = [];
  for (const unit of Object.keys(fa)) {
    if (!fb[unit]) continue;
    const shared = [...fa[unit]].some((v) => fb[unit].has(v));
    if (!shared) found.push({ unit, a: [...fa[unit]], b: [...fb[unit]] });
  }
  return found;
}

/** Compare every pair of published chunks that contain numbers. */
async function scanConflicts({ threshold = 0.82 } = {}) {
  await ensureAiTables();
  const { rows } = await db.query(
    `SELECT c.id, c.source_id, c.text, c.embedding, s.title, s.type
       FROM rag_chunks c JOIN rag_sources s ON s.id = c.source_id AND s.version = c.source_version
      WHERE s.status = 'published' AND c.embedding IS NOT NULL AND c.text REGEXP '[0-9]'
      LIMIT 3000`
  );
  const items = rows.map((r) => ({ id: Number(r.id), sourceId: Number(r.source_id), title: r.title, type: r.type, text: r.text, vector: fromBuffer(r.embedding) })).filter((x) => x.vector?.length);
  let flagged = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let k = i + 1; k < items.length; k += 1) {
      const a = items[i];
      const b = items[k];
      if (a.sourceId === b.sourceId || a.vector.length !== b.vector.length) continue;
      const score = cosine(a.vector, b.vector);
      if (score < threshold) continue;
      const diff = contradictions(a.text, b.text);
      if (!diff.length) continue;
      flagged += 1;
      const key = sha(`${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`);
      const detail = { a: { chunkId: a.id, sourceId: a.sourceId, title: a.title, type: a.type, text: a.text.slice(0, 600) }, b: { chunkId: b.id, sourceId: b.sourceId, title: b.title, type: b.type, text: b.text.slice(0, 600) }, differences: diff };
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `INSERT INTO rag_conflicts (pair_key, chunk_a, chunk_b, score, detail_json) VALUES ($1, $2, $3, $4, $5)
         ON DUPLICATE KEY UPDATE score = VALUES(score), detail_json = VALUES(detail_json)`,
        [key, a.id, b.id, score.toFixed(3), JSON.stringify(detail)]
      );
    }
  }
  return { chunks: items.length, flagged };
}

async function listConflicts({ status = 'open' } = {}) {
  await ensureAiTables();
  const st = ['open', 'resolved', 'dismissed'].includes(status) ? status : 'open';
  const { rows } = await db.query('SELECT * FROM rag_conflicts WHERE status = $1 ORDER BY score DESC LIMIT 200', [st]);
  return rows.map((r) => ({ id: Number(r.id), score: Number(r.score), status: r.status, ...j(r.detail_json, {}), updatedAt: r.updated_at }));
}

async function setConflict(id, status) {
  if (!['open', 'resolved', 'dismissed'].includes(status)) throw bad('Unknown status');
  await db.query('UPDATE rag_conflicts SET status = $1 WHERE id = $2', [status, id]);
  return { ok: true };
}

module.exports = { refreshSuggestions, listSuggestions, draftFromSuggestion, dismissSuggestion, scanConflicts, listConflicts, setConflict, unanswered, cluster, factsIn, contradictions };
