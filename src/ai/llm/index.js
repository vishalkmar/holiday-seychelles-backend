/**
 * LLM gateway: the only place the module talks to NVIDIA (DESIGN.md §3.1).
 *
 *   chat({ messages, tools?, temperature?, maxTokens?, purpose?, sessionId? })
 *     → { text, toolCalls, finishReason, usage }
 *   chatStream({ …same, onToken })        → same result, streaming tokens as they arrive
 *   embed({ inputs, inputType: 'query' | 'passage' }) → { vectors: Float32Array[], dim, model }
 *   rerank({ query, passages: string[] })  → [{ index, score }] best first
 *   listModels()                           → [{ id, ownedBy }]
 *   testConnection()                       → { chat, embed } each { ok, latencyMs, … }
 *
 * Model names, limits and the key come from settings.js on every call, so a
 * change in AI Settings takes effect without a restart. Every call is logged to
 * rag_usage (tokens, latency, cost estimate) — never its text.
 */

const settingsStore = require('../settings');
const { request, LlmError } = require('./http');
const { createLimiter } = require('./limiter');
const { logUsage } = require('./usage');
const { estimateMessages, estimateTokens } = require('./tokens');

const limiter = createLimiter();
// Swapped by tests: HTTP, the settings source and the usage logger.
let transport = { fetchImpl: undefined, delay: undefined, settings: null, log: null };

function useTransport(t) {
  transport = { ...transport, ...t };
}

const effective = () => (transport.settings ? transport.settings() : settingsStore.getEffective());
const record = (entry) => (transport.log ? transport.log(entry) : logUsage(entry));

// Background indexing ('embed') may use only part of the per-minute limit, so a
// big import never starves visitors' chat; it waits for room instead of failing.
const BACKGROUND = new Set(['embed']);
const BACKGROUND_SHARE = 0.6;

async function prepare(purpose) {
  const s = await effective();
  if (!s.nvidiaApiKey) throw new LlmError('NOT_CONFIGURED', 'No NVIDIA API key is set. Add it in AI Settings or the backend .env.');
  if (BACKGROUND.has(purpose)) await limiter.take(Math.max(1, Math.floor(s.requestsPerMinute * BACKGROUND_SHARE)), 65000);
  else await limiter.take(s.requestsPerMinute);
  return s;
}

async function timed(purpose, model, s, sessionId, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    record({ sessionId, purpose, model, tokensIn: out.usage?.prompt_tokens || 0, tokensOut: out.usage?.completion_tokens || 0, latencyMs: Date.now() - t0, settings: s });
    return { ...out, latencyMs: Date.now() - t0 };
  } catch (err) {
    record({ sessionId, purpose, model, latencyMs: Date.now() - t0, ok: false, errorCode: err.code || 'ERROR', settings: s });
    throw err;
  }
}

function chatBody(s, model, { messages, tools, temperature, maxTokens, stream }) {
  return {
    model,
    messages,
    temperature: temperature ?? s.temperature,
    max_tokens: maxTokens ?? s.maxTokens,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

/** Reasoning models may wrap their thinking in <think>…</think> inside content. */
function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function parseChoice(json) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  return {
    text: stripThinking(msg.content),
    toolCalls: (msg.tool_calls || []).map((c) => {
      let args = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = { _raw: c.function?.arguments }; }
      return { id: c.id, name: c.function?.name, args };
    }),
    finishReason: choice.finish_reason || null,
  };
}

// ── Fallback chain ───────────────────────────────────────────────────────────
// The chat model, then each fallback in order. A model that fails in a way
// another model could survive (timeout, not on this account, quota, server
// error, a request it can't handle such as tools, or an empty answer) hands
// over to the next. AUTH and NOT_CONFIGURED stop at once: every model would
// fail the same way.
const FALLBACK_ON = new Set(['TIMEOUT', 'MODEL', 'QUOTA', 'UNAVAILABLE', 'BAD_REQUEST', 'EMPTY']);

function chain(s, only) {
  if (only) return [only];
  return [s.chatModel, ...(Array.isArray(s.chatFallbackModels) ? s.chatFallbackModels : [])].filter(
    (m, i, all) => m && all.indexOf(m) === i
  );
}

