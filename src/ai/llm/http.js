/**
 * HTTP for the NVIDIA (OpenAI-compatible) API: timeout, one retry, and errors
 * mapped to codes the admin and the chat widget can act on.
 *
 * Retried once with jitter: 429 and 5xx and network failures. Never retried:
 * 400/401/403/404 — those will not fix themselves.
 */

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

class LlmError extends Error {
  constructor(code, message, { status, detail } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code; // AUTH | QUOTA | MODEL | BAD_REQUEST | TIMEOUT | UNAVAILABLE | NOT_CONFIGURED
    this.status = status;
    this.detail = detail;
  }
}

function errorFor(status, bodyText) {
  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    detail = j?.error?.message || j?.detail || j?.message || j?.title || '';
  } catch {
    detail = String(bodyText || '').slice(0, 300);
  }
  if (status === 401 || status === 403) return new LlmError('AUTH', 'The NVIDIA API key was rejected. Check or replace it in AI Settings.', { status, detail });
  if (status === 429) return new LlmError('QUOTA', 'The NVIDIA rate limit or free quota was reached. Try again shortly.', { status, detail });
  if (status === 404) return new LlmError('MODEL', 'That model is not available on this NVIDIA account. Pick another in AI Settings.', { status, detail });
  if (status === 400 || status === 422) return new LlmError('BAD_REQUEST', `NVIDIA refused the request: ${detail || 'bad request'}`, { status, detail });
  return new LlmError('UNAVAILABLE', 'The AI service is temporarily unavailable.', { status, detail });
}

/**
 * request({ url, method, apiKey, body, timeoutMs, stream }) → Response (stream)
 * or parsed JSON. opts: { fetchImpl, delay } for tests.
 */
async function request({ url, method = 'POST', apiKey, body, timeoutMs = 30000, stream = false, retries = 1 }, opts = {}) {
  if (!apiKey) throw new LlmError('NOT_CONFIGURED', 'No NVIDIA API key is set.');
  const fetchImpl = opts.fetchImpl || fetch;
  const delay = opts.delay || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastErr;
  const attempts = 1 + Math.max(0, retries);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const last = attempt === attempts - 1;
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: stream ? 'text/event-stream' : 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // `await`, so a timeout while the body is still arriving is caught below
      // and becomes TIMEOUT (which falls back to the next model) — not a raw DOMException.
      if (res.ok) return stream ? res : await res.json();
      const text = await res.text().catch(() => '');
      lastErr = errorFor(res.status, text);
      if (!RETRY_STATUS.has(res.status) || last) throw lastErr;
    } catch (err) {
      if (err instanceof LlmError) {
        if (!RETRY_STATUS.has(err.status) || last) throw err;
        lastErr = err;
      } else {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        lastErr = new LlmError(timedOut ? 'TIMEOUT' : 'UNAVAILABLE',
          timedOut ? 'The AI service took too long to answer.' : 'Could not reach the AI service.', { detail: err?.message });
        if (last) throw lastErr;
      }
    }
    await delay(400 + Math.floor(Math.random() * 600));
  }
  throw lastErr;
}

module.exports = { request, LlmError, errorFor };
