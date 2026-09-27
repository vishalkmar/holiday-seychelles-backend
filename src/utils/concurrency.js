/**
 * Bounded parallelism.
 *
 * `Promise.all` over a dozen queries asks the pool for a dozen connections at
 * once. The pool holds ten, so the extras queue — and against a remote host
 * that drops idle connections, a queued acquire times out rather than waits.
 * The failure looks like a flaky database; it is actually self-inflicted
 * contention.
 *
 * Analytics endpoints should run their queries through here instead.
 */

const DEFAULT_LIMIT = Number(process.env.DB_QUERY_CONCURRENCY || 4);

/**
 * Run thunks with at most `limit` in flight, preserving result order.
 * Each entry must be a function returning a promise, so nothing starts early.
 */
async function runLimited(thunks, limit = DEFAULT_LIMIT) {
  const results = new Array(thunks.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= thunks.length) return;
      results[index] = await thunks[index]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, thunks.length) }, () => worker())
  );

  return results;
}

module.exports = { runLimited, DEFAULT_LIMIT };
