/**
 * Saved test cases and the suite runner (Phase 19).
 *
 * A case is one visitor message and what a good reply must do:
 *   route      e.g. "knowledge", "live_search", "flow"      (exact)
 *   product    "hotels" | "excursions" | "transfers"       (from the state)
 *   minCards   at least this many result cards
 *   include    words/phrases the reply must contain (any case)
 *   exclude    words/phrases it must not contain (e.g. "booking.com")
 *   noPrice    the reply text shows no amount of money
 * The suite runs every active case through the visitor's path (flows, then
 * the assistant) against the draft, the published prompt or an older version,
 * in a sandbox, and keeps each run so versions can be compared case by case.
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const { createSandbox, businessFor } = require('./sandbox');
const { PRICE_RE } = require('../orchestrator/grounding');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const j = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : v ?? d; } catch { return d; } };
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n|\|/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);

function cleanExpect(e = {}) {
  const out = {};
  if (e.route) out.route = String(e.route).trim().slice(0, 20);
  if (['hotels', 'excursions', 'transfers'].includes(e.product)) out.product = e.product;
  if (Number(e.minCards) > 0) out.minCards = Math.min(20, Number.parseInt(e.minCards, 10));
  if (list(e.include).length) out.include = list(e.include);
  if (list(e.exclude).length) out.exclude = list(e.exclude);
  if (e.noPrice) out.noPrice = true;
  return out;
}

function cleanCase(input = {}) {
  const message = String(input.message || '').trim();
  if (!message) throw bad('Write the visitor message to test');
  if (message.length > 2000) throw bad('The message is longer than 2000 characters');
  const expect = cleanExpect(input.expect || {});
  if (!Object.keys(expect).length) throw bad('Add at least one check (route, product, cards, must include / must not include, no price)');
  return { name: String(input.name || message).trim().slice(0, 160), message, expect, tags: list(input.tags).join(',').slice(0, 255) || null, active: input.active === false ? 0 : 1 };
}

/** Check a reply against a case's expectations → { pass, checks: [{ check, pass, detail }] }. Pure. */
function evaluate(expect, { reply = {}, trace = {}, state = {} }) {
  const text = String(reply.text || '');
  // Models write "+248 437 6666" with no-break spaces and "Semi‑Submarine" with odd hyphens.
  const plain = (s) => String(s).normalize('NFKC').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/[\u2010-\u2015\u2212]/g, '-').toLowerCase();
  const low = plain(text);
  const checks = [];
  const add = (check, pass, detail) => checks.push({ check, pass, detail });
  if (expect.route) add('route', trace.route === expect.route, `got ${trace.route || '—'}`);
  if (expect.product) {
    // The assistant's product, or the guided flow that took over (its key is the product).
    const flowKey = trace.flow?.flow;
    const got = state.product || (['hotels', 'excursions', 'transfers'].includes(flowKey) ? flowKey : null);
    add('product', got === expect.product, `got ${got || '—'}`);
  }
  if (expect.minCards) add('cards', (reply.cards || []).length >= expect.minCards, `${(reply.cards || []).length} card(s)`);
  for (const w of expect.include || []) add(`includes “${w}”`, low.includes(plain(w)), low.includes(plain(w)) ? 'found' : 'missing');
  for (const w of expect.exclude || []) add(`excludes “${w}”`, !low.includes(plain(w)), low.includes(plain(w)) ? 'found in the reply' : 'not there');
  if (expect.noPrice) {
    const m = text.match(new RegExp(PRICE_RE.source, 'i'));
    add('no price', !m, m ? `shows ${m[0]}` : 'none');
  }
  return { pass: checks.every((c) => c.pass), checks };
}

const shapeCase = (r) => ({ id: Number(r.id), name: r.name, message: r.message, expect: j(r.expect_json, {}), tags: r.tags ? r.tags.split(',') : [], active: Boolean(r.active), createdAt: r.created_at, updatedAt: r.updated_at });

