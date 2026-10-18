/**
 * L2 business instructions: versions, the draft, line diffs and the override
 * guard (Phase 11). Publishing is gated by step-up verification (Phase 12).
 */

const crypto = require('crypto');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');

const MAX_CHARS = 6000;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** v1, seeded on first use (DESIGN.md §3.7: persona, tone, contact details). */
const SEED = `# Who you are
You are the travel assistant of Holidays Seychelles, a tour operator based in Seychelles. You speak like a friendly local travel expert.

# Tone
- Warm, clear and practical. Short sentences. No exaggeration or pressure.
- Use the visitor's name only if they give it.
- Suggest one or two good options rather than long lists.

# What to recommend
- Match the island to the trip: Mahé for variety and the capital, Praslin for beaches and the Vallée de Mai, La Digue for a slow island pace, smaller islands for nature and privacy.
- For couples and honeymoons, mention romantic stays and sunset experiences when relevant.
- When a visitor seems ready to book, invite them to open the live results on the website, or to send a query so the team can tailor the trip.

# Contact
- Visitors can send a query from the website; the team replies by email.
- For changes to an existing booking, ask them to send a query from their dashboard.`;

// Phrases that try to switch the core rules off. A warning, not a block: the
// core rules are placed first and restated last, so they win either way.
const PATTERNS = [
  { re: '\\b(ignore|disregard|forget|override)\\b.{0,40}\\b(rules?|instructions?|above|previous|system)\\b', label: 'Asks to ignore or override rules' },
  { re: '\\byou (are|can) (now )?(no longer|not) (bound|restricted|limited)\\b|\\bno (rules|restrictions|limits)\\b', label: 'Removes restrictions' },
  { re: '\\b(make up|invent|guess|estimate)\\b.{0,30}\\b(prices?|rates?|availability)\\b', label: 'Asks to invent prices or availability' },
  { re: '\\b(reveal|show|print|repeat)\\b.{0,30}\\b(system prompt|instructions|rules)\\b', label: 'Asks to reveal the instructions' },
  { re: '\\b(card number|cvv|password|passport number)s?\\b', label: 'Mentions collecting sensitive details' },
  { re: '\\b(always|only) (answer|reply|respond) in (english|french|german)\\b', label: 'Fixes the reply language (the core rules answer in the visitor’s language)' },
];

function guard(text) {
  return PATTERNS.filter((p) => new RegExp(p.re, 'i').test(text)).map((p) => p.label);
}

function shape(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    version: Number(r.version),
    status: r.status,
    content: r.content,
    hash: r.content_hash,
    note: r.note,
    createdBy: r.created_by ? Number(r.created_by) : null,
    publishedBy: r.published_by ? Number(r.published_by) : null,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

let seeding = null;
async function ensureSeed() {
  await ensureAiTables();
  if (!seeding) {
    seeding = (async () => {
      const { rows } = await db.query("SELECT COUNT(*) AS n FROM rag_prompt_versions WHERE status = 'published'");
      if (Number(rows[0].n) === 0) {
        await db.query(
          "INSERT INTO rag_prompt_versions (version, status, content, content_hash, note, published_at) VALUES (1, 'published', $1, $2, 'Initial version (seeded)', NOW())",
          [SEED, sha(SEED)]
        );
      }
    })().catch((err) => { seeding = null; throw err; });
  }
  return seeding;
}

async function published() {
  await ensureSeed();
  const { rows } = await db.query("SELECT * FROM rag_prompt_versions WHERE status = 'published' ORDER BY version DESC LIMIT 1");
  return shape(rows[0]);
}

async function draft() {
  await ensureSeed();
  const { rows } = await db.query("SELECT * FROM rag_prompt_versions WHERE status = 'draft' ORDER BY id DESC LIMIT 1");
  return shape(rows[0]);
}

async function saveDraft(content, note, adminId) {
  const text = String(content || '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw bad('The instructions cannot be empty');
  if (text.length > MAX_CHARS) throw bad(`Keep the instructions under ${MAX_CHARS} characters`);
  const cur = await draft();
  const live = await published();
  if (!cur && live && text === live.content) throw bad('This is the same as the live version');
  if (cur) {
    await db.query('UPDATE rag_prompt_versions SET content = $1, content_hash = $2, note = $3, created_by = $4 WHERE id = $5', [text, sha(text), note || null, adminId || null, cur.id]);
  } else {
    await db.query("INSERT INTO rag_prompt_versions (version, status, content, content_hash, note, created_by) VALUES (0, 'draft', $1, $2, $3, $4)", [text, sha(text), note || null, adminId || null]);
  }
  return { draft: await draft(), warnings: guard(text) };
}

async function discardDraft() {
  await ensureSeed();
  await db.query("DELETE FROM rag_prompt_versions WHERE status = 'draft'");
}

/** Make the draft the next version. Callers must have checked step-up (Phase 12). */
async function publishDraft(adminId) {
  const d = await draft();
  if (!d) throw bad('There is no draft to publish');
  const live = await published();
  const version = (live?.version || 0) + 1;
  await db.query("UPDATE rag_prompt_versions SET status = 'published', version = $1, published_by = $2, published_at = NOW() WHERE id = $3", [version, adminId || null, d.id]);
  return { before: live, after: await published() };
}

async function versions() {
  await ensureSeed();
  const { rows } = await db.query(
    `SELECT v.*, a.email AS by_email FROM rag_prompt_versions v
       LEFT JOIN admins a ON a.id = COALESCE(v.published_by, v.created_by)
      ORDER BY (v.status = 'draft') DESC, v.version DESC LIMIT 200`
  ).catch(() => db.query("SELECT * FROM rag_prompt_versions ORDER BY (status = 'draft') DESC, version DESC LIMIT 200"));
  return rows.map((r) => ({ ...shape(r), content: undefined, by: r.by_email || null, length: String(r.content).length }));
}

async function byRef(ref) {
  await ensureSeed();
  if (ref === 'draft') return draft();
  const v = Number(ref);
  if (!v) return null;
  const { rows } = await db.query("SELECT * FROM rag_prompt_versions WHERE status = 'published' AND version = $1", [v]);
  return shape(rows[0]);
}

/** Line diff (LCS). → { lines: [{ op: ' '|'+'|'-', text }], added, removed } */
function diffLines(a, b) {
  const x = String(a || '').split('\n');
  const y = String(b || '').split('\n');
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { lines.push({ op: ' ', text: x[i] }); i += 1; j += 1; }
    else if (L[i + 1][j] >= L[i][j + 1]) { lines.push({ op: '-', text: x[i] }); i += 1; }
    else { lines.push({ op: '+', text: y[j] }); j += 1; }
  }
  while (i < n) lines.push({ op: '-', text: x[i++] });
  while (j < m) lines.push({ op: '+', text: y[j++] });
  return { lines, added: lines.filter((l) => l.op === '+').length, removed: lines.filter((l) => l.op === '-').length };
}

module.exports = { published, draft, saveDraft, discardDraft, publishDraft, versions, byRef, diffLines, guard, PATTERNS, MAX_CHARS, SEED, sha };
