/**
 * What the admin RAG Overview shows: is each part of the assistant set up?
 *
 * Each check returns { status: 'ok' | 'warning' | 'not_configured' | 'error',
 * label, detail }. Checks that need later phases report not_configured until
 * those phases land. Nothing here calls NVIDIA or Pinecone — the overview has
 * to load fast; the live test is the "Test connection" button in AI Settings.
 */

const { config } = require('./config');
const { db } = require('./ports');
const { ensureAiTables } = require('./db');
const { storageHealth, isPublic } = require('./storage');
const settingsStore = require('./settings');
const { usageSummary } = require('./llm/usage');
const store = require('./vector');

async function databaseCheck() {
  try {
    await ensureAiTables();
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM rag_settings');
    return { status: 'ok', label: 'Database', detail: `MySQL reachable · ${Number(rows[0]?.n || 0)} AI settings saved` };
  } catch (err) {
    return { status: 'error', label: 'Database', detail: `AI tables unavailable: ${err.message}` };
  }
}

async function llmCheck() {
  try {
    const s = await settingsStore.getPublic();
    if (!s.nvidia.keySet) {
      return { status: 'not_configured', label: 'AI model (NVIDIA)', detail: 'Add the NVIDIA API key in AI Settings or as NVIDIA_API_KEY in the backend .env.' };
    }
    const from = s.nvidia.keySource === 'admin' ? 'saved in AI Settings' : 'from .env';
    return { status: 'ok', label: 'AI model (NVIDIA)', detail: `Key ${from} · chat: ${s.values.chatModel} · embeddings: ${s.values.embedModel}. Use "Test connection" in AI Settings.` };
  } catch (err) {
    return { status: 'error', label: 'AI model (NVIDIA)', detail: `Settings unavailable: ${err.message}` };
  }
}

function vectorCheck() {
  const { driver, requested, pinecone } = config.vector;
  if (requested === 'pinecone' && driver !== 'pinecone') {
    return { status: 'warning', label: 'Vector database', detail: 'Pinecone selected but credentials are missing, so the built-in MySQL store will be used.' };
  }
  if (driver === 'pinecone') {
    return { status: 'ok', label: 'Vector database', detail: `Pinecone · index "${pinecone.index || pinecone.indexHost}" · namespace "${pinecone.namespace}". Connection test arrives in Phase 3.` };
  }
  return {
    status: 'ok',
    label: 'Vector database',
    detail: pinecone.configured
      ? `Built-in MySQL store. Pinecone credentials are set (index "${pinecone.index || pinecone.indexHost}"); it is switched on in Phase 3.`
      : 'Built-in MySQL store. Add Pinecone credentials any time to switch.',
  };
}

function storageCheck() {
  const s = storageHealth();
  if (!s.ok) return { status: 'error', label: 'Document storage', detail: `Not writable: ${s.reason}` };
  if (isPublic()) return { status: 'error', label: 'Document storage', detail: 'Storage folder is inside the public uploads folder; move RAG_STORAGE_DIR.' };
  return { status: 'ok', label: 'Document storage', detail: 'Private folder ready' };
}

/** PDF / Word / Excel / CSV readers installed? Missing after an update without "npm install". */
function readersCheck() {
  const missing = require('./ingest/parsers').readersStatus().filter((r) => !r.ok);
  return missing.length
    ? { status: 'error', label: 'Document readers', detail: `Not installed: ${missing.map((r) => `${r.label} (${r.pkg})`).join(', ')}. In cPanel → Setup Node.js App click "Run NPM Install", restart, then Retry the failed files.` }
    : { status: 'ok', label: 'Document readers', detail: 'PDF, Word, Excel and CSV readers installed' };
}

/** Redis when REDIS_URL is set (shared, survives restarts), memory otherwise (extra track 2.5). */
function cacheCheck() {
  const c = require('../services/cache').stats();
  const rate = c.hitRate === null ? 'no lookups yet' : `${Math.round(c.hitRate * 100)}% served from cache`;
  if (c.redisConfigured && c.backend !== 'redis') return { status: 'warning', label: 'Cache', detail: `REDIS_URL is set but Redis is not reachable (${c.redisError || 'connecting'}); using memory meanwhile · ${rate}` };
  return { status: 'ok', label: 'Cache', detail: c.backend === 'redis' ? `Redis · ${rate}` : `In memory (set REDIS_URL to share it across restarts) · ${c.memoryEntries} entries · ${rate}` };
}

function secretCheck() {
  return config.secretKeySet
    ? { status: 'ok', label: 'Secret encryption key', detail: 'RAG_SECRET_KEY set' }
    : { status: 'not_configured', label: 'Secret encryption key', detail: 'Add RAG_SECRET_KEY (needed before saving API keys from the admin, Phase 2).' };
}

async function overview() {
  const checks = [await databaseCheck(), await llmCheck(), vectorCheck(), storageCheck(), readersCheck(), cacheCheck(), secretCheck()];
  const usage = await usageSummary().catch(() => null);
  const index = await store.stats().catch(() => null);
  const { rows: docRows } = await db
    .query("SELECT COUNT(*) AS n FROM rag_sources WHERE type = 'document' AND status <> 'archived'")
    .catch(() => ({ rows: [] }));
  // Live numbers for the overview cards (Phase 19).
  const one = (sql) => db.query(sql).then((r) => r.rows[0] || {}).catch(() => ({}));
  const [faqRow, chatRow, fbRow, openRow] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM rag_faqs WHERE status = 'published'"),
    one("SELECT SUM(created_at >= CURDATE()) AS today, COUNT(*) AS week FROM chat_sessions WHERE created_at >= (NOW() - INTERVAL 7 DAY)"),
    one("SELECT SUM(rating = 'up') AS up, SUM(rating = 'down') AS down FROM chat_feedback WHERE created_at >= (NOW() - INTERVAL 30 DAY)"),
    one("SELECT (SELECT COUNT(*) FROM chat_feedback f LEFT JOIN rag_feedback_review r ON r.feedback_id = f.id WHERE f.rating = 'down' AND (r.status IS NULL OR r.status = 'open')) AS feedback, (SELECT COUNT(*) FROM rag_faq_suggestions WHERE status = 'open') AS suggestions, (SELECT COUNT(*) FROM rag_conflicts WHERE status = 'open') AS conflicts"),
  ]);
  const up = Number(fbRow.up || 0);
  const down = Number(fbRow.down || 0);
  const rank = { error: 3, warning: 2, not_configured: 1, ok: 0 };
  const worst = checks.reduce((w, c) => (rank[c.status] > rank[w] ? c.status : w), 'ok');
  return {
    status: worst,
    phase: { current: 19, total: 20, name: 'Playground, feedback & analytics' },
    usage,
    chatEnabled: config.chatEnabled,
    checks,
    warnings: config.warnings,
    counts: {
      sources: index?.sources || 0,
      chunks: index?.embeddedChunks || 0,
      faqs: Number(faqRow.n || 0),
      documents: Number(docRows[0]?.n || 0),
      chatsToday: Number(chatRow.today || 0),
      chatsWeek: Number(chatRow.week || 0),
    },
    csat: up + down ? { up, down, rate: Number((up / (up + down)).toFixed(3)) } : null,
    toReview: { feedback: Number(openRow.feedback || 0), suggestions: Number(openRow.suggestions || 0), conflicts: Number(openRow.conflicts || 0) },
    vectorDriver: index?.driver || config.vector.driver,
  };
}

module.exports = { overview };
