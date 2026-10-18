/**
 * Destination Knowledge (DESIGN.md §5): a profile per island or place, edited
 * in sections. The working copy lives in rag_destinations; Publish composes the
 * sections into one markdown document (a 'destination' source) and indexes it.
 * Heading-aware chunking gives roughly one chunk per section, and the embedding
 * cache means a publish only embeds the sections whose text changed.
 *
 * Shared with the live tools (Phase 9): listPublished() / getBySlug().
 */

const crypto = require('crypto');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const sources = require('./sources');
const settingsStore = require('../settings');
const { chunkContent } = require('../ingest/chunk');

/** Section keys, in display (and document) order. `from` maps the website's island page fields. */
const SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'bestTime', label: 'Best time to visit' },
  { key: 'thingsToDo', label: 'Things to do' },
  { key: 'attractions', label: 'Famous attractions' },
  { key: 'transport', label: 'Getting there & around' },
  { key: 'whereToStay', label: 'Where to stay' },
  { key: 'itineraries', label: 'Suggested itineraries' },
  { key: 'food', label: 'Food & dining' },
  { key: 'couples', label: 'For couples & honeymoons' },
  { key: 'comparison', label: 'How it compares' },
  { key: 'tips', label: 'Travel tips' },
  { key: 'faqs', label: 'FAQs' },
  { key: 'relatedPackages', label: 'Related packages' },
];
const KEYS = SECTIONS.map((s) => s.key);
const MAX_SECTION = 20000;

const MAIN_ISLANDS = { mahe: 'Mahé', praslin: 'Praslin', 'la-digue': 'La Digue' };
const OWN_ISLANDS = ['silhouette', 'curieuse', 'aride', 'cousin', 'moyenne', 'bird-island', 'denis', 'fregate', 'north-island', 'felicite'];
const ISLAND_OPTIONS = ['mahe', 'praslin', 'la-digue', ...OWN_ISLANDS, 'outer-islands', 'other'];

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const slugify = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);

/** The island a website page belongs to, from its slug and region text. */
function islandFor(slug, region = '') {
  if (MAIN_ISLANDS[slug] || OWN_ISLANDS.includes(slug)) return slug;
  const r = slugify(region);
  if (r.includes('la-digue')) return 'la-digue';
  if (r.includes('praslin')) return 'praslin';
  if (r.includes('mahe') || r.includes('sainte-anne')) return 'mahe';
  if (r.includes('outer')) return 'outer-islands';
  return 'other';
}

/** Website island page (website_destinations.content) → our sections (markdown). */
function sectionsFromWebsite(c) {
  const lines = (arr) => (arr || []).filter(Boolean).map((t) => `- ${t}`).join('\n');
  const itineraries = [
    c.weekend && `### A weekend\n${c.weekend}`,
    c.threeDays && `### Three days\n${c.threeDays}`,
    c.fourDays && `### Four days\n${c.fourDays}`,
  ].filter(Boolean).join('\n\n');
  return {
    overview: [c.tagline, c.shortDescription, c.longDescription].filter(Boolean).join('\n\n'),
    bestTime: c.bestTime || '',
    thingsToDo: lines(c.thingsToDo),
    attractions: '',
    transport: '',
    whereToStay: (c.whereToStay || []).map((w) => `- **${w.area}** — ${w.description}`).join('\n'),
    itineraries,
    food: c.food || '',
    couples: c.couples || '',
    comparison: c.comparison || '',
    tips: '',
    faqs: (c.faqs || []).map((f) => `**Q: ${f.question}**\nA: ${f.answer}`).join('\n\n'),
    relatedPackages: '',
  };
}

function cleanSections(input = {}) {
  const out = {};
  for (const key of KEYS) {
    if (input[key] === undefined) continue;
    out[key] = String(input[key] ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_SECTION);
  }
  return out;
}

function parseSections(v) {
  if (!v) return {};
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return v;
}

/** The document the assistant indexes: "# Name" then "## Section" per non-empty section. */
function compose(dest) {
  const sections = parseSections(dest.sections_json ?? dest.sections);
  const islandName = MAIN_ISLANDS[dest.island] || '';
  // "Anse Lazio (Praslin)", but not "Mahé Island (Mahé)".
  const header = `# ${dest.name}${islandName && !slugify(dest.name).includes(dest.island) ? ` (${islandName})` : ''}`;
  const parts = SECTIONS.filter((s) => (sections[s.key] || '').trim()).map((s) => `## ${s.label}\n${sections[s.key].trim()}`);
  return parts.length ? `${header}\n\n${parts.join('\n\n')}` : '';
}

