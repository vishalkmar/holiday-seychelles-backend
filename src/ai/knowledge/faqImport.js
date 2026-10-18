/**
 * Bulk FAQ import from CSV / Excel or a Q&A text file (textQa.js), in three steps the admin sees:
 *
 *   preview(file)               → importId, sheets, columns, sample rows, suggested mapping
 *   check(importId, mapping)    → every row: ok | error | duplicate | similar, with reasons
 *   commit(importId, mapping, { publish, include }) → creates the FAQs
 *
 * The parsed rows are kept in rag_faq_imports (not memory) between steps so
 * it works with several Node processes; rows older than a day are purged.
 * Duplicate checks run in memory against every existing phrasing and every
 * earlier row of the same file. Question embeddings are embedded in batches and
 * cached (database + memory), so re-checking or committing costs no model calls.
 */

const crypto = require('crypto');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { detect, parse } = require('../ingest/parsers');
const faqs = require('./faqs');
const { parseTextQa } = require('./textQa');
const { cosine } = require('../vector/math');

const MAX_ROWS = 5000;
const FIELDS = ['question', 'answer', 'variations', 'category', 'tags', 'destination', 'language', 'visibility'];
const GUESS = {
  question: /^(q|question|questions|faq|query|ask)$|question/i,
  answer: /^(a|answer|answers|response|reply)$|answer/i,
  variations: /variation|alternative|other.*(question|way)|synonym|paraphrase|also asked/i,
  category: /categor|topic|section|group/i,
  tags: /tag|keyword/i,
  destination: /destination|island|place|location/i,
  language: /^lang|language/i,
  visibility: /visib|internal|public/i,
};

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

async function purgeOld() {
  await db.query('DELETE FROM rag_faq_imports WHERE created_at < (NOW() - INTERVAL 1 DAY)').catch(() => {});
}

function suggestMapping(columns) {
  const used = new Set();
  const m = {};
  for (const field of FIELDS) {
    const idx = columns.findIndex((c, i) => !used.has(i) && GUESS[field].test(String(c || '')));
    if (idx >= 0) { m[field] = idx; used.add(idx); }
  }
  // Two unnamed columns: assume question, answer.
  if (m.question === undefined && columns.length >= 2) m.question = 0;
  if (m.answer === undefined && columns.length >= 2) m.answer = m.question === 0 ? 1 : 0;
  return m;
}

async function preview(file, adminId) {
  await ensureAiTables();
  await purgeOld();
  if (!file?.buffer?.length) throw bad('Choose a text, CSV or Excel file');
  const d = detect(file.buffer, file.originalname);
  if (!['csv', 'excel', 'text'].includes(d.kind)) throw bad('Import needs a text (.txt), CSV or Excel (.xlsx) file. Download the template to see the layout.');
  let sheets;
  if (d.kind === 'text') {
    // Q:/A: text: the same sheet shape as a spreadsheet with fixed columns.
    const rows = parseTextQa(file.buffer.toString('utf8')).slice(0, MAX_ROWS);
    if (!rows.length) throw bad('No questions found. Write each one as “Q: …” followed by “A: …” (see the example).');
    sheets = [{ name: 'Questions', header: ['question', 'answer', 'variations', 'category'], rows }];
  } else {
    const parsed = await parse(file.buffer, d.kind, { fileName: file.originalname });
    sheets = JSON.parse(parsed.content).sheets
      .map((s) => ({ name: s.name, header: (s.rows[0] || []).map((h) => String(h ?? '').trim()), rows: s.rows.slice(1, MAX_ROWS + 1) }))
      .filter((s) => s.header.length && s.rows.length);
  }
  if (!sheets.length) throw bad('No rows found under a header row');
  const id = crypto.randomUUID();
  await db.query('INSERT INTO rag_faq_imports (id, file_name, rows_json, created_by) VALUES ($1, $2, $3, $4)', [id, String(file.originalname || 'import').slice(0, 255), JSON.stringify(sheets), adminId || null]);
  return {
    importId: id,
    kind: d.kind === 'text' ? 'text' : 'table',
    fileName: file.originalname,
    sheets: sheets.map((s, i) => ({ index: i, name: s.name, columns: s.header, total: s.rows.length, sample: s.rows.slice(0, 5) })),
    suggestedMapping: { sheet: 0, ...suggestMapping(sheets[0].header) },
    fields: FIELDS,
  };
}

/**
 * Pasted text (Extra track 2.2): the same Q:/A: format as a text file, any
 * length up to MAX_ROWS questions, without making a file first.
 */
async function previewText(text, adminId) {
  const t = String(text || '');
  if (!t.trim()) throw bad('Paste some questions and answers first');
  if (t.length > 5 * 1024 * 1024) throw bad('That is more than 5 MB of text — split it into two pastes.');
  return preview({ buffer: Buffer.from(t, 'utf8'), originalname: 'pasted-questions.txt' }, adminId);
}

async function loadImport(importId) {
  const { rows } = await db.query('SELECT * FROM rag_faq_imports WHERE id = $1', [importId]);
  if (!rows[0]) throw bad('This import has expired — upload the file again', 404);
  return { fileName: rows[0].file_name, sheets: JSON.parse(rows[0].rows_json) };
}

