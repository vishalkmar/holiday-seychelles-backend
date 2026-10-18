const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadCases } = require('./eval');
const mysqlDriver = require('../vector/mysqlDriver');

// eval.js loads ports, which creates (but never uses) the MySQL pool.
after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

test('eval set: 30+ cases, each with a question and at least one expected source', () => {
  const cases = loadCases();
  assert.ok(cases.length >= 30, `only ${cases.length} cases`);
  for (const c of cases) {
    assert.ok(c.q && c.q.trim(), 'question');
    assert.ok(Array.isArray(c.expect) && c.expect.length, `expect for “${c.q}”`);
    c.expect.forEach((w) => assert.ok(w.title, `title for “${c.q}”`));
  }
  assert.equal(new Set(cases.map((c) => c.q.toLowerCase())).size, cases.length, 'no repeated questions');
});

test('mysql driver exposes in-memory scoring for keyword-only hits', () => {
  assert.equal(typeof mysqlDriver.scoreIds, 'function');
  assert.equal(typeof mysqlDriver.search, 'function');
});