async function getRow(id) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM rag_destinations WHERE id = $1', [id]);
  if (!rows[0]) throw Object.assign(new Error('Destination not found'), { status: 404 });
  return rows[0];
}

async function sourceInfo(sourceId) {
  if (!sourceId) return null;
  const { rows } = await db.query(
    `SELECT s.status, s.version, (SELECT COUNT(*) FROM rag_chunks c WHERE c.source_id = s.id AND c.source_version = s.version) AS chunks,
            j.status AS job_status, j.error AS job_error
       FROM rag_sources s LEFT JOIN rag_ingestion_jobs j ON j.id = (SELECT MAX(id) FROM rag_ingestion_jobs WHERE source_id = s.id)
      WHERE s.id = $1`,
    [sourceId]
  );
  return rows[0] || null;
}

function shape(row, src) {
  const sections = parseSections(row.sections_json);
  const composed = compose(row);
  const filled = KEYS.filter((k) => (sections[k] || '').trim()).length;
  let state = 'draft';
  if (src?.status === 'archived') state = 'archived';
  else if (src?.job_status === 'failed') state = 'failed';
  else if (['queued', 'processing'].includes(src?.job_status)) state = 'indexing';
  else if (src?.status === 'published') state = row.published_hash === sha(composed) ? 'published' : 'changed';
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    island: row.island,
    websiteSlug: row.website_slug,
    visibility: row.visibility,
    sourceId: row.source_id ? Number(row.source_id) : null,
    state,
    sectionsFilled: filled,
    sectionsTotal: KEYS.length,
    chunks: Number(src?.chunks || 0),
    jobError: src?.job_status === 'failed' ? src.job_error : null,
    syncedAt: row.synced_at,
    updatedAt: row.updated_at,
  };
}

async function list({ q, state, island } = {}) {
  await ensureAiTables();
  const params = [];
  const where = [];
  if (q) { params.push(`%${q}%`); where.push(`name LIKE $${params.length}`); }
  if (island) { params.push(island); where.push(`island = $${params.length}`); }
  const { rows } = await db.query(`SELECT * FROM rag_destinations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY FIELD(island, 'la-digue', 'praslin', 'mahe') DESC, island, name`, params);
  const out = [];
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    out.push(shape(r, await sourceInfo(r.source_id)));
  }
  return state ? out.filter((d) => d.state === state) : out;
}

async function detail(id) {
  const row = await getRow(id);
  const d = shape(row, await sourceInfo(row.source_id));
  return { ...d, sections: { ...Object.fromEntries(KEYS.map((k) => [k, ''])), ...parseSections(row.sections_json) } };
}

/** Import website island pages that aren't here yet (as drafts). */
async function importFromWebsite(adminId) {
  await ensureAiTables();
  const { rows: web } = await db.query('SELECT slug, name, content FROM website_destinations ORDER BY sort_order');
  const { rows: have } = await db.query('SELECT website_slug, slug FROM rag_destinations');
  const known = new Set(have.flatMap((h) => [h.website_slug, h.slug]).filter(Boolean));
  let imported = 0;
  for (const w of web) {
    if (known.has(w.slug)) continue;
    const c = typeof w.content === 'string' ? JSON.parse(w.content) : w.content || {};
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO rag_destinations (slug, name, island, website_slug, sections_json, synced_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
      [w.slug, w.name, islandFor(w.slug, c.region), w.slug, JSON.stringify(sectionsFromWebsite(c)), adminId || null]
    );
    imported += 1;
  }
  return { imported, skipped: web.length - imported, total: web.length };
}

/** Overwrite the working copy with the website page again (admin edits are replaced). */
async function syncFromWebsite(id, adminId) {
  const row = await getRow(id);
  if (!row.website_slug) throw Object.assign(new Error('This destination is not linked to a website page'), { status: 400 });
  const { rows } = await db.query('SELECT content FROM website_destinations WHERE slug = $1', [row.website_slug]);
  if (!rows[0]) throw Object.assign(new Error('The website page no longer exists'), { status: 404 });
  const c = typeof rows[0].content === 'string' ? JSON.parse(rows[0].content) : rows[0].content;
  await db.query('UPDATE rag_destinations SET sections_json = $1, synced_at = NOW(), updated_by = $2 WHERE id = $3', [JSON.stringify(sectionsFromWebsite(c)), adminId || null, id]);
  return detail(id);
}