async function withFallback(s, models, run) {
  const failures = [];
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const isLast = i === models.length - 1;
    try {
      // A model with a fallback behind it gets a shorter wait and no same-model retry.
      // eslint-disable-next-line no-await-in-loop
      const out = await run(model, {
        timeoutMs: isLast ? s.timeoutMs : Math.min(s.timeoutMs, s.fallbackAfterMs || s.timeoutMs),
        retries: isLast ? 1 : 0,
      });
      return { ...out, model, fallbackUsed: i > 0, failures };
    } catch (err) {
      failures.push({ model, code: err.code || 'ERROR', message: err.message });
      if (!FALLBACK_ON.has(err.code) || isLast) {
        err.failures = failures;
        throw err;
      }
    }
  }
  throw new LlmError('UNAVAILABLE', 'No chat model is configured.');
}

/**
 * opts.model forces one model with no fallback (used by "Test model").
 * The result says which model answered and whether a fallback was needed.
 */
async function chat({ messages, tools, temperature, maxTokens, purpose = 'chat', sessionId = null, model: only }) {
  const s = await prepare();
  return withFallback(s, chain(s, only), (model, { timeoutMs, retries }) =>
    timed(purpose, model, s, sessionId, async () => {
      const json = await request({ url: `${s.baseUrl}/chat/completions`, apiKey: s.nvidiaApiKey, body: chatBody(s, model, { messages, tools, temperature, maxTokens }), timeoutMs, retries }, transport);
      const parsed = parseChoice(json);
      // A reasoning model that ran out of tokens while thinking returns no answer.
      if (!parsed.text && !parsed.toolCalls.length) {
        throw new LlmError('EMPTY', `${model} returned no answer${parsed.finishReason === 'length' ? ' (ran out of tokens while reasoning)' : ''}.`);
      }
      return { ...parsed, usage: json.usage || { prompt_tokens: estimateMessages(messages), completion_tokens: 0 } };
    })
  );
}

/**
 * Streams text deltas to onToken; resolves with the full text and usage.
 * Falls back to the next model only if a model fails before its first token —
 * once text has reached the visitor, switching models mid-answer would garble it.
 */
async function chatStream({ messages, temperature, maxTokens, onToken = () => {}, purpose = 'chat', sessionId = null, model: only }) {
  const s = await prepare();
  return withFallback(s, chain(s, only), (model, { timeoutMs, retries }) =>
    timed(purpose, model, s, sessionId, async () => {
      const res = await request({ url: `${s.baseUrl}/chat/completions`, apiKey: s.nvidiaApiKey, body: chatBody(s, model, { messages, temperature, maxTokens, stream: true }), timeoutMs, retries, stream: true }, transport);
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      let usage = null;
      let finishReason = null;
      let thinking = false;
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let evt;
            try { evt = JSON.parse(data); } catch { continue; } // partial or keep-alive line
            let delta = evt.choices?.[0]?.delta?.content || '';
            // Hide inline <think> blocks from the visitor.
            if (delta.includes('<think>')) { thinking = true; delta = delta.split('<think>')[0]; }
            if (thinking && delta.includes('</think>')) { thinking = false; delta = delta.split('</think>').pop(); } else if (thinking) { delta = ''; }
            if (delta) {
              text += delta;
              onToken(delta);
            }
            finishReason = evt.choices?.[0]?.finish_reason || finishReason;
            if (evt.usage) usage = evt.usage;
          }
        }
      } catch (err) {
        // A stream that breaks after text was sent is not retried on another model.
        if (text) return { text, toolCalls: [], finishReason: 'interrupted', usage: usage || { prompt_tokens: estimateMessages(messages), completion_tokens: estimateTokens(text) } };
        if (err instanceof LlmError) throw err;
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new LlmError(timedOut ? 'TIMEOUT' : 'UNAVAILABLE', timedOut ? 'The AI service took too long to answer.' : 'The AI stream broke off.', { detail: err?.message });
      }
      if (!text.trim()) throw new LlmError('EMPTY', `${model} returned no answer.`);
      return {
        text,
        toolCalls: [],
        finishReason,
        usage: usage || { prompt_tokens: estimateMessages(messages), completion_tokens: estimateTokens(text) },
      };
    })
  );
}