async function listCases() {
  await ensureAiTables();
  const { rows } = await db.query('SELECT * FROM rag_test_cases ORDER BY id');
  return rows.map(shapeCase);
}

async function createCase(input, adminId) {
  await ensureAiTables();
  const c = cleanCase(input);
  const r = await db.query('INSERT INTO rag_test_cases (name, message, expect_json, tags, active, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [c.name, c.message, JSON.stringify(c.expect), c.tags, c.active, adminId || null]);
  return { id: Number(r.insertId), ...c };
}

async function updateCase(id, input) {
  await ensureAiTables();
  const c = cleanCase(input);
  const r = await db.query('UPDATE rag_test_cases SET name = $1, message = $2, expect_json = $3, tags = $4, active = $5 WHERE id = $6', [c.name, c.message, JSON.stringify(c.expect), c.tags, c.active, id]);
  if (!r.rowCount && !r.affectedRows) {
    const { rows } = await db.query('SELECT id FROM rag_test_cases WHERE id = $1', [id]);
    if (!rows[0]) throw bad('Test case not found', 404);
  }
  return { id: Number(id), ...c };
}

async function deleteCase(id) {
  await db.query('DELETE FROM rag_test_cases WHERE id = $1', [id]);
  return { ok: true };
}

/** A starter suite from the owner's rules, added once when there are no cases yet. */
const STARTER = [
  { name: 'Best resort → our live search, no names', message: 'Which is the best 5-star resort in Seychelles?', expect: { product: 'hotels', exclude: ['four seasons', 'raffles', 'booking.com'] } },
  { name: 'Other booking sites are never suggested', message: 'Give me hotels from booking.com in Mahé', expect: { product: 'hotels', exclude: ['booking.com'] } },
  { name: 'Airbnb → we only show what you can book here', message: 'Can you find me something on Airbnb in La Digue?', expect: { exclude: ['airbnb.com'] } },
  { name: 'About us: company details', message: 'Who owns Holidays Seychelles?', expect: { include: ['ESPACE Seychelles'] } },
  { name: 'Contact details', message: 'What is your office address and phone number?', expect: { include: ['+248 437 6666'] } },
  { name: 'Visa: Travel Authorisation', message: 'Do I need a visa for Seychelles?', expect: { include: ['Travel Authorisation'], noPrice: true } },
  { name: 'No invented prices for general questions', message: 'Is Seychelles expensive?', expect: { noPrice: true } },
  { name: 'Hotel search with dates shows cards', message: 'Best hotel on Praslin from 10 to 13 December for 2 adults', expect: { product: 'hotels', minCards: 1 } },
  { name: 'Restaurants: no names from memory', message: 'What are the best restaurants in Victoria?', expect: { exclude: ['marie antoinette', 'tripadvisor'] } },
  { name: 'Off-topic is declined', message: 'Write me a Python script to sort a list', expect: { exclude: ['def ', 'sorted('] } },
];

async function seedStarter(adminId) {
  const existing = await listCases();
  if (existing.length) return { added: 0 };
  for (const c of STARTER) await createCase(c, adminId); // eslint-disable-line no-await-in-loop
  return { added: STARTER.length };
}

const shapeRun = (r, withResults = true) => ({
  id: Number(r.id), promptRef: r.prompt_ref, promptVersion: r.prompt_version, total: r.total, passed: r.passed, failed: r.failed, status: r.status, ms: r.ms, createdAt: r.created_at, finishedAt: r.finished_at,
  ...(withResults ? { results: j(r.results_json, []) } : {}),
});

async function listRuns({ limit = 20 } = {}) {
  await ensureAiTables();
  const lim = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  // A run still "running" after an hour died with a server restart.
  await db.query("UPDATE rag_test_runs SET status = 'stopped', finished_at = NOW() WHERE status = 'running' AND created_at < (NOW() - INTERVAL 1 HOUR)").catch(() => {});
  const { rows } = await db.query(`SELECT * FROM rag_test_runs ORDER BY id DESC LIMIT ${lim}`);
  return rows.map((r) => shapeRun(r, false));
}

async function getRun(id) {
  const { rows } = await db.query('SELECT * FROM rag_test_runs WHERE id = $1', [id]);
  if (!rows[0]) throw bad('Run not found', 404);
  return shapeRun(rows[0]);
}

/**
 * Start a run in the background → { runId }. Progress is saved after every
 * case, so the screen can poll getRun. deps.run(case, promptRef) is for tests.
 */
async function startRun({ promptRef = 'published', caseIds } = {}, adminId, deps = {}) {
  await ensureAiTables();
  const resolved = await businessFor(promptRef); // fail now if the ref is wrong
  const all = (await listCases()).filter((c) => c.active && (!caseIds?.length || caseIds.map(Number).includes(c.id)));
  if (!all.length) throw bad('No active test cases to run');
  const r = await db.query('INSERT INTO rag_test_runs (prompt_ref, prompt_version, total, created_by) VALUES ($1, $2, $3, $4)', [resolved.label, resolved.version, all.length, adminId || null]);
  const runId = Number(r.insertId);
  const done = runSuite(runId, all, promptRef, deps).catch((err) => db.query("UPDATE rag_test_runs SET status = 'failed', finished_at = NOW(), results_json = $1 WHERE id = $2", [JSON.stringify([{ error: err.message }]), runId]).catch(() => {}));
  return deps.wait ? done.then(() => ({ runId })) : { runId };
}

async function runSuite(runId, cases, promptRef, deps) {
  const t0 = Date.now();
  const results = [];
  let passed = 0;
  for (const c of cases) {
    const t = Date.now();
    let res;
    try {
      // Each case is a fresh conversation.
      // eslint-disable-next-line no-await-in-loop
      const out = deps.run ? await deps.run(c, promptRef) : await createSandbox({ promptRef }).turn(c.message);
      const ev = evaluate(c.expect, out);
      res = { caseId: c.id, name: c.name, pass: ev.pass, checks: ev.checks, reply: String(out.reply?.text || '').slice(0, 600), cards: (out.reply?.cards || []).length, route: out.trace?.route, ms: Date.now() - t };
    } catch (err) {
      res = { caseId: c.id, name: c.name, pass: false, checks: [{ check: 'ran', pass: false, detail: err.code || err.message }], ms: Date.now() - t };
    }
    if (res.pass) passed += 1;
    results.push(res);
    // eslint-disable-next-line no-await-in-loop
    await db.query('UPDATE rag_test_runs SET passed = $1, failed = $2, results_json = $3, ms = $4 WHERE id = $5', [passed, results.length - passed, JSON.stringify(results), Date.now() - t0, runId]);
  }
  await db.query("UPDATE rag_test_runs SET status = 'done', finished_at = NOW() WHERE id = $1", [runId]);
}

/** Two runs side by side, per case: which got better, worse or stayed the same. */
async function compareRuns(aId, bId) {
  const [a, b] = await Promise.all([getRun(aId), getRun(bId)]);
  const byCase = new Map();
  for (const r of a.results) byCase.set(r.caseId, { caseId: r.caseId, name: r.name, a: r.pass });
  for (const r of b.results) byCase.set(r.caseId, { ...(byCase.get(r.caseId) || { caseId: r.caseId, name: r.name }), b: r.pass });
  const rows = [...byCase.values()].map((x) => ({ ...x, change: x.a === undefined || x.b === undefined ? 'new' : x.a === x.b ? 'same' : x.b ? 'fixed' : 'broke' }));
  return { a: { id: a.id, promptRef: a.promptRef, passed: a.passed, total: a.total }, b: { id: b.id, promptRef: b.promptRef, passed: b.passed, total: b.total }, rows };
}

module.exports = { listCases, createCase, updateCase, deleteCase, seedStarter, listRuns, getRun, startRun, compareRuns, evaluate, cleanCase, STARTER };
