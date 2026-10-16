/**
 * The one HTTP transport for TourVisio (service.espacelimited.com).
 *
 * That host intermittently drops new TCP connections: from this network roughly
 * one connect in two never completes and hangs until a timeout, while a
 * connection that does open answers in about a second. Plain `fetch` turned
 * every dropped connect into a 10-20s wait followed by "fetch failed", which the
 * site showed as "The hotel supplier is temporarily unavailable".
 *
 * So:
 *   - Sockets are kept alive and reused, so most requests skip the handshake
 *     that is what fails.
 *   - A connect that has not completed in CONNECT_TIMEOUT_MS is abandoned and
 *     retried on a fresh socket. Nothing was sent on it, so this is safe for
 *     every request, bookings and payments included.
 *   - Only reads (search, info, offers, autocomplete, currencies, login) are
 *     retried after the request was sent. A booking or payment call that reached
 *     the supplier is never sent twice: it may already have been processed.
 */

const https = require('https');
const http = require('http');

const CONNECT_TIMEOUT_MS = 3000; // a good connect+TLS takes ~0.6s
const RESPONSE_TIMEOUT_MS = 90000; // pricesearch alone has taken 30s+
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [300, 700, 1200];
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const agents = {
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 24, maxFreeSockets: 8, timeout: 60000 }),
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 24, maxFreeSockets: 8, timeout: 60000 }),
};
// Bookings and payments always open their own connection. A pooled socket the
// server has quietly closed fails *after* the request may have gone out, and
// such a request must not be repeated; a fresh connect fails before anything
// is sent, so it can be.
const freshAgents = {
  'https:': new https.Agent({ keepAlive: false }),
  'http:': new http.Agent({ keepAlive: false }),
};

/** Paths that only read, so a retry after sending cannot do anything twice. */
function isReadPath(url) {
  const path = new URL(url).pathname.toLowerCase();
  return (
    path.startsWith('/api/productservice/') ||
    path.startsWith('/api/commonservice/') ||
    path === '/api/authenticationservice/login'
  );
}

function fail(message, { name = 'Error', code, phase }) {
  const err = new Error(message);
  err.name = name;
  if (code) err.code = code;
  err.phase = phase; // 'connect' = nothing was sent; 'response' = it may have been
  return err;
}

/** One attempt. Resolves { status, contentType, text }; rejects with err.phase set. */
function requestOnce(url, { method = 'GET', headers = {}, body } = {}, { connectTimeout = CONNECT_TIMEOUT_MS, timeout = RESPONSE_TIMEOUT_MS, fresh = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload) finalHeaders['Content-Length'] = payload.length;

    let connected = false;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      fn(value);
    };

    const req = lib.request(target, { method, headers: finalHeaders, agent: (fresh ? freshAgents : agents)[target.protocol] });

    const connectTimer = setTimeout(() => {
      if (connected) return;
      req.destroy(fail('TourVisio connect timed out', { code: 'ECONNECT_TIMEOUT', phase: 'connect' }));
    }, connectTimeout);
    const totalTimer = setTimeout(() => {
      req.destroy(fail('TourVisio took too long to respond', { name: 'TimeoutError', phase: connected ? 'response' : 'connect' }));
    }, timeout);

    req.on('socket', (socket) => {
      // A reused keep-alive socket is already connected.
      if (!socket.connecting) connected = true;
      else socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; });
    });

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        done(resolve, {
          status: res.statusCode,
          contentType: res.headers['content-type'] || 'application/json',
          text: Buffer.concat(chunks).toString('utf8'),
        })
      );
      res.on('error', (e) => done(reject, Object.assign(e, { phase: 'response' })));
      res.on('aborted', () => done(reject, fail('TourVisio response aborted', { code: 'ECONNRESET', phase: 'response' })));
    });

    req.on('error', (e) => {
      if (!e.phase) e.phase = connected ? 'response' : 'connect';
      done(reject, e);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Send a request to TourVisio with the retry rules above.
 * options: { method, headers, body }   opts: { readOnly?, requestImpl?, delay? }
 */
async function tourvisioRequest(url, options = {}, opts = {}) {
  const readOnly = opts.readOnly ?? isReadPath(url);
  const requestImpl = opts.requestImpl || requestOnce;
  const delay = opts.delay || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const last = attempt + 1 === MAX_ATTEMPTS;
    try {
      const result = await requestImpl(url, options, { fresh: !readOnly });
      if (readOnly && RETRYABLE_STATUS.has(result.status) && !last) {
        await delay(BACKOFF_MS[attempt] || 1200);
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      const safeToRetry = err.phase === 'connect' || readOnly;
      if (!safeToRetry || last) break;
      await delay(BACKOFF_MS[attempt] || 1200);
    }
  }
  throw lastError;
}

module.exports = { tourvisioRequest, requestOnce, isReadPath, MAX_ATTEMPTS };
