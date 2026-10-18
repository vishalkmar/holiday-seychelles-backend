/**
 * Public chat API tests (Phase 14): a real HTTP server around the router, with
 * memory, settings and the database faked — no model, no MySQL.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.RAG_SECRET_KEY = process.env.RAG_SECRET_KEY || 'b'.repeat(64);
process.env.CHAT_IP_LIMIT_PER_MIN = '1000';

const settings = require('../settings');
const memory = require('../memory');
const ports = require('../ports');
const store = require('../memory/store');
const identity = require('../memory/identity');
const { createSafeStream } = require('../orchestrator/stream');

const SETTINGS = { widgetEnabled: true, widgetTitle: 'T', widgetSubtitle: 'S', widgetAccent: '#123456', widgetPosition: 'right', chatMaxMessageChars: 200, chatMessagesPerMinute: 3, chatDailyTokenBudget: 1000 };
let tokensUsed = 0;
const saved = {};
let base;
let server;

before(async () => {
  saved.getEffective = settings.getEffective;
  saved.runTurn = memory.runTurn;
  saved.query = ports.db.query;
  saved.latest = store.latestSession;
  settings.getEffective = async () => SETTINGS;
  store.latestSession = async () => null;
  ports.db.query = async (sql) => {
    if (/SUM\(m\.tokens\)/.test(sql)) return { rows: [{ n: tokensUsed }] };
    if (/FROM chat_messages m JOIN chat_sessions s/.test(sql)) return { rows: [] }; // feedback ownership: not found
    if (/FROM admins a LEFT JOIN auth_tokens/.test(sql)) return { rows: [{ status: 'active', revoked_at: null }] }; // soft-launch admin preview
    return { rows: [], rowCount: 0 };
  };
  memory.runTurn = async (input, deps) => {
    if (deps.onToken) { deps.onToken('Hello there. '); deps.onToken('Second sentence. '); }
    return { sessionId: input.sessionId || 'sess-1', messageId: 42, reply: { text: `echo: ${input.message}`, cards: [], chips: [], sources: [], followUps: [] }, trace: { route: 'knowledge', tools: [], llm: [] }, state: {} };
  };
  const app = express();
  app.use(express.json());
  app.use('/api/chat', require('./chat'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/chat`;
});

after(async () => {
  settings.getEffective = saved.getEffective;
  memory.runTurn = saved.runTurn;
  ports.db.query = saved.query;
  store.latestSession = saved.latest;
  await new Promise((r) => server.close(r));
  await ports.db.end?.().catch?.(() => {});
});

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('session issues a signed visitor token; widget-config is public', async () => {
  const r = await (await post('/session', {})).json();
  assert.equal(r.status, 'success');
  assert.ok(identity.verify(r.data.visitorToken));
  assert.equal(r.data.sessionId, null);
  assert.ok(r.data.chips.length >= 3);
  const again = await (await post('/session', {}, { 'X-Chat-Visitor': r.data.visitorToken })).json();
  assert.equal(again.data.visitorToken, null, 'a valid token is kept, not replaced');
  const cfg = await (await fetch(`${base}/widget-config`)).json();
  assert.equal(cfg.data.accent, '#123456');
});

test('message: JSON reply; errors for no token, empty, too long, other origins', async () => {
  const { token } = identity.issue();
  const v = { 'X-Chat-Visitor': token, 'X-Forwarded-For': '10.1.1.1' };
  const ok = await (await post('/message', { text: 'hi' }, v)).json();
  assert.equal(ok.data.reply.text, 'echo: hi');
  assert.equal(ok.data.messageId, 42);
  assert.equal((await (await post('/message', { text: 'hi' })).json()).code, 'INVALID_SESSION');
  assert.equal((await (await post('/message', { text: '  ' }, v)).json()).code, 'EMPTY');
  const long = await post('/message', { text: 'x'.repeat(201) }, v);
  assert.equal(long.status, 413);
  assert.equal((await long.json()).code, 'TOO_LONG');
  const evil = await post('/message', { text: 'hi' }, { ...v, Origin: 'https://evil.example' });
  assert.equal((await evil.json()).code, 'ORIGIN_NOT_ALLOWED');
  const action = await (await post('/message', { action: { type: 'message', text: 'Show me excursions' } }, { 'X-Chat-Visitor': identity.issue().token })).json();
  assert.equal(action.data.reply.text, 'echo: Show me excursions', 'a chip action is sent as its text');
});

test('per-visitor rate limit and daily token budget', async () => {
  const v = { 'X-Chat-Visitor': identity.issue().token };
  const codes = [];
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await (await post('/message', { text: `m${i}` }, v)).json();
    codes.push(r.code || 'ok');
  }
  assert.deepEqual(codes, ['ok', 'ok', 'ok', 'RATE_LIMITED']);
  tokensUsed = 5000;
  const r = await post('/message', { text: 'hi' }, { 'X-Chat-Visitor': identity.issue().token });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'BUDGET_EXCEEDED');
  tokensUsed = 0;
});

test('streaming: SSE token events, then done with the full payload', async () => {
  const r = await post('/message?stream=1', { text: 'hello' }, { 'X-Chat-Visitor': identity.issue().token });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const body = await r.text();
  const events = [...body.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map((m) => [m[1], JSON.parse(m[2])]);
  assert.deepEqual(events.map((e) => e[0]), ['token', 'token', 'meta', 'done']);
  assert.equal(events[0][1].t, 'Hello there. ');
  assert.equal(events[3][1].reply.text, 'echo: hello');
});

test('feedback only on your own messages', async () => {
  const r = await post('/feedback', { messageId: 1, rating: 'up' }, { 'X-Chat-Visitor': identity.issue().token });
  assert.equal((await r.json()).code, 'NOT_FOUND');
  assert.equal((await (await post('/feedback', { messageId: 1, rating: 'meh' }, { 'X-Chat-Visitor': identity.issue().token })).json()).code, 'BAD_FEEDBACK');
});

test('rate-limit IP is the proxy-appended (last) X-Forwarded-For entry', () => {
  const { chatIp } = require('./chat')._internals;
  assert.equal(chatIp({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, ip: '127.0.0.1' }), '203.0.113.9');
  assert.equal(chatIp({ headers: {}, ip: '::1' }), '::1');
});

test('safe stream: sentences pass the grounding check; an invented price never streams; FOLLOWUPS held back', () => {
  const out = [];
  const s = createSafeStream({ evidence: { toolData: [{ items: [{ price: 1158.53 }] }] }, emit: (t) => out.push(t) });
  for (const d of ['Le Vasseur is €1,158.53 for ', 'three nights. Rooms from €99 a ', 'night! Enjoy.\nFOLLOW', 'UPS: More hotels | Beaches']) s.push(d);
  const sent = s.end();
  assert.deepEqual(out, ['Le Vasseur is €1,158.53 for three nights. ', 'Rooms from the live price a night! Enjoy. ']);
  assert.doesNotMatch(sent, /€99|FOLLOW/);
});


test('soft launch: admins-only shows the assistant to a signed-in admin, not to visitors', async () => {
  const { signAdminToken } = require('../../utils/jwt');
  SETTINGS.widgetAudience = 'admins';
  try {
    const cfg = `${base}/widget-config`;
    const visitor = await (await fetch(cfg)).json();
    assert.equal(visitor.data.enabled, false);
    const forged = await (await fetch(cfg, { headers: { 'X-Admin-Preview': 'not-a-token' } })).json();
    assert.equal(forged.data.enabled, false);
    const admin = await (await fetch(cfg, { headers: { 'X-Admin-Preview': signAdminToken(1).token } })).json();
    assert.equal(admin.data.enabled, true);
    const { token } = identity.issue();
    const blocked = await post('/message', { text: 'hi' }, { 'X-Chat-Visitor': token, 'X-Forwarded-For': '10.9.9.9' });
    assert.equal(blocked.status, 503);
  } finally {
    delete SETTINGS.widgetAudience;
  }
});
