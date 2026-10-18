/**
 * Tables owned by the AI module.
 *
 * Each migration file is also applied lazily the first time the module needs
 * it, the same way the wishlist does, so a deploy that forgot `npm run migrate`
 * still works. CREATE TABLE IF NOT EXISTS makes this safe to repeat.
 */

const fs = require('fs');
const path = require('path');
const { db } = require('./ports');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/** Migration files that belong to the AI module, in order. */
const AI_MIGRATIONS = ['032_rag_core.sql', '033_rag_usage.sql', '034_rag_chunks.sql', '035_rag_ingestion.sql', '036_rag_destinations.sql', '037_rag_faqs.sql', '038_rag_tools.sql', '039_rag_traces.sql', '040_rag_prompt_versions.sql', '041_rag_security.sql', '042_chat_memory.sql', '043_chat_feedback.sql', '044_bot_flows.sql', '045_rag_insights.sql', '046_rag_api_connectors.sql'];

let ready = null;

async function applyFile(file) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  // Strip comment lines, then run each statement on its own (the pool runs one at a time).
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.query(statement);
  }
}

/** Resolves once every AI table exists. Retries on the next call if it failed. */
function ensureAiTables() {
  if (!ready) {
    ready = (async () => {
      for (const file of AI_MIGRATIONS) await applyFile(file);
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

module.exports = { ensureAiTables, AI_MIGRATIONS };
