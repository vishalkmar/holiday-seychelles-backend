/**
 * API connectors (extra track 2.3 / 2.4): URL building, response shaping,
 * private-address refusal, discovery of our own routes and what is locked.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const c = require('./connectors');

after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

test('connectors: URL from fixed and assistant-filled params, path and query', () => {
  const conn = { kind: 'external', url: 'https://api.example.com/v1/{city}/weather', params: [{ name: 'city', in: 'path', required: true }, { name: 'units', in: 'query', value: 'metric' }, { name: 'days', in: 'query' }] };
  assert.equal(c.buildUrl(conn, { city: 'Victoria Mahé', days: 3 }), 'https://api.example.com/v1/Victoria%20Mah%C3%A9/weather?units=metric&days=3');
  assert.throws(() => c.buildUrl(conn, {}), /city/);
  const internal = { kind: 'internal', url: '/api/blogs/:slug', params: [{ name: 'slug', in: 'path', required: true }] };
  assert.equal(c.buildUrl(internal, { slug: 'best-beaches' }, 'http://127.0.0.1:5000'), 'http://127.0.0.1:5000/api/blogs/best-beaches');
});

test('connectors: response path, item cap, size cap', () => {
  const body = { data: { items: Array.from({ length: 30 }, (_, i) => ({ i })) } };
  const r = c.shapeResponse(body, { responsePath: 'data.items', maxItems: 5 });
  assert.equal(r.items.length, 5);
  assert.equal(r.truncated, true);
  assert.equal(c.shapeResponse(body, { responsePath: 'data.nothing' }).error, 'EMPTY');
  assert.ok(c.shapeResponse({ big: 'x'.repeat(20000) }, {}).text.endsWith('…'));
});

test('connectors: private and local addresses are refused (SSRF)', () => {
  for (const ip of ['127.0.0.1', '10.2.3.4', '172.20.1.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(c.isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '37.122.148.188', '2606:4700::1111']) assert.ok(!c.isPrivateIp(ip), ip);
});

test('connectors: discovery lists our GET routes; only public content can be used', () => {
  const app = express();
  const blogs = express.Router();
  blogs.get('/', (q, s) => s.end());
  blogs.get('/:slug', (q, s) => s.end());
  const admin = express.Router();
  admin.get('/users', (q, s) => s.end());
  app.use('/api/blogs', blogs);
  app.use('/api/admin/x', admin);
  app.post('/api/site/form', (q, s) => s.end());
  c.setApp(app);
  const routes = c.discover();
  const by = Object.fromEntries(routes.map((r) => [r.path, r]));
  assert.equal(by['/api/blogs'].allowed, true);
  assert.deepEqual(by['/api/blogs/:slug'].params, ['slug']);
  assert.equal(by['/api/admin/x/users'].allowed, false);
  assert.match(by['/api/admin/x/users'].reason, /Admin/);
  assert.equal(by['/api/site/form'], undefined, 'POST routes are not listed');
});

test('connectors: outside APIs must be https and need a real description', () => {
  assert.throws(() => c.cleanInput({ kind: 'external', name: 'W', description: 'Weather for a Seychelles town', url: 'http://api.example.com' }), /https/);
  assert.throws(() => c.cleanInput({ kind: 'external', name: 'W', description: 'short', url: 'https://api.example.com' }), /Describe/);
  const ok = c.cleanInput({ kind: 'external', name: 'Weather', description: 'Weather forecast for a Seychelles town', url: 'https://api.example.com/{town}', params: [{ name: 'town', in: 'path', required: true }], headers: { 'X-Api-Key': 'secret' } });
  assert.deepEqual(ok.headers, { 'X-Api-Key': 'secret' });
});

test('connectors: a question matches an enabled connector by its name and description', () => {
  const items = [
    { enabled: true, name: 'Seychelles weather', description: 'Current temperature, rain and wind for a town.', tool: 'api.weather' },
    { enabled: false, name: 'Ferry times', description: 'Cat Cocos ferry departures.', tool: 'api.ferry' },
    { enabled: true, name: 'Exchange rates', description: 'Rupee to euro and dollar rates.', tool: 'api.fx' },
  ];
  assert.deepEqual(c.matchQuestion('What is the weather like on Mahé today, any rain?', items).map((x) => x.tool), ['api.weather']);
  assert.deepEqual(c.matchQuestion('ferry times to Praslin', items), [], 'switched off');
  assert.deepEqual(c.matchQuestion('best beach on Praslin', items), []);
});
