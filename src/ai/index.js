/**
 * The AI assistant module (RAG + live tools + Bot Connection).
 *
 * Design and build plan: docs/rag-system/. This file is the module's only
 * export to src/index.js: it mounts the two routers and logs config warnings.
 */

const { config } = require('./config');
const adminRoutes = require('./routes/admin');
const chatRoutes = require('./routes/chat');
const ingestWorker = require('./ingest/worker');

function mountAi(app, { adminAuth, guardFor }) {
  app.use('/api/admin/rag', adminAuth, guardFor('rag'), adminRoutes);
  app.use('/api/chat', chatRoutes);
  // API connectors (extra track 2.3): discovery reads the app's own GET routes.
  require('./tools/connectors').setApp(app);
  config.warnings.forEach((w) => console.warn(`[ai] ${w}`));
  // Background indexing (polls rag_ingestion_jobs). RAG_WORKER_ENABLED=false turns it off.
  ingestWorker.start();
  require('./memory/retention').start();
  require('./monitor').start(); // Phase 20: email the owners when the assistant is failing
  // Load the in-memory vector index now, so the first visitor question doesn't wait for it.
  setTimeout(() => require('./vector/mysqlDriver').ensureLoaded().catch(() => {}), 5000).unref?.();
}

module.exports = { mountAi };
