const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toBuffer, fromBuffer, cosine, quantize, shortlist, matches, normalize, estimateCacheBytes } = require('./math');
const { createPinecone, vectorId, chunkIdOf } = require('./pineconeDriver');

function rand(dim, seed) {
  // Small deterministic PRNG so the test is repeatable.
  let x = seed;
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = (x / 2147483648) * 2 - 1;
  }
  return v;
}

test('Float32 ↔ Buffer round trip is exact', () => {
  const v = rand(2048, 1);
  const back = fromBuffer(toBuffer(v));
  assert.equal(back.length, 2048);
  assert.deepEqual(Array.from(back.slice(0, 5)), Array.from(v.slice(0, 5)));
  assert.equal(fromBuffer(null), null);
});

test('cosine: identical = 1, opposite = -1, size mismatch throws', () => {
  const v = rand(16, 2);
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(v, v.map((x) => -x)) + 1) < 1e-6);
  assert.throws(() => cosine(rand(4, 1), rand(5, 1)), /mismatch/);
});

test('Int8 shortlist ranks like exact cosine on 2048-dim vectors', () => {
  const docs = Array.from({ length: 300 }, (_, i) => ({ id: i, v: rand(2048, i + 10) }));
  const query = docs[42].v.map((x, i) => x + (i % 7 === 0 ? 0.05 : 0)); // near doc 42
  const entries = docs.map((d) => ({ id: d.id, ...quantize(d.v), meta: { visibility: 'public' } }));
  const approx = shortlist(query, entries, { limit: 5 });
  const exact = docs.map((d) => ({ id: d.id, score: cosine(query, d.v) })).sort((a, b) => b.score - a.score).slice(0, 5);
  assert.equal(approx[0].id, 42);
  assert.equal(exact[0].id, 42);
  assert.ok(Math.abs(approx[0].score - exact[0].score) < 0.02, 'approx score close to exact');
});

test('filters: visibility, list values and sourceIds', () => {
  const meta = { sourceId: 7, visibility: 'internal', sourceType: 'faq', destination: 'praslin' };
  assert.equal(matches(meta, { visibility: 'public' }), false);
  assert.equal(matches(meta, { visibility: null, sourceType: ['faq', 'document'] }), true);
  assert.equal(matches(meta, { sourceIds: [1, 7] }), true);
  assert.equal(matches(meta, { destination: 'mahe' }), false);
  const entries = [
    { id: 1, ...quantize(normalize(rand(8, 3))), meta: { visibility: 'public' } },
    { id: 2, ...quantize(normalize(rand(8, 4))), meta: { visibility: 'internal' } },
  ];
  assert.deepEqual(shortlist(rand(8, 3), entries, { filter: { visibility: 'public' } }).map((e) => e.id), [1]);
});

test('memory: 2048-dim Int8 cache stays small (50k chunks ≈ 100 MB, not 400 MB)', () => {
  assert.ok(estimateCacheBytes(50000, 2048) < 110 * 1024 * 1024);
});

test('pinecone: ids round trip, upsert batches and namespaces, query builds filters', async () => {
  assert.equal(vectorId(12), 'c12');
  assert.equal(chunkIdOf('c12'), 12);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, key: init.headers['Api-Key'] });
    if (url.endsWith('/query')) return { ok: true, status: 200, text: async () => JSON.stringify({ matches: [{ id: 'c5', score: 0.91 }] }) };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const p = createPinecone({ apiKey: 'pk', indexHost: 'idx.example', namespace: 'hs' }, { fetchImpl });
  const items = Array.from({ length: 120 }, (_, i) => ({ chunkId: i, vector: rand(4, i), meta: { sourceId: 1, visibility: 'public', destination: null } }));
  await p.upsert(items);
  const upserts = calls.filter((c) => c.url.endsWith('/vectors/upsert'));
  assert.equal(upserts.length, 6, '120 vectors in batches of 20');
  assert.equal(upserts[0].body.namespace, 'hs');
  assert.equal(upserts[0].url.startsWith('https://idx.example'), true);
  assert.equal('destination' in upserts[0].body.vectors[0].metadata, false, 'null metadata dropped');
  const hits = await p.query({ vector: rand(4, 1), k: 3, filter: { visibility: 'public', sourceType: ['faq'], sourceIds: [1, 2] } });
  const q = calls.find((c) => c.url.endsWith('/query')).body;
  assert.deepEqual(q.filter, { visibility: { $eq: 'public' }, sourceType: { $in: ['faq'] }, sourceId: { $in: [1, 2] } });
  assert.deepEqual(hits, [{ id: 5, score: 0.91 }]);
  await p.deleteIds([1, 2]);
  assert.deepEqual(calls.at(-1).body, { ids: ['c1', 'c2'], namespace: 'hs' });
});

test('pinecone: a 401 explains the key/project mismatch', async () => {
  const p = createPinecone({ apiKey: 'pk', indexHost: 'idx.example', namespace: 'hs' }, { fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }) });
  await assert.rejects(p.describe(), (err) => err.code === 'AUTH' && /same Pinecone project/.test(err.message));
});
