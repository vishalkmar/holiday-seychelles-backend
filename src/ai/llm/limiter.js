/**
 * A sliding one-minute window for outgoing model calls, so a burst of visitors
 * (or an ingestion job) cannot burn through the NVIDIA rate limit and get the
 * whole site locked out. Callers over the limit wait briefly, then fail with
 * QUOTA rather than queueing forever.
 */

const { LlmError } = require('./http');

function createLimiter({ now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const stamps = [];

  async function take(perMinute, maxWaitMs = 5000) {
    const deadline = now() + maxWaitMs;
    for (;;) {
      const t = now();
      while (stamps.length && t - stamps[0] >= 60000) stamps.shift();
      if (stamps.length < perMinute) {
        stamps.push(t);
        return;
      }
      const wait = 60000 - (t - stamps[0]) + 5;
      if (t + wait > deadline) {
        throw new LlmError('QUOTA', 'Too many AI requests right now. Please try again in a moment.');
      }
      await sleep(wait);
    }
  }

  return { take, size: () => stamps.length };
}

module.exports = { createLimiter };
