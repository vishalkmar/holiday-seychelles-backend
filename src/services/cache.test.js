/**
 * Shared cache (extra track 2.5): memory backend semantics, TTL, wrap() sharing
 * one call between concurrent misses, and the TourVisio proxy caching only
 * read-only, successful supplier answers.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

delete process.env.REDIS_URL; // memory backend in tests
const cache = require('./cache');

beforeEach(() => cache._resetMemory());

test('cache: set/get/del, TTL expiry, prefix delete, stats', async () => {
  await cache.set('a', { x: 1 }, 60);
  assert.deepEqual(await cache.get('a'), { x: 1 });
  await cache.set('b', 'short', 0.001);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await cache.get('b'), null);
  await cache.set('p:1', 1, 60);
  await cache.set('p:2', 2, 60);
  await cache.delPrefix('p:');
  assert.equal(await cache.get('p:1'), null);
  await cache.del('a');
  assert.equal(await cache.get('a'), null);
  const s = cache.stats();
  assert.equal(s.backend, 'memory');
  assert.ok(s.hits >= 1 && s.misses >= 3);
});

test('cache: wrap stores good results once, shares a concurrent miss, never stores failures', async () => {
  let calls = 0;
  const slow = () => new Promise((r) => setTimeout(() => { calls += 1; r({ ok: true }); }, 30));
  const [a, b] = await Promise.all([cache.wrap('w', 60, slow), cache.wrap('w', 60, slow)]);
  assert.deepEqual([a, b, calls], [{ ok: true }, { ok: true }, 1]);
  await cache.wrap('w', 60, slow);
  assert.equal(calls, 1, 'second call is a hit');
  await cache.wrap('bad', 60, async () => ({ error: 'x' }), { cacheable: (v) => !v.error });
  assert.equal(await cache.get('bad'), null);
});

test('proxy: read-only supplier calls are cached by body, bookings and failures never', async () => {
  const proxyMod = require('./tourvisioProxyRequest');
  const seen = [];
  const original = proxyMod.proxyRequest;
  proxyMod.proxyRequest = async (url, opts) => {
    seen.push(url);
    const fail = /fail/.test(opts.body || '');
    return { status: 200, contentType: 'application/json', text: JSON.stringify({ header: { success: !fail }, body: { url } }) };
  };
  delete require.cache[require.resolve('../routes/public/tourvisioProxy')];
  const app = express();
  app.use(express.json());
  app.use('/api/tourvisio', require('../routes/public/tourvisioProxy'));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/tourvisio`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Math.random()}` }, body: JSON.stringify(body) });
  try {
    const a = await post('/api/productservice/getproductinfo', { productCode: 'H1' });
    const b = await post('/api/productservice/getproductinfo', { productCode: 'H1' });
    assert.deepEqual([a.headers.get('x-cache'), b.headers.get('x-cache')], ['MISS', 'HIT'], 'same body, other token → cached');
    await post('/api/productservice/getproductinfo', { productCode: 'H2' });
    await post('/api/bookingservice/createbooking', { x: 1 });
    await post('/api/bookingservice/createbooking', { x: 1 });
    await post('/api/productservice/pricesearch', { fail: true });
    const again = await post('/api/productservice/pricesearch', { fail: true });
    assert.equal(again.headers.get('x-cache'), 'MISS', 'a failed answer is not stored');
    assert.equal(seen.filter((u) => /createbooking/.test(u)).length, 2, 'bookings always reach the supplier');
    assert.equal(seen.filter((u) => /getproductinfo/.test(u)).length, 2);
  } finally {
    server.close();
    proxyMod.proxyRequest = original;
  }
});