async function embed({ inputs, inputType = 'passage', purpose = 'embed', sessionId = null }) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).map((t) => String(t ?? ''));
  if (!list.length) return { vectors: [], dim: 0, model: null };
  const s = await prepare(purpose);
  const vectors = [];
  let dim = 0;
  for (let i = 0; i < list.length; i += s.embedBatchSize) {
    const batch = list.slice(i, i + s.embedBatchSize);
    // eslint-disable-next-line no-await-in-loop
    const out = await timed(purpose, s.embedModel, s, sessionId, async () => {
      const json = await request({
        url: `${s.baseUrl}/embeddings`,
        apiKey: s.nvidiaApiKey,
        body: { model: s.embedModel, input: batch, input_type: inputType, encoding_format: 'float', truncate: 'END' },
        timeoutMs: s.timeoutMs,
      }, transport);
      return { data: json.data || [], usage: { prompt_tokens: json.usage?.prompt_tokens || json.usage?.total_tokens || 0, completion_tokens: 0 } };
    });
    const sorted = [...out.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const row of sorted) {
      const v = Float32Array.from(row.embedding || []);
      dim = dim || v.length;
      if (v.length !== dim) throw new LlmError('MODEL', `Embedding size changed mid-batch (${v.length} vs ${dim}).`);
      vectors.push(v);
    }
  }
  if (vectors.length !== list.length) throw new LlmError('UNAVAILABLE', `Expected ${list.length} embeddings, got ${vectors.length}.`);
  return { vectors, dim, model: s.embedModel };
}

async function rerank({ query, passages, purpose = 'rerank', sessionId = null }) {
  const s = await prepare();
  if (!s.rerankEnabled) return passages.map((_, index) => ({ index, score: 0 }));
  const out = await timed(purpose, s.rerankModel, s, sessionId, async () => {
    const json = await request({
      url: s.rerankUrl,
      apiKey: s.nvidiaApiKey,
      body: { model: s.rerankModel, query: { text: String(query) }, passages: passages.map((p) => ({ text: String(p) })) },
      timeoutMs: s.timeoutMs,
    }, transport);
    return { rankings: json.rankings || [], usage: { prompt_tokens: estimateTokens(query) + passages.reduce((n, p) => n + estimateTokens(p), 0), completion_tokens: 0 } };
  });
  return out.rankings.map((r) => ({ index: r.index, score: Number(r.logit ?? r.score ?? 0) })).sort((a, b) => b.score - a.score);
}

async function listModels() {
  const s = await effective();
  if (!s.nvidiaApiKey) throw new LlmError('NOT_CONFIGURED', 'No NVIDIA API key is set.');
  const json = await request({ url: `${s.baseUrl}/models`, method: 'GET', apiKey: s.nvidiaApiKey, timeoutMs: s.timeoutMs }, transport);
  return (json.data || []).map((m) => ({ id: m.id, ownedBy: m.owned_by || '' })).sort((a, b) => a.id.localeCompare(b.id));
}

const TEST_PROMPT = [{ role: 'user', content: 'In one short sentence: what is the capital of Seychelles?' }];

/** One real call to one model, no fallback: { ok, latencyMs, reply | dim, code?, message? }. */
async function testModel({ model, kind = 'chat' }) {
  const t0 = Date.now();
  try {
    if (kind === 'embed') {
      const s = await prepare();
      const json = await request({ url: `${s.baseUrl}/embeddings`, apiKey: s.nvidiaApiKey, body: { model, input: ['Seychelles'], input_type: 'query', encoding_format: 'float', truncate: 'END' }, timeoutMs: s.timeoutMs, retries: 0 }, transport);
      return { model, ok: true, latencyMs: Date.now() - t0, dim: json.data?.[0]?.embedding?.length || 0 };
    }
    const r = await chat({ messages: TEST_PROMPT, temperature: 0, purpose: 'test', model });
    return { model, ok: true, latencyMs: r.latencyMs, reply: r.text.slice(0, 80) };
  } catch (err) {
    return { model, ok: false, latencyMs: Date.now() - t0, code: err.code || 'ERROR', message: err.message, detail: err.detail };
  }
}

/** Every chat model in the chain (one by one) plus the embedding model. */
async function testConnection() {
  const s = await effective();
  const chatResults = [];
  for (const model of chain(s)) {
    // eslint-disable-next-line no-await-in-loop
    chatResults.push(await testModel({ model }));
  }
  const embedResult = await testModel({ model: s.embedModel, kind: 'embed' });
  return { chat: chatResults, embed: embedResult, ok: chatResults.some((c) => c.ok) && embedResult.ok };
}

module.exports = { chat, chatStream, embed, rerank, listModels, testConnection, testModel, useTransport, LlmError };