/** mapping: { sheet, question: colIdx, answer: colIdx, variations?, …, defaults?: { category, destination, … } } */
function rowsFor(imp, mapping) {
  const sheet = imp.sheets[Number(mapping.sheet) || 0];
  if (!sheet) throw bad('Unknown sheet');
  if (mapping.question === undefined || mapping.answer === undefined || mapping.question === null || mapping.answer === null) {
    throw bad('Choose the question and answer columns');
  }
  const col = (row, field) => {
    const i = mapping[field];
    return i === undefined || i === null || i === '' ? undefined : row[Number(i)];
  };
  const defaults = mapping.defaults || {};
  return sheet.rows.map((row, i) => {
    const input = { rowNumber: i + 2 }; // +1 header, +1 for 1-based like the spreadsheet
    for (const f of FIELDS) {
      const v = col(row, f);
      input[f] = v !== undefined && String(v).trim() !== '' ? v : defaults[f];
    }
    return input;
  });
}

async function check(importId, mapping) {
  await ensureAiTables();
  const imp = await loadImport(importId);
  const inputs = rowsFor(imp, mapping);

  const items = inputs.map((input) => {
    const item = { row: input.rowNumber, status: 'ok', messages: [], match: null, data: null };
    if (!String(input.question || '').trim() && !String(input.answer || '').trim()) {
      item.status = 'skip';
      item.messages.push('Empty row');
      return item;
    }
    try {
      item.data = faqs.cleanInput({ ...input, variations: input.variations ?? [] });
    } catch (err) {
      item.status = 'error';
      item.messages.push(err.message);
    }
    return item;
  });

  const valid = items.filter((it) => it.data);
  // Each row's main question is compared (against every existing phrasing and
  // earlier rows); its variations are embedded after the commit, in the background.
  const vecs = await faqs.questionVectors(valid.map((it) => it.data.question));
  const existing = await faqs.existingPhrasings();
  const seen = []; // earlier rows of this file: { row, norm, vector, question }

  for (const it of valid) {
    const norm = faqs.normalize(it.data.question);
    const vector = vecs.get(norm);
    const hit = faqs.matchAgainst(norm, vector, existing, { k: 1 })[0];
    if (hit) {
      it.status = hit.kind; // duplicate | similar
      it.match = { ...hit, where: 'existing' };
      it.messages.push(`${hit.kind === 'duplicate' ? 'Already exists' : 'Similar to an existing question'} (${hit.reason.toLowerCase()}, ${hit.score}): “${hit.question}”`);
    } else {
      let best = null;
      for (const prev of seen) {
        const score = prev.norm === norm ? 1 : cosine(vector, prev.vector);
        if (score >= faqs.SIMILAR_AT && (!best || score > best.score)) best = { ...prev, score };
      }
      if (best) {
        it.status = best.score >= faqs.DUPLICATE_AT ? 'duplicate' : 'similar';
        it.match = { row: best.row, question: best.question, score: Number(best.score.toFixed(3)), where: 'file' };
        it.messages.push(`${it.status === 'duplicate' ? 'Repeats' : 'Similar to'} row ${best.row} (${best.score.toFixed(2)}): “${best.question}”`);
      }
    }
    seen.push({ row: it.row, norm, vector, question: it.data.question });
  }

  const summary = items.reduce((m, it) => ((m[it.status] = (m[it.status] || 0) + 1), m), { total: items.length });
  return { fileName: imp.fileName, summary, rows: items };
}

/** Publish imported FAQs one by one after the response; progress shows in the counters. */
async function publishInBackground(ids, adminId) {
  let failed = 0;
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await faqs.publish(id, adminId);
    } catch (err) {
      failed += 1;
      if (failed <= 5) console.warn(`[ai] FAQ ${id} publish after import failed: ${err.message}`);
    }
  }
  if (failed) console.warn(`[ai] ${failed} of ${ids.length} imported FAQs could not be published`);
}

/**
 * include: which statuses to import — default ok + similar (duplicates and
 * errors are skipped). Rows are saved as drafts in bulk; publish: true then
 * publishes them in the background (each queues its own indexing job).
 */
async function commit(importId, mapping, { publish = false, include = ['ok', 'similar'] } = {}, adminId) {
  const checked = await check(importId, mapping);
  const take = checked.rows.filter((r) => r.data && include.includes(r.status));
  const ids = await faqs.createMany(take.map((r) => r.data), adminId);
  await db.query('DELETE FROM rag_faq_imports WHERE id = $1', [importId]).catch(() => {});
  // Warm the variation vectors so the next duplicate check doesn't have to.
  faqs.questionVectors(take.flatMap((r) => r.data.variations || [])).catch(() => {});
  if (publish && ids.length) publishInBackground(ids, adminId);
  return { created: ids.length, skipped: checked.rows.length - take.length, failed: [], publishing: publish ? ids.length : 0 };
}

module.exports = { preview, previewText, check, commit, suggestMapping, FIELDS };
