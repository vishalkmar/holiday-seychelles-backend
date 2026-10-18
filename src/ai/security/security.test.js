const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const stepup = require('./stepup');
const { offHours } = require('./events');
const { db } = require('../ports');

after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

const NOW = new Date('2026-10-16T08:00:00Z');
const later = (min) => new Date(NOW.getTime() + min * 60000);
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

test('challenge rules: missing, used, expired, attempt limit', () => {
  const ok = { verified_at: null, expires_at: later(5), attempts: 0 };
  assert.equal(stepup.challengeProblem(ok, NOW), null);
  assert.equal(stepup.challengeProblem(null, NOW)[0], 'NOT_FOUND');
  assert.equal(stepup.challengeProblem({ ...ok, verified_at: NOW }, NOW)[0], 'USED');
  assert.equal(stepup.challengeProblem({ ...ok, expires_at: later(-1) }, NOW)[0], 'EXPIRED');
  assert.equal(stepup.challengeProblem({ ...ok, attempts: stepup.MAX_ATTEMPTS }, NOW)[0], 'LOCKED');
  assert.equal(stepup.challengeProblem({ ...ok, attempts: stepup.MAX_ATTEMPTS - 1 }, NOW), null);
});

test('token rules: bound to admin + action + target, single use, 15 minutes', () => {
  const t = { admin_id: 7, action: 'prompt.publish', target: 'draft:3:abc', expires_at: later(15), used_at: null };
  const want = { adminId: 7, action: 'prompt.publish', target: 'draft:3:abc' };
  assert.equal(stepup.tokenProblem(t, want, NOW), null);
  assert.equal(stepup.tokenProblem(null, want, NOW)[0], 'TOKEN_INVALID');
  assert.equal(stepup.tokenProblem({ ...t, used_at: NOW }, want, NOW)[0], 'TOKEN_USED');
  assert.equal(stepup.tokenProblem({ ...t, expires_at: later(-1) }, want, NOW)[0], 'TOKEN_EXPIRED');
  assert.equal(stepup.tokenProblem(t, { ...want, adminId: 8 }, NOW)[0], 'TOKEN_WRONG_ADMIN');
  assert.equal(stepup.tokenProblem(t, { ...want, action: 'prompt.rollback' }, NOW)[0], 'TOKEN_WRONG_ACTION');
  assert.equal(stepup.tokenProblem(t, { ...want, target: 'draft:3:def' }, NOW)[0], 'TOKEN_WRONG_TARGET', 'draft edited after verifying');
  assert.equal(stepup.TOKEN_TTL_MIN, 15);
  assert.equal(stepup.CODE_TTL_MIN, 10);
});

test('off-hours: 22:00–06:00 Seychelles time (UTC+4)', () => {
  assert.equal(offHours(new Date('2026-10-16T08:00:00Z')), false); // 12:00
  assert.equal(offHours(new Date('2026-10-16T17:59:00Z')), false); // 21:59
  assert.equal(offHours(new Date('2026-10-16T18:00:00Z')), true); // 22:00
  assert.equal(offHours(new Date('2026-10-16T01:30:00Z')), true); // 05:30
  assert.equal(offHours(new Date('2026-10-16T02:00:00Z')), false); // 06:00
});

test('email is masked in responses', () => {
  assert.equal(stepup.maskEmail('piyush@example.com'), 'pi••••@example.com');
});