async function create({ name, island }, adminId) {
  await ensureAiTables();
  const n = String(name || '').trim().slice(0, 160);
  if (!n) throw Object.assign(new Error('Name is required'), { status: 400 });
  const slug = slugify(n);
  const isl = ISLAND_OPTIONS.includes(island) ? island : islandFor(slug);
  try {
    const r = await db.query('INSERT INTO rag_destinations (slug, name, island, sections_json, updated_by) VALUES ($1, $2, $3, $4, $5)', [slug, n, isl, JSON.stringify({}), adminId || null]);
    return detail(Number(r.insertId));
  } catch (err) {
    if (/Duplicate/i.test(err.message)) throw Object.assign(new Error(`A destination called "${n}" already exists`), { status: 409 });
    throw err;
  }
}

/** Save the working copy (not live until Publish). */
async function update(id, { name, island, visibility, sections }, adminId) {
  const row = await getRow(id);
  const merged = { ...parseSections(row.sections_json), ...cleanSections(sections) };
  const sets = ['sections_json = $1', 'updated_by = $2'];
  const params = [JSON.stringify(merged), adminId || null];
  if (name !== undefined && String(name).trim()) { params.push(String(name).trim().slice(0, 160)); sets.push(`name = $${params.length}`); }
  if (island !== undefined && ISLAND_OPTIONS.includes(island)) { params.push(island); sets.push(`island = $${params.length}`); }
  if (visibility === 'public' || visibility === 'internal') { params.push(visibility); sets.push(`visibility = $${params.length}`); }
  params.push(id);
  await db.query(`UPDATE rag_destinations SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  return detail(id);
}

/** Make the working copy live: create/update its source and queue indexing. */
async function publish(id, adminId) {
  const row = await getRow(id);
  const markdown = compose(row);
  if (!markdown) throw Object.assign(new Error('Add content to at least one section before publishing'), { status: 400 });
  const meta = { title: row.name, destination: row.island, category: 'destination', visibility: row.visibility };
  let result;
  if (row.source_id) {
    const src = await sourceInfo(row.source_id);
    if (src?.status === 'archived') await sources.restore(Number(row.source_id), adminId).catch(() => {});
    result = await sources.updateSource(Number(row.source_id), { ...meta, content: markdown, format: 'markdown' }, adminId);
  } else {
    result = await sources.createSource({ type: 'destination', ...meta, content: markdown, format: 'markdown' }, adminId);
    await db.query('UPDATE rag_destinations SET source_id = $1 WHERE id = $2', [result.sourceId, id]);
  }
  await db.query('UPDATE rag_destinations SET published_hash = $1 WHERE id = $2', [sha(markdown), id]);
  return { ...result, destinationId: Number(id) };
}

async function archive(id) {
  const row = await getRow(id);
  if (!row.source_id) throw Object.assign(new Error('Not published yet'), { status: 400 });
  return sources.archive(Number(row.source_id));
}

async function remove(id) {
  const row = await getRow(id);
  let removed = 0;
  if (row.source_id) removed = (await sources.remove(Number(row.source_id))).removedChunks;
  await db.query('DELETE FROM rag_destinations WHERE id = $1', [id]);
  return { removedChunks: removed };
}

/** What the assistant will see for the working copy: the document and its chunks. */
async function preview(id) {
  const row = await getRow(id);
  const markdown = compose(row);
  const s = await settingsStore.getEffective();
  const chunks = markdown ? chunkContent({ format: 'markdown', content: markdown }, { targetTokens: s.chunkTokens, overlapPct: s.chunkOverlapPct, mergeSmall: false }) : [];
  return { markdown, chunks: chunks.map((c) => ({ index: c.index, tokens: c.tokens, heading: c.heading || null, text: c.text })) };
}

/** For live tools (Phase 9): published destinations only. */
async function listPublished() {
  const all = await list();
  return all.filter((d) => ['published', 'changed', 'indexing'].includes(d.state) && d.visibility === 'public');
}

async function getBySlug(slug) {
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM rag_destinations WHERE slug = $1 OR website_slug = $1 LIMIT 1', [slug]);
  if (!rows[0]) return null;
  return detail(Number(rows[0].id));
}

module.exports = {
  SECTIONS, ISLAND_OPTIONS, MAIN_ISLANDS,
  list, detail, importFromWebsite, syncFromWebsite, create, update, publish, archive, remove, preview,
  listPublished, getBySlug, compose, sectionsFromWebsite, islandFor,
};
