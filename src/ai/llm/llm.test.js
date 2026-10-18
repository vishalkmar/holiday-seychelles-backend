const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const llm = require('./index');
const { request } = require('./http');
const { createLimiter } = require('./limiter');
const { estimateTokens, trimToTokens } = require('./tokens');
const { encrypt, decrypt, mask } = require('../secrets');
const { clean } = require('../settings');

// Requiring the gateway loads ports, which creates (but never uses) the MySQL pool.
after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

const SETTINGS = {
  nvidiaApiKey: 'nvapi-test-key-0000000000000000',
  baseUrl: 'https://nv.test/v1',
  chatModel: 'test/chat',
  embedModel: 'test/embed',
  rerankModel: 'test/rerank',
  rerankUrl: 'https://nv.test/rerank',
  rerankEnabled: true,
  temperature: 0.2,
  maxTokens: 100,
  timeoutMs: 5000,
  requestsPerMinute: 10000,
  embedBatchSize: 2,
};

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const logs = [];

function use(fetchImpl, settings = SETTINGS) {
  logs.length = 0;
  llm.useTransport({ fetchImpl, delay: async () => {}, settings: async () => settings, log: (e) => logs.push(e) });
}

test('chat: sends model + messages, parses text, tool calls and usage, logs tokens', async () => {
  let sent;
  use(async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return json(200, {
      choices: [{ finish_reason: 'tool_calls', message: { content: 'Hi', tool_calls: [{ id: 't1', function: { name: 'hotels.search', arguments: '{"island":"praslin"}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
  });
  const r = await llm.chat({ messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function' }] });
  assert.equal(sent.url, 'https://nv.test/v1/chat/completions');
  assert.equal(sent.body.model, 'test/chat');
  assert.equal(sent.body.tool_choice, 'auto');
  assert.match(sent.auth, /^Bearer nvapi-/);
  assert.equal(r.text, 'Hi');
  assert.deepEqual(r.toolCalls[0], { id: 't1', name: 'hotels.search', args: { island: 'praslin' } });
  assert.equal(logs[0].tokensIn, 12);
  assert.equal(logs[0].purpose, 'chat');
});

test('retries once on 429, then succeeds', async () => {
  let calls = 0;
  use(async () => (++calls === 1 ? json(429, { detail: 'slow down' }) : json(200, { choices: [{ message: { content: 'ok' } }] })));
  const r = await llm.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(calls, 2);
  assert.equal(r.text, 'ok');
});

test('does not retry a rejected key, and maps it to AUTH', async () => {
  let calls = 0;
  use(async () => { calls++; return json(401, { detail: 'Unauthorized' }); });
  await assert.rejects(llm.chat({ messages: [{ role: 'user', content: 'x' }] }), (err) => err.code === 'AUTH');
  assert.equal(calls, 1);
  assert.equal(logs[0].ok, false);
  assert.equal(logs[0].errorCode, 'AUTH');
});

test('unknown model maps to MODEL; network failure maps to UNAVAILABLE after one retry', async () => {
  use(async () => json(404, { detail: 'Function not found' }));
  await assert.rejects(llm.chat({ messages: [] }), { code: 'MODEL' });
  let calls = 0;
  use(async () => { calls++; throw new TypeError('fetch failed'); });
  await assert.rejects(llm.chat({ messages: [] }), { code: 'UNAVAILABLE' });
  assert.equal(calls, 2);
});

test('timeout maps to TIMEOUT', async () => {
  await assert.rejects(
    request({ url: 'https://nv.test', apiKey: 'k', timeoutMs: 1000 }, { fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, delay: async () => {} }),
    { code: 'TIMEOUT' }
  );
});

test('no key → NOT_CONFIGURED without calling the API', async () => {
  let calls = 0;
  use(async () => { calls++; return json(200, {}); }, { ...SETTINGS, nvidiaApiKey: '' });
  await assert.rejects(llm.chat({ messages: [] }), { code: 'NOT_CONFIGURED' });
  assert.equal(calls, 0);
});

test('embed: batches by embedBatchSize, keeps input order, sets input_type, returns Float32 vectors', async () => {
  const bodies = [];
  use(async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    // Return rows out of order to prove they are re-sorted by index.
    const data = body.input.map((t, i) => ({ index: i, embedding: [t.length, i, 1] })).reverse();
    return json(200, { data, usage: { prompt_tokens: 5 } });
  });
  const r = await llm.embed({ inputs: ['a', 'bb', 'ccc'], inputType: 'query' });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].input_type, 'query');
  assert.equal(bodies[0].model, 'test/embed');
  assert.equal(r.dim, 3);
  assert.ok(r.vectors[0] instanceof Float32Array);
  assert.deepEqual(Array.from(r.vectors.map((v) => v[0])), [1, 2, 3]);
});

test('rerank: sorts by score; disabled rerank keeps the original order without a call', async () => {
  use(async () => json(200, { rankings: [{ index: 0, logit: -2 }, { index: 1, logit: 5 }] }));
  const r = await llm.rerank({ query: 'q', passages: ['a', 'b'] });
  assert.deepEqual(r.map((x) => x.index), [1, 0]);
  let calls = 0;
  use(async () => { calls++; return json(200, {}); }, { ...SETTINGS, rerankEnabled: false });
  const r2 = await llm.rerank({ query: 'q', passages: ['a', 'b'] });
  assert.deepEqual(r2.map((x) => x.index), [0, 1]);
  assert.equal(calls, 0);
});

test('chatStream: joins SSE deltas and reports each token', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n',
  ];
  use(async () => ({ ok: true, status: 200, body: (async function* () { for (const l of lines) yield new TextEncoder().encode(l); })() }));
  const tokens = [];
  const r = await llm.chatStream({ messages: [{ role: 'user', content: 'hi' }], onToken: (t) => tokens.push(t) });
  assert.equal(r.text, 'Hello');
  assert.deepEqual(tokens, ['Hel', 'lo']);
  assert.equal(r.finishReason, 'stop');
});

test('limiter: lets requests through under the limit and fails fast when the wait is too long', async () => {
  let t = 0;
  const lim = createLimiter({ now: () => t, sleep: async (ms) => { t += ms; } });
  await lim.take(2);
  await lim.take(2);
  await assert.rejects(lim.take(2, 1000), { code: 'QUOTA' });
  await lim.take(2, 70000); // waits for the window to roll
  assert.ok(t >= 60000);
});

test('limiter: background embeds stop at their share, chat still gets through', async () => {
  let t = 0;
  const lim = createLimiter({ now: () => t, sleep: async (ms) => { t += ms; } });
  for (let i = 0; i < 6; i += 1) await lim.take(6); // background share of 10
  await assert.rejects(lim.take(6, 1000), { code: 'QUOTA' });
  await lim.take(10); // a visitor's chat call is not blocked
  assert.equal(t, 0);
});

test('tokens: estimate and trim', () => {
  assert.ok(estimateTokens('Seychelles is lovely in October') >= 6);
  assert.ok(trimToTokens('word '.repeat(500), 10).length < 60);
});

test('secrets: encrypt/decrypt round trip, wrong key gives null, mask hides the middle', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const sealed = encrypt('nvapi-abcdef1234567890', key);
  assert.match(sealed, /^v1:/);
  assert.equal(decrypt(sealed, key), 'nvapi-abcdef1234567890');
  assert.equal(decrypt(sealed, Buffer.alloc(32, 8).toString('base64')), null);
  assert.equal(mask('nvapi-abcdef1234567890'), 'nvap••••••7890');
  assert.throws(() => encrypt('x', ''), { code: 'NO_SECRET_KEY' });
});

test('settings: clean() bounds numbers and rejects unknown keys', () => {
  assert.equal(clean('temperature', 9), 1.5);
  assert.equal(clean('maxTokens', '300.7'), 301);
  assert.equal(clean('rerankEnabled', 'true'), true);
  assert.throws(() => clean('chatModel', '  '), /empty/);
  assert.throws(() => clean('evil', 1), /Unknown/);
});

// ── Fallback chain ───────────────────────────────────────────────────────────
const CHAIN = { ...SETTINGS, chatModel: 'm/primary', chatFallbackModels: ['m/second', 'm/third'], fallbackAfterMs: 2000 };
const ok = (text) => json(200, { choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const modelOf = (init) => JSON.parse(init.body).model;

test('fallback: a timeout on the primary moves to the next model without retrying it', async () => {
  const tried = [];
  use(async (url, init) => {
    tried.push(modelOf(init));
    if (modelOf(init) === 'm/primary') { const e = new Error('slow'); e.name = 'TimeoutError'; throw e; }
    return ok('from second');
  }, CHAIN);
  const r = await llm.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(tried, ['m/primary', 'm/second']);
  assert.equal(r.text, 'from second');
  assert.equal(r.model, 'm/second');
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.failures[0].code, 'TIMEOUT');
});

test('fallback: 404 "not on this account" and empty answers both move on', async () => {
  const tried = [];
  use(async (url, init) => {
    const m = modelOf(init);
    tried.push(m);
    if (m === 'm/primary') return json(404, { detail: 'Function not found for account' });
    if (m === 'm/second') return json(200, { choices: [{ finish_reason: 'length', message: { content: '' } }] });
    return ok('third answers');
  }, CHAIN);
  const r = await llm.chat({ messages: [] });
  assert.deepEqual(tried, ['m/primary', 'm/second', 'm/third']);
  assert.equal(r.model, 'm/third');
  assert.deepEqual(r.failures.map((f) => f.code), ['MODEL', 'EMPTY']);
});

test('fallback: a rejected key stops at once (every model would fail the same way)', async () => {
  const tried = [];
  use(async (url, init) => { tried.push(modelOf(init)); return json(401, {}); }, CHAIN);
  await assert.rejects(llm.chat({ messages: [] }), (err) => err.code === 'AUTH' && err.failures.length === 1);
  assert.deepEqual(tried, ['m/primary']);
});

test('fallback: when every model fails, the last error is thrown with the full list', async () => {
  use(async () => json(503, {}), CHAIN);
  await assert.rejects(llm.chat({ messages: [] }), (err) => err.failures.map((f) => f.model).join() === 'm/primary,m/second,m/third');
});

test('forced model (Test button) uses only that model', async () => {
  const tried = [];
  use(async (url, init) => { tried.push(modelOf(init)); return json(503, {}); }, CHAIN);
  const r = await llm.testModel({ model: 'm/second' });
  assert.equal(r.ok, false);
  assert.ok(tried.every((m) => m === 'm/second'));
});

test('reasoning output: <think> blocks are removed from answers', async () => {
  use(async () => ok('<think>the user wants the capital</think>Victoria is the capital.'), CHAIN);
  const r = await llm.chat({ messages: [] });
  assert.equal(r.text, 'Victoria is the capital.');
});

test('stream: falls back before the first token; hides <think> while streaming', async () => {
  const frames = (parts) => ({ ok: true, status: 200, body: (async function* () { for (const p of parts) yield new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n`); })() });
  use(async (url, init) => (modelOf(init) === 'm/primary' ? json(503, {}) : frames(['<think>plan', '</think>Vic', 'toria'])), CHAIN);
  const tokens = [];
  const r = await llm.chatStream({ messages: [], onToken: (t) => tokens.push(t) });
  assert.equal(r.model, 'm/second');
  assert.equal(r.text, 'Victoria');
  assert.equal(tokens.join(''), 'Victoria');
});

test('settings: fallback list is cleaned, de-duplicated and capped', () => {
  assert.deepEqual(clean('chatFallbackModels', ' a/x , b/y,a/x,, '), ['a/x', 'b/y']);
  assert.equal(clean('chatFallbackModels', ['1', '2', '3', '4', '5', '6', '7']).length, 5);
});

test('a timeout while the response body is arriving is TIMEOUT (so the next model is tried), not a raw DOMException', async () => {
  const { request } = require('./http');
  const fetchImpl = async () => ({ ok: true, json: async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; e.code = 23; throw e; } });
  await assert.rejects(request({ url: 'x', apiKey: 'k', body: {}, retries: 0 }, { fetchImpl }), (e) => e.code === 'TIMEOUT');
});
