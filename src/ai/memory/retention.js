/**
 * Retention (D9): once a day, delete chat sessions and messages whose
 * retention period (CHAT_RETENTION_DAYS, default 90, counted from the last
 * message) has passed. Expired slots go with their session; stale dates and
 * results are also dropped whenever a session is resumed (slots.expire).
 */

const store = require('./store');

const DAY_MS = 24 * 60 * 60 * 1000;
let timer = null;

async function runOnce() {
  try {
    const r = await store.purgeExpired();
    if (r.sessions) console.log(`[ai] chat retention: removed ${r.sessions} expired conversation(s)`);
    return r;
  } catch (err) {
    console.error('[ai] chat retention failed:', err.message);
    return { error: err.message };
  }
}

function start() {
  if (timer || process.env.RAG_WORKER_ENABLED === 'false') return;
  // First run a minute after boot (not during start-up), then daily.
  setTimeout(runOnce, 60 * 1000).unref?.();
  timer = setInterval(runOnce, DAY_MS);
  timer.unref?.();
}

module.exports = { start, runOnce };