/** Fake database for verify/consume/resend (swapped into the shared pool object). */
function withFakeDb(state, fn) {
  const real = db.query;
  db.query = async (sql, params = []) => {
    if (/FROM rag_stepup_challenges WHERE id/.test(sql)) return { rows: state.challenge ? [{ ...state.challenge, since_sent: state.sinceSent ?? 999 }] : [] };
    if (/UPDATE rag_stepup_challenges SET attempts/.test(sql)) { state.challenge.attempts += 1; return { rowCount: 1 }; }
    if (/UPDATE rag_stepup_challenges SET verified_at/.test(sql)) { state.challenge.verified_at = new Date(); return { rowCount: 1 }; }
    if (/INSERT INTO rag_change_tokens/.test(sql)) { state.tokens[params[0]] = { token_hash: params[0], admin_id: params[1], action: params[2], target: params[3], expires_at: new Date(Date.now() + 900e3), used_at: null }; return { rowCount: 1 }; }
    if (/SELECT \* FROM rag_change_tokens/.test(sql)) return { rows: state.tokens[params[0]] ? [state.tokens[params[0]]] : [] };
    if (/UPDATE rag_change_tokens SET used_at/.test(sql)) { const t = state.tokens[params[0]]; if (!t || t.used_at) return { rowCount: 0 }; t.used_at = new Date(); return { rowCount: 1 }; }
    if (/FROM admins WHERE id/.test(sql)) return { rows: [{ id: 7, email: 'a@b.c', name: 'A', status: 'active' }] };
    if (/INSERT INTO admin_audit_log|admin_audit_log/.test(sql)) return { rows: [], rowCount: 1 };
    if (/CREATE TABLE|SHOW TABLES|information_schema|rag_migrations|schema_migrations/i.test(sql)) return { rows: [], rowCount: 0 };
    state.unhandled.push(sql.slice(0, 80));
    return { rows: [], rowCount: 0 };
  };
  return fn().finally(() => { db.query = real; });
}

test('verify: wrong codes counted and locked after 5; right code → token; token works once, for its action only', async () => {
  const state = { challenge: { id: 'c1', admin_id: 7, action: 'prompt.publish', target: 'draft:1:x', code_hash: sha('123456'), attempts: 0, verified_at: null, expires_at: new Date(Date.now() + 3600e3) }, tokens: {}, unhandled: [] };
  const req = { get: () => 'test-agent', headers: {}, socket: {} };
  await withFakeDb(state, async () => {
    await assert.rejects(stepup.verify({ req, adminId: 7, challengeId: 'c1', code: '000000' }), (e) => e.code === 'BAD_CODE' && /4 tries left/.test(e.message));
    await assert.rejects(stepup.verify({ req, adminId: 8, challengeId: 'c1', code: '123456' }), (e) => e.code === 'NOT_FOUND', 'another admin cannot use my challenge');
    const r = await stepup.verify({ req, adminId: 7, challengeId: 'c1', code: '123456' });
    assert.ok(r.changeToken.length >= 40);
    await assert.rejects(stepup.verify({ req, adminId: 7, challengeId: 'c1', code: '123456' }), (e) => e.code === 'USED');
    await assert.rejects(stepup.consume({ adminId: 7, token: r.changeToken, action: 'prompt.rollback', target: 'draft:1:x' }), (e) => e.code === 'TOKEN_WRONG_ACTION' && e.status === 403);
    assert.equal(await stepup.consume({ adminId: 7, token: r.changeToken, action: 'prompt.publish', target: 'draft:1:x' }), true);
    await assert.rejects(stepup.consume({ adminId: 7, token: r.changeToken, action: 'prompt.publish', target: 'draft:1:x' }), (e) => e.code === 'TOKEN_USED');
    await assert.rejects(stepup.consume({ adminId: 7, token: '', action: 'prompt.publish', target: 'draft:1:x' }), (e) => e.code === 'STEP_UP_REQUIRED' && e.status === 428);

    state.challenge = { ...state.challenge, id: 'c2', attempts: 0, verified_at: null };
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(stepup.verify({ req, adminId: 7, challengeId: 'c2', code: '999999' }));
    }
    await assert.rejects(stepup.verify({ req, adminId: 7, challengeId: 'c2', code: '123456' }), (e) => e.code === 'LOCKED', 'the right code is refused after 5 misses');
  });
});

test('resend: 60-second cooldown', async () => {
  const state = { challenge: { id: 'c3', admin_id: 7, action: 'prompt.publish', target: 't', code_hash: 'x', attempts: 0, sends: 1, verified_at: null, expires_at: new Date(Date.now() + 3600e3) }, sinceSent: 20, tokens: {}, unhandled: [] };
  await withFakeDb(state, async () => {
    await assert.rejects(stepup.resend({ req: { get: () => '' }, adminId: 7, challengeId: 'c3' }), (e) => e.code === 'COOLDOWN' && /40 seconds/.test(e.message));
  });
});
