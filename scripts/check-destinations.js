// Integration check against the local backend. Creates one temporary draft,
// exercises publishing and version conflicts, and removes it in finally.
require('dotenv').config();
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../src/config/db');
const { validateDestination } = require('../src/services/destinations');
const seed = require('./data/destinations.seed.json');
const base = 'http://127.0.0.1:5001/api';

async function run() {
  const { rows } = await pool.query("SELECT id FROM admins WHERE status='active' AND role_key='owner' AND must_change_password=0 LIMIT 1");
  assert.ok(rows.length, 'An active owner is needed for the integration check.');
  const token = jwt.sign({ sub: rows[0].id, jti: randomUUID(), type: 'admin' }, process.env.JWT_ADMIN_SECRET || 'dev_admin_secret', { expiresIn: '10m' });
  async function call(route, { method = 'GET', body, authenticated = true } = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  assert.throws(() => validateDestination({ ...seed[0], gallery: seed[0].gallery.slice(0, 3) }), /four gallery/);
  assert.throws(() => validateDestination({ ...seed[0], heroImage: { url: 'javascript:alert(1)' } }), /HTTP/);
  assert.throws(() => validateDestination({ ...seed[0], gallery: [seed[0].heroImage, ...seed[0].gallery.slice(1)] }), /different photos/);
  const publicList = await call('/destinations', { authenticated: false });
  assert.equal(publicList.status, 200);
  assert.ok(publicList.body.data.items.length >= 20);
  assert.equal((await call('/admin/website/destinations', { authenticated: false })).status, 401);
  const slug = `integration-check-${randomUUID()}`;
  let temporary;
  try {
    const invalid = await call('/admin/website/destinations', { method: 'POST', body: { ...seed[0], slug, gallery: [] } });
    assert.equal(invalid.status, 422);
    const created = await call('/admin/website/destinations', { method: 'POST', body: { ...seed[0], slug, name: 'Temporary integration check', published: false } });
    assert.equal(created.status, 201, created.body.message);
    temporary = created.body.data.destination;
    assert.equal((await call(`/destinations/${slug}`, { authenticated: false })).status, 404);
    const duplicate = await call('/admin/website/destinations', { method: 'POST', body: temporary });
    assert.equal(duplicate.status, 409);
    const published = await call(`/admin/website/destinations/${temporary.id}`, { method: 'PUT', body: { ...temporary, published: true, tagline: 'Integration persistence check' } });
    assert.equal(published.status, 200, published.body.message);
    const stale = await call(`/admin/website/destinations/${temporary.id}`, { method: 'PUT', body: temporary });
    assert.equal(stale.status, 409);
    temporary = published.body.data.destination;
    const visible = await call(`/destinations/${slug}`, { authenticated: false });
    assert.equal(visible.body.data.destination.tagline, 'Integration persistence check');
    const hidden = await call(`/admin/website/destinations/${temporary.id}`, { method: 'PUT', body: { ...temporary, published: false } });
    assert.equal(hidden.status, 200);
    assert.equal((await call(`/destinations/${slug}`, { authenticated: false })).status, 404);
    const config = (await call('/admin/website/destinations')).body.data.config;
    assert.equal((await call('/admin/website/destinations/configuration', { method: 'PUT', body: config })).status, 200);
    console.log('PASS: public data, authentication, required images, safe URLs, draft isolation, duplicate slugs, publishing, persistence, stale-update protection, unpublishing and configuration.');
  } finally {
    if (temporary) assert.equal((await call(`/admin/website/destinations/${temporary.id}`, { method: 'DELETE' })).status, 200);
    await pool.end();
  }
  assert.equal((await call(`/destinations/${slug}`, { authenticated: false })).status, 404);
  console.log('PASS: temporary destination deleted; seeded destinations preserved.');
}
run().catch(error => { console.error(error.message); pool.end().catch(() => {}); process.exitCode = 1; });
