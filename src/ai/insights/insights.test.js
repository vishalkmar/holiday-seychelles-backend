/**
 * Phase 19: analytics summaries, the test-case checks, the suite runner,
 * clustering of unanswered questions and the conflict detector (pure parts
 * and the runner with a fake turn — no network).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTraces, normalizeQuestion, toCsv, daysBack } = require('./analytics');
const { evaluate, cleanCase } = require('./tests');
const { unanswered, cluster, factsIn, contradictions } = require('./review');
const { maskText } = require('./conversations');
const { memStore } = require('./sandbox');

after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

test('analytics: routes, tool success, handoffs (incl. flow handoff steps), fallbacks, top questions', () => {
  const rows = [
    { route: 'knowledge', message: 'Best time to visit?', fallback: 0, trace_json: '{}', reply_json: '{}' },
    { route: 'knowledge', message: 'best time to visit', fallback: 0, trace_json: '{}', reply_json: '{}' },
    { route: 'live_search', message: 'hotels praslin', fallback: 0, trace_json: JSON.stringify({ tools: [{ tool: 'hotels.search', ok: true }, { tool: 'hotels.search', ok: false }] }), reply_json: '{}' },
    { route: 'handoff', message: 'talk to a person', fallback: 0, trace_json: '{}', reply_json: '{}' },
    { route: 'flow', message: 'Contact', fallback: 0, trace_json: JSON.stringify({ flow: { flow: 'contact', handoff: true } }), reply_json: '{}' },
    { route: 'knowledge', message: 'why', fallback: 1, trace_json: '{}', reply_json: '{}' },
  ];
  const s = summarizeTraces(rows);
  assert.equal(s.turns, 6);
  assert.equal(s.routes[0].route, 'knowledge');
  assert.deepEqual(s.tools[0], { tool: 'hotels.search', calls: 2, ok: 1, successRate: 0.5 });
  assert.equal(s.handoffs, 2);
  assert.equal(s.fallbacks, 1);
  assert.deepEqual(s.topQuestions[0], { question: 'Best time to visit?', count: 2 });
  assert.equal(normalizeQuestion('Vallée de Mai?!'), 'vallee de mai');
});

test('analytics: CSV quoting and a gap-free day list', () => {
  assert.equal(toCsv([{ q: 'Hi, "there"', n: 2 }], [{ key: 'q', label: 'Question' }, { key: 'n', label: 'Count' }]), 'Question,Count\r\n"Hi, ""there""",2');
  const d = daysBack(3, new Date('2026-10-17T10:00:00Z'));
  assert.deepEqual(d, ['2026-10-15', '2026-10-16', '2026-10-17']);
});

test('tests: a case needs a message and at least one check', () => {
  assert.throws(() => cleanCase({ message: '' }), /visitor message/);
  assert.throws(() => cleanCase({ message: 'hi', expect: {} }), /at least one check/);
  assert.deepEqual(cleanCase({ message: 'hi', expect: { include: 'a | b', minCards: '2' } }).expect, { include: ['a', 'b'], minCards: 2 });
});

test('tests: evaluate route, product (state or flow), cards, include/exclude, no price', () => {
  const out = { reply: { text: 'Here are hotels on Praslin from €120.', cards: [{}, {}] }, trace: { route: 'flow', flow: { flow: 'hotels' } }, state: {} };
  const ok = evaluate({ route: 'flow', product: 'hotels', minCards: 2, include: ['praslin'], exclude: ['booking.com'] }, out);
  assert.equal(ok.pass, true);
  const bad = evaluate({ noPrice: true, minCards: 3, exclude: ['hotels'] }, out);
  assert.equal(bad.pass, false);
  assert.deepEqual(bad.checks.map((c) => c.pass), [false, false, false]);
  assert.match(bad.checks[2].detail, /€120/);
});

test('review: unanswered turns — insufficient knowledge, fallback or "I don\'t have that information"; not flows', () => {
  assert.equal(unanswered({ route: 'knowledge', trace_json: JSON.stringify({ retrieval: { insufficient: true } }) }), true);
  assert.equal(unanswered({ route: 'knowledge', fallback: 1 }), true);
  assert.equal(unanswered({ route: 'knowledge', reply_json: JSON.stringify({ text: "I don't have that information. I can connect you with our team." }) }), true);
  assert.equal(unanswered({ route: 'knowledge', reply_json: JSON.stringify({ text: 'April is calm.' }) }), false);
  assert.equal(unanswered({ route: 'flow', fallback: 1 }), false);
});

test('review: clustering groups the same meaning, most asked first', () => {
  const v = (x, y) => Float32Array.from([x, y]);
  const c = cluster([
    { text: 'is there a casino', count: 1, vector: v(1, 0.05) },
    { text: 'casino in seychelles?', count: 3, vector: v(1, 0) },
    { text: 'can I rent a scooter', count: 2, vector: v(0, 1) },
  ]);
  assert.equal(c.length, 2);
  assert.deepEqual([c[0].question, c[0].hits, c[0].samples.length], ['casino in seychelles?', 4, 2]);
});

test('review: conflicts need the same unit with no value in common', () => {
  assert.deepEqual([...factsIn('The ferry takes about 15 minutes; 1,500 km away; on 29 June.').minutes], ['15']);
  assert.deepEqual(contradictions('Praslin to La Digue takes 15 minutes.', 'The La Digue ferry takes 30 minutes.'), [{ unit: 'minutes', a: ['15'], b: ['30'] }]);
  assert.deepEqual(contradictions('Takes 15 minutes or 20 minutes.', 'About 15 minutes.'), []);
  assert.deepEqual(contradictions('115 islands', 'about 30 minutes'), []);
});

test('conversations: visitor details masked, our own contact details kept', () => {
  assert.equal(maskText('Mail me at jo@example.com or call +44 7700 900123. Ours: +248 437 6666, info@holidays-seychelles.com'), 'Mail me at [email] or call [phone]. Ours: +248 437 6666, info@holidays-seychelles.com');
});

test('sandbox: the in-memory store keeps sessions per visitor and messages in order', async () => {
  const s = memStore();
  const a = await s.createSession({ visitorId: 'v1' });
  assert.equal(await s.getSession({ id: a.id, visitorId: 'v2' }), null);
  await s.addMessage({ sessionId: a.id, role: 'user', content: 'hi' });
  const id2 = await s.addMessage({ sessionId: a.id, role: 'assistant', content: 'hello' });
  assert.deepEqual((await s.messages(a.id)).map((m) => m.content), ['hi', 'hello']);
  assert.deepEqual((await s.messages(a.id, { afterId: id2 - 1 })).map((m) => m.content), ['hello']);
  await s.saveSession({ ...a, language: 'fr' }, { turnAdded: true });
  assert.equal((await s.getSession({ id: a.id, visitorId: 'v1' })).language, 'fr');
});

test('tests: include/exclude ignore no-break spaces and hyphen variants', () => {
  const out = { reply: { text: 'Call +248\u00a0437\u202f6666 or try the Semi\u2011Submarine Tour.' }, trace: {}, state: {} };
  assert.equal(evaluate({ include: ['+248 437 6666', 'semi-submarine'] }, out).pass, true);
});

test('monitor: alerts only on real failure rates, never on small samples', () => {
  const { evaluateHealth } = require('../monitor');
  assert.deepEqual(evaluateHealth({ calls: 4, errors: 4, toolCalls: 2, toolFails: 2, turns: 3, fallbacks: 3 }), []);
  const p = evaluateHealth({ calls: 20, errors: 6, toolCalls: 10, toolFails: 1, turns: 10, fallbacks: 4 });
  assert.deepEqual(p.map((x) => x.kind), ['llm', 'fallback']);
});
