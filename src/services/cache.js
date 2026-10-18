/**
 * One cache for the whole backend (extra track 2.5).
 *
 *   REDIS_URL set   → Redis (shared by every Node process, survives restarts)
 *   otherwise       → in-memory LRU in this process (still fast; lost on restart)
 *
 * If Redis is set but unreachable, calls fall back to memory and retry Redis
 * a minute later — the site never fails because the cache is down.
 *
 *   await cache.get(key)                → value | null
 *   await cache.set(key, value, ttlSec)
 *   await cache.del(key) / delPrefix(prefix)
 *   await cache.wrap(key, ttlSec, fn)   → cached value, or fn() stored when it is cacheable
 *   cache.stats()                       → { backend, hits, misses, sets, size, … }
 *
 * Values are JSON. Keys are namespaced with CACHE_PREFIX (default "hs:").
 */

const PREFIX = process.env.CACHE_PREFIX || 'hs:';
const MEM_MAX_ENTRIES = Number(process.env.CACHE_MEMORY_MAX_ENTRIES) || 3000;
const MEM_MAX_BYTES = (Number(process.env.CACHE_MEMORY_MAX_MB) || 64) * 1024 * 1024;

const counters = { hits: 0, misses: 0, sets: 0, errors: 0 };

// ── Memory LRU ────────────────────────────────────────────────────────────────
const mem = new Map(); // key → { exp, text, bytes }  (Map keeps insertion order = LRU order)
let memBytes = 0;

function memGet(key) {
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(key); memBytes -= e.bytes; return null; }
  mem.delete(key); // refresh LRU position
  mem.set(key, e);
  return e.text;
}

function memSet(key, text, ttlSec) {
  const old = mem.get(key);
  if (old) { mem.delete(key); memBytes -= old.bytes; }
  const bytes = text.length * 2;
  if (bytes > MEM_MAX_BYTES / 4) return; // one huge value never evicts everything
  mem.set(key, { exp: ttlSec ? Date.now() + ttlSec * 1000 : 0, text, bytes });
  memBytes += bytes;
  while (mem.size > MEM_MAX_ENTRIES || memBytes > MEM_MAX_BYTES) {
    const [k, e] = mem.entries().next().value;
    mem.delete(k);
    memBytes -= e.bytes;
  }
}

function memDel(key) {
  const e = mem.get(key);
  if (e) { mem.delete(key); memBytes -= e.bytes; }
}

// ── Redis (optional) ──────────────────────────────────────────────────────────
let redis = null; // connected client
let connecting = null;
let downUntil = 0;
let lastError = null;

async function client() {
  if (!process.env.REDIS_URL || Date.now() < downUntil) return null;
  if (redis?.isReady) return redis;
  if (!connecting) {
    connecting = (async () => {
      let createClient;
      try {
        ({ createClient } = require('redis')); // eslint-disable-line global-require
      } catch {
        lastError = 'The "redis" package is not installed (run npm install).';
        downUntil = Date.now() + 10 * 60 * 1000;
        return null;
      }
      const c = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 3000, reconnectStrategy: false } });
      c.on('error', (err) => { lastError = err.message; });
      try {
        await c.connect();
        redis = c;
        lastError = null;
        return c;
      } catch (err) {
        lastError = err.message;
        downUntil = Date.now() + 60 * 1000; // memory for a minute, then try again
        c.disconnect().catch(() => {});
        return null;
      }
    })().finally(() => { connecting = null; });
  }
  return connecting;
}

/** A Redis command that failed: count it, use memory for a minute. */
function redisFailed(err) {
  counters.errors += 1;
  lastError = err.message;
  downUntil = Date.now() + 60 * 1000;
  try { redis?.disconnect(); } catch { /* already closed */ }
  redis = null;
}

// ── API ───────────────────────────────────────────────────────────────────────
async function get(key) {
  const k = PREFIX + key;
  let text = null;
  const r = await client();
  if (r) {
    try { text = await r.get(k); } catch (err) { redisFailed(err); text = memGet(k); }
  } else text = memGet(k);
  if (text === null || text === undefined) { counters.misses += 1; return null; }
  counters.hits += 1;
  try { return JSON.parse(text); } catch { return null; }
}

async function set(key, value, ttlSec = 300) {
  const k = PREFIX + key;
  const text = JSON.stringify(value);
  counters.sets += 1;
  const r = await client();
  if (r) {
    try {
      await (ttlSec ? r.set(k, text, { EX: Math.max(1, Math.round(ttlSec)) }) : r.set(k, text));
      return;
    } catch (err) { redisFailed(err); }
  }
  memSet(k, text, ttlSec);
}

async function del(key) {
  const k = PREFIX + key;
  memDel(k);
  const r = await client();
  if (r) await r.del(k).catch(redisFailed);
}

async function delPrefix(prefix) {
  const p = PREFIX + prefix;
  for (const k of [...mem.keys()]) if (k.startsWith(p)) memDel(k);
  const r = await client();
  if (!r) return;
  try {
    for await (const keys of r.scanIterator({ MATCH: `${p}*`, COUNT: 200 })) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.length) await r.del(list);
    }
  } catch (err) { redisFailed(err); }
}

/**
 * Cached call. fn's result is stored only when `cacheable(result)` is true
 * (default: any non-null result) — errors and failed responses never are.
 * Concurrent misses for the same key share one fn() call.
 */
const inflight = new Map();
async function wrap(key, ttlSec, fn, { cacheable = (v) => v !== null && v !== undefined } = {}) {
  const hit = await get(key);
  if (hit !== null) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const v = await fn();
    if (cacheable(v)) await set(key, v, ttlSec).catch(() => {});
    return v;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function stats() {
  const total = counters.hits + counters.misses;
  return {
    backend: redis?.isReady ? 'redis' : 'memory',
    redisConfigured: Boolean(process.env.REDIS_URL),
    redisError: process.env.REDIS_URL ? lastError : null,
    ...counters,
    hitRate: total ? Number((counters.hits / total).toFixed(3)) : null,
    memoryEntries: mem.size,
    memoryMb: Number((memBytes / 1024 / 1024).toFixed(2)),
  };
}

async function close() {
  if (redis) await redis.quit().catch(() => {});
  redis = null;
}

/** For tests: forget everything in memory. */
function _resetMemory() {
  mem.clear();
  memBytes = 0;
  Object.keys(counters).forEach((k) => { counters[k] = 0; });
}

module.exports = { get, set, del, delPrefix, wrap, stats, close, _resetMemory };
