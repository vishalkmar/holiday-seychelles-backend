const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Pure checks: no query is run (permissions.js only creates the pool, closed below).
const { load } = require('./config');
const { ensureStorage, isPublic } = require('./storage');
const { CATALOGUE } = require('../services/permissions');

// permissions.js opens the MySQL pool on load; close it so the run can exit.
after(async () => {
  const { pool } = require('../config/db');
  await pool.end?.().catch?.(() => {});
});

test('config defaults: mysql vector store, nothing configured, no warnings', () => {
  const c = load({});
  assert.equal(c.vector.driver, 'mysql');
  assert.equal(c.nvidia.configured, false);
  assert.equal(c.vector.pinecone.configured, false);
  assert.equal(c.maxUploadMb, 20);
  assert.deepEqual(c.warnings, []);
});

test('config: pinecone without credentials falls back to mysql with a warning', () => {
  const c = load({ RAG_VECTOR_DRIVER: 'pinecone' });
  assert.equal(c.vector.requested, 'pinecone');
  assert.equal(c.vector.driver, 'mysql');
  assert.match(c.warnings[0], /PINECONE/);
});

test('config: pinecone with credentials is used', () => {
  const c = load({ RAG_VECTOR_DRIVER: 'pinecone', PINECONE_API_KEY: 'k', PINECONE_INDEX_HOST: 'https://idx.example/' });
  assert.equal(c.vector.driver, 'pinecone');
  assert.equal(c.vector.pinecone.indexHost, 'https://idx.example');
});

test('config: unknown driver and bad numbers never throw', () => {
  const c = load({ RAG_VECTOR_DRIVER: 'chroma', RAG_MAX_UPLOAD_MB: 'lots' });
  assert.equal(c.vector.driver, 'mysql');
  assert.equal(c.maxUploadMb, 20);
  assert.equal(c.warnings.length, 1);
});

test('storage: creates the folder with a deny-all .htaccess', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-'));
  const target = path.join(dir, 'storage', 'rag');
  ensureStorage(target);
  assert.ok(fs.existsSync(path.join(target, '.htaccess')));
  assert.match(fs.readFileSync(path.join(target, '.htaccess'), 'utf8'), /denied/);
});

test('storage: the default folder is not inside the public uploads folder', () => {
  assert.equal(isPublic(), false);
});

test('permissions: every rag.* key is in the catalogue and the risky ones are sensitive', () => {
  const rag = CATALOGUE.find((g) => g.group === 'AI Assistant');
  assert.ok(rag, 'AI Assistant group exists');
  const byKey = Object.fromEntries(rag.permissions.map((p) => [p.key, p]));
  for (const key of ['rag.prompt.edit', 'rag.tools.manage', 'rag.index.manage', 'rag.settings.manage']) {
    assert.equal(byKey[key]?.sensitive, true, `${key} is sensitive`);
  }
});
