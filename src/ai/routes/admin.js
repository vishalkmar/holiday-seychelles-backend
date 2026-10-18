/**
 * /api/admin/rag — the admin RAG System API.
 *
 * Mounted behind adminAuth + guardFor('rag') in src/index.js, so every route
 * here already has a signed-in admin holding the right rag.* permission.
 * Sections arrive phase by phase (docs/rag-system/PHASES.md); until then they
 * answer 501 with the phase that builds them.
 */

const express = require('express');
const { overview } = require('../health');
const { sendSuccess, sendError } = require('../../utils/response');
const { config } = require('../config');

const router = express.Router();

router.get('/overview', async (req, res) => {
  try {
    sendSuccess(res, await overview());
  } catch (err) {
    sendError(res, err, 'Could not build the AI overview', 500);
  }
});

// ── AI Settings (Phase 2) ────────────────────────────────────────────────────
// Guarded by rag.settings.manage (routeGuards: /settings*). Every change is
// audited; the key is only ever returned masked. Step-up (OTP) for these
// arrives with the prompt security work in Phase 12.

const settingsStore = require('../settings');
const llm = require('../llm');
const { usageSummary } = require('../llm/usage');
const { audit, db } = require('../ports');

const llmErrorStatus = (err) => (err?.code === 'NOT_CONFIGURED' ? 400 : err?.code === 'AUTH' ? 400 : 502);

router.get('/settings', async (req, res) => {
  try {
    sendSuccess(res, { ...(await settingsStore.getPublic()), usage: await usageSummary() });
  } catch (err) {
    sendError(res, err, 'Could not load AI settings', 500);
  }
});

// Changing which models answer (or the approval rule) is sensitive: step-up.
const MODEL_KEYS = ['chatModel', 'chatFallbackModels', 'routerModel', 'embedModel', 'rerankModel', 'rerankUrl', 'rerankEnabled', 'requireSecondApproval'];

router.put('/settings', async (req, res) => {
  try {
    const eff = await settingsStore.getEffective();
    const touches = MODEL_KEYS.filter((k) => k in (req.body || {}) && JSON.stringify(req.body[k]) !== JSON.stringify(eff[k]));
    if (touches.length) {
      await requireToken(req, 'settings.models', 'settings');
      await require('../security/events').onSensitiveChange({ req, adminId: req.admin?.id, what: `AI settings: ${touches.join(', ')}` });
    }
    const changed = await settingsStore.update(req.body || {}, req.admin?.id);
    if (touches.length && changed.length) {
      require('../security/emails').sendChangeNotice({ actor: req.admin, what: `AI settings changed: ${changed.join(', ')}`, details: changed.map((k) => [k, JSON.stringify(req.body[k]).slice(0, 120)]), section: 'rag-settings' }).catch(() => {});
    }
    if (changed.length) {
      await audit({
        req,
        adminId: req.admin?.id,
        adminEmail: req.admin?.email,
        action: 'rag.settings.updated',
        entityType: 'rag_settings',
        summary: `Changed AI settings: ${changed.join(', ')}`,
        metadata: { changed, values: Object.fromEntries(changed.map((k) => [k, req.body[k]])) },
      });
    }
    sendSuccess(res, { changed, ...(await settingsStore.getPublic()) }, changed.length ? 'Settings saved' : 'Nothing changed');
  } catch (err) {
    fail(res, err, 'Could not save AI settings');
  }
});

router.put('/settings/key', async (req, res) => {
  const key = String(req.body?.apiKey || '').trim();
  if (key && (key.length < 20 || /\s/.test(key))) {
    return sendError(res, null, 'That does not look like an NVIDIA API key.', 400);
  }
  try {
    await requireToken(req, 'settings.key', 'nvidiaApiKey');
    await require('../security/events').onSensitiveChange({ req, adminId: req.admin?.id, what: key ? 'NVIDIA key replaced' : 'NVIDIA key removed' });
    await settingsStore.setSecret('nvidiaApiKey', key, req.admin?.id);
    require('../security/emails').sendChangeNotice({ actor: req.admin, what: key ? 'NVIDIA API key replaced' : 'NVIDIA API key removed', section: 'rag-settings' }).catch(() => {});
    await audit({
      req,
      adminId: req.admin?.id,
      adminEmail: req.admin?.email,
      action: key ? 'rag.key.replaced' : 'rag.key.removed',
      entityType: 'rag_settings',
      entityId: 'nvidiaApiKey',
      summary: key ? 'Replaced the NVIDIA API key (saved encrypted)' : 'Removed the admin-saved NVIDIA API key (falls back to .env)',
    });
    sendSuccess(res, await settingsStore.getPublic(), key ? 'Key saved' : 'Key removed');
  } catch (err) {
    fail(res, err, 'Could not save the key');
  }
});

router.post('/settings/test', async (req, res) => {
  try {
    sendSuccess(res, await llm.testConnection());
  } catch (err) {
    sendError(res, err, err.message || 'Connection test failed', llmErrorStatus(err));
  }
});

router.post('/settings/test-model', async (req, res) => {
  const model = String(req.body?.model || '').trim().slice(0, 160);
  const kind = req.body?.kind === 'embed' ? 'embed' : 'chat';
  if (!model) return sendError(res, null, 'Choose a model to test', 400);
  try {
    sendSuccess(res, await llm.testModel({ model, kind }));
  } catch (err) {
    sendError(res, err, err.message || 'Model test failed', llmErrorStatus(err));
  }
});

router.get('/settings/models', async (req, res) => {
  try {
    sendSuccess(res, { models: await llm.listModels() });
  } catch (err) {
    sendError(res, { code: err.code, detail: err.detail }, err.message || 'Could not list models', llmErrorStatus(err));
  }
});

// ── Vector Index (Phase 3) ───────────────────────────────────────────────────
// GET is rag.view; every POST/DELETE here is rag.index.manage (routeGuards).

const store = require('../vector');
const sample = require('../vector/sample');

router.get('/index', async (req, res) => {
  try {
    sendSuccess(res, await store.stats({ withPinecone: req.query.pinecone === '1' }));
  } catch (err) {
    sendError(res, err, 'Could not read the vector index', 500);
  }
});

router.post('/index/search', async (req, res) => {
  const query = String(req.body?.query || '').trim().slice(0, 500);
  const k = Math.min(20, Math.max(1, Number(req.body?.k) || 5));
  if (!query) return sendError(res, null, 'Type a question to search for', 400);
  try {
    const t0 = Date.now();
    const { vectors } = await llm.embed({ inputs: [query], inputType: 'query', purpose: 'search' });
    const tEmbed = Date.now() - t0;
    const filter = req.body?.includeInternal ? { visibility: null } : { visibility: 'public' };
    if (req.body?.destination) filter.destination = String(req.body.destination).toLowerCase();
    const results = await store.search({ vector: vectors[0], k, filter });
    sendSuccess(res, { results, driver: results.driver, fellBack: results.fellBack, timings: { embedMs: tEmbed, totalMs: Date.now() - t0 } });
  } catch (err) {
    sendError(res, err, err.message || 'Search failed', err.status || llmErrorStatus(err));
  }
});

router.post('/index/sample', async (req, res) => {
  try {
    const r = await sample.addSample(req.admin?.id);
    await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.index.sample_added', entityType: 'rag_source', entityId: r.sourceId, summary: `Added ${r.written} sample chunks for testing the index` });
    sendSuccess(res, r, 'Sample knowledge added');
  } catch (err) {
    sendError(res, err, err.message || 'Could not add the sample', err.status || llmErrorStatus(err));
  }
});

router.delete('/index/sample', async (req, res) => {
  try {
    const r = await sample.removeSample();
    await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.index.sample_removed', entityType: 'rag_source', summary: `Removed ${r.removed} sample chunks` });
    sendSuccess(res, r, 'Sample knowledge removed');
  } catch (err) {
    sendError(res, err, err.message || 'Could not remove the sample', 500);
  }
});

router.post('/index/sync', async (req, res) => {
  try {
    const r = await store.syncToPinecone();
    await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.index.synced', entityType: 'rag_index', summary: `Rebuilt Pinecone namespace "${r.namespace}" with ${r.synced} vectors` });
    sendSuccess(res, r, `Synced ${r.synced} vectors to Pinecone`);
  } catch (err) {
    sendError(res, err, err.message || 'Sync failed', err.status || 502);
  }
});

// ── Sources & ingestion jobs (Phase 4) ───────────────────────────────────────
// GET needs rag.view; changes need rag.knowledge.manage (routeGuards).

const sources = require('../knowledge/sources');
const ingestWorker = require('../ingest/worker');

const auditSource = (req, action, sourceId, summary, metadata) =>
  audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action, entityType: 'rag_source', entityId: sourceId, summary, metadata });

const fail = (res, err, fallback) => {
  // A gated change without a valid change token: say what to verify (Phase 12).
  if (err.stepup) return res.status(err.status || 428).json({ status: 'error', code: err.code, message: err.message, ...err.stepup });
  return sendError(res, err, err.message || fallback, err.status || 500);
};

router.get('/sources', async (req, res) => {
  try {
    sendSuccess(res, { sources: await sources.list(req.query), worker: ingestWorker.status() });
  } catch (err) { fail(res, err, 'Could not list sources'); }
});

router.post('/sources', async (req, res) => {
  try {
    const r = await sources.createSource(req.body || {}, req.admin?.id);
    await auditSource(req, 'rag.source.created', r.sourceId, `Created ${req.body?.type || 'text'} source "${String(req.body?.title || '').slice(0, 120)}" (queued for indexing)`);
    sendSuccess(res, r, 'Source saved and queued for indexing', 201);
  } catch (err) { fail(res, err, 'Could not create the source'); }
});

router.get('/sources/:id', async (req, res) => {
  try { sendSuccess(res, await sources.detail(Number(req.params.id))); } catch (err) { fail(res, err, 'Could not load the source'); }
});

router.get('/sources/:id/chunks', async (req, res) => {
  try { sendSuccess(res, { chunks: await sources.chunks(Number(req.params.id)) }); } catch (err) { fail(res, err, 'Could not load chunks'); }
});

router.put('/sources/:id', async (req, res) => {
  try {
    const r = await sources.updateSource(Number(req.params.id), req.body || {}, req.admin?.id);
    if (!r.unchanged) await auditSource(req, 'rag.source.updated', r.sourceId, `Updated source → v${r.version} (queued for indexing)`, { fields: Object.keys(req.body || {}) });
    sendSuccess(res, r, r.unchanged ? 'Nothing changed' : 'Saved and queued for indexing');
  } catch (err) { fail(res, err, 'Could not update the source'); }
});

router.post('/sources/:id/reindex', async (req, res) => {
  try {
    const r = await sources.reindex(Number(req.params.id), req.admin?.id);
    await auditSource(req, 'rag.source.reindexed', r.sourceId, `Re-index requested for v${r.version}`);
    sendSuccess(res, r, 'Queued for re-indexing');
  } catch (err) { fail(res, err, 'Could not re-index'); }
});

router.post('/sources/:id/archive', async (req, res) => {
  try {
    const r = await sources.archive(Number(req.params.id));
    await auditSource(req, 'rag.source.archived', r.sourceId, `Archived; ${r.removedChunks} chunks removed from search`);
    sendSuccess(res, r, 'Archived');
  } catch (err) { fail(res, err, 'Could not archive'); }
});

router.post('/sources/:id/restore', async (req, res) => {
  try {
    const r = await sources.restore(Number(req.params.id), req.admin?.id);
    await auditSource(req, 'rag.source.restored', r.sourceId, `Restored; v${r.version} queued for indexing`);
    sendSuccess(res, r, 'Restored and queued for indexing');
  } catch (err) { fail(res, err, 'Could not restore'); }
});

router.delete('/sources/:id', async (req, res) => {
  try {
    const r = await sources.remove(Number(req.params.id));
    documents.removeFiles(r.files);
    await auditSource(req, 'rag.source.deleted', r.sourceId, `Deleted; ${r.removedChunks} chunks removed`);
    sendSuccess(res, { sourceId: r.sourceId, removedChunks: r.removedChunks }, 'Deleted');
  } catch (err) { fail(res, err, 'Could not delete'); }
});

router.get('/jobs', async (req, res) => {
  try { sendSuccess(res, { jobs: await sources.jobs(req.query), worker: ingestWorker.status() }); } catch (err) { fail(res, err, 'Could not list jobs'); }
});

router.post('/jobs/:id/retry', async (req, res) => {
  try {
    const r = await sources.retryJob(Number(req.params.id));
    await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.job.retried', entityType: 'rag_job', entityId: req.params.id, summary: `Retried ingestion job ${req.params.id} as job ${r.jobId}` });
    sendSuccess(res, r, 'Queued again');
  } catch (err) { fail(res, err, 'Could not retry'); }
});

// ── Document Training Center (Phase 5) ───────────────────────────────────────
// Uploads: one file, held in memory up to RAG_MAX_UPLOAD_MB, then written to
// private storage. The download of an original needs rag.knowledge.manage
// (internal documents such as rate sheets live here).

const multer = require('multer');
const documents = require('../knowledge/documents');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
}).single('file');

function withFile(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return sendError(res, null, tooBig ? `The file is larger than ${config.maxUploadMb} MB.` : `Upload failed: ${err.message}`, tooBig ? 413 : 400);
  });
}

router.get('/documents', async (req, res) => {
  try {
    sendSuccess(res, { documents: await documents.list(req.query), maxUploadMb: config.maxUploadMb, worker: ingestWorker.status() });
  } catch (err) { fail(res, err, 'Could not list documents'); }
});

router.post('/documents', withFile, async (req, res) => {
  try {
    const r = await documents.upload(req.file, req.body || {}, req.admin?.id);
    await auditSource(req, 'rag.document.uploaded', r.sourceId, `Uploaded ${r.kind} “${r.fileName}” (queued for indexing)`, { size: req.file?.size });
    sendSuccess(res, r, 'Uploaded — indexing in the background', 201);
  } catch (err) { fail(res, err, 'Upload failed'); }
});

router.post('/documents/:id/replace', withFile, async (req, res) => {
  try {
    const r = await documents.replace(Number(req.params.id), req.file, req.admin?.id);
    await auditSource(req, 'rag.document.replaced', r.sourceId, `Replaced the file → v${r.version} (queued for indexing)`);
    sendSuccess(res, r, 'File replaced — indexing in the background');
  } catch (err) { fail(res, err, 'Replace failed'); }
});

router.get('/documents/:id/file', async (req, res) => {
  try {
    const f = await documents.fileFor(Number(req.params.id), req.query.version ? Number(req.query.version) : undefined);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.fileName)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(f.full);
  } catch (err) { fail(res, err, 'Could not download the file'); }
});

// ── Destination Knowledge (Phase 6) ──────────────────────────────────────────

const destinations = require('../knowledge/destinations');

const auditDest = (req, action, id, summary) =>
  audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action, entityType: 'rag_destination', entityId: id, summary });

router.get('/destinations', async (req, res) => {
  try {
    sendSuccess(res, { destinations: await destinations.list(req.query), sections: destinations.SECTIONS, islands: destinations.ISLAND_OPTIONS });
  } catch (err) { fail(res, err, 'Could not list destinations'); }
});

router.post('/destinations/import', async (req, res) => {
  try {
    const r = await destinations.importFromWebsite(req.admin?.id);
    if (r.imported) await auditDest(req, 'rag.destination.imported', null, `Imported ${r.imported} destination(s) from the website island pages as drafts`);
    sendSuccess(res, r, r.imported ? `Imported ${r.imported} destination(s) as drafts` : 'Everything is already imported');
  } catch (err) { fail(res, err, 'Import failed'); }
});

router.post('/destinations', async (req, res) => {
  try {
    const d = await destinations.create(req.body || {}, req.admin?.id);
    await auditDest(req, 'rag.destination.created', d.id, `Created destination “${d.name}”`);
    sendSuccess(res, d, 'Destination created', 201);
  } catch (err) { fail(res, err, 'Could not create the destination'); }
});

router.get('/destinations/:id', async (req, res) => {
  try { sendSuccess(res, await destinations.detail(Number(req.params.id))); } catch (err) { fail(res, err, 'Could not load the destination'); }
});

router.get('/destinations/:id/preview', async (req, res) => {
  try { sendSuccess(res, await destinations.preview(Number(req.params.id))); } catch (err) { fail(res, err, 'Could not build the preview'); }
});

router.put('/destinations/:id', async (req, res) => {
  try {
    const d = await destinations.update(Number(req.params.id), req.body || {}, req.admin?.id);
    sendSuccess(res, d, 'Saved (not live until you publish)');
  } catch (err) { fail(res, err, 'Could not save'); }
});

router.post('/destinations/:id/publish', async (req, res) => {
  try {
    const r = await destinations.publish(Number(req.params.id), req.admin?.id);
    await auditDest(req, 'rag.destination.published', req.params.id, `Published → source ${r.sourceId} v${r.version}${r.unchanged ? ' (no text change)' : ' (queued for indexing)'}`);
    sendSuccess(res, r, r.unchanged ? 'Already live — nothing changed' : 'Published — indexing in the background');
  } catch (err) { fail(res, err, 'Could not publish'); }
});

router.post('/destinations/publish-all', async (req, res) => {
  try {
    const all = await destinations.list();
    const todo = all.filter((d) => ['draft', 'changed'].includes(d.state) && d.sectionsFilled > 0);
    let published = 0;
    const errors = [];
    for (const d of todo) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await destinations.publish(d.id, req.admin?.id);
        published += 1;
      } catch (err) { errors.push(`${d.name}: ${err.message}`); }
    }
    if (published) await auditDest(req, 'rag.destination.published_all', null, `Published ${published} destination(s)`);
    sendSuccess(res, { published, errors }, `Published ${published} destination(s)`);
  } catch (err) { fail(res, err, 'Could not publish'); }
});

router.post('/destinations/:id/sync', async (req, res) => {
  try {
    const d = await destinations.syncFromWebsite(Number(req.params.id), req.admin?.id);
    await auditDest(req, 'rag.destination.synced', d.id, `Replaced the working copy of “${d.name}” with the website page`);
    sendSuccess(res, d, 'Updated from the website page (publish to make it live)');
  } catch (err) { fail(res, err, 'Could not sync'); }
});

router.post('/destinations/:id/archive', async (req, res) => {
  try {
    const r = await destinations.archive(Number(req.params.id));
    await auditDest(req, 'rag.destination.archived', req.params.id, `Archived; ${r.removedChunks} chunks removed from search`);
    sendSuccess(res, r, 'Archived — removed from the assistant');
  } catch (err) { fail(res, err, 'Could not archive'); }
});

router.delete('/destinations/:id', async (req, res) => {
  try {
    const r = await destinations.remove(Number(req.params.id));
    await auditDest(req, 'rag.destination.deleted', req.params.id, `Deleted; ${r.removedChunks} chunks removed`);
    sendSuccess(res, r, 'Deleted');
  } catch (err) { fail(res, err, 'Could not delete'); }
});

// ── AI Questions Training (Phase 7) ──────────────────────────────────────────

const faqs = require('../knowledge/faqs');
const faqImport = require('../knowledge/faqImport');

const auditFaq = (req, action, id, summary, meta) =>
  audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action, entityType: 'rag_faq', entityId: id, summary, metadata: meta });

router.get('/faqs', async (req, res) => {
  try {
    const [page, counts] = await Promise.all([faqs.list(req.query), faqs.counts()]);
    sendSuccess(res, { ...page, counts, statuses: faqs.STATUSES });
  } catch (err) { fail(res, err, 'Could not list questions'); }
});

router.get('/faqs/export', async (req, res) => {
  try {
    const csv = await faqs.exportCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-questions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  } catch (err) { fail(res, err, 'Could not export'); }
});

router.post('/faqs/duplicates', async (req, res) => {
  try {
    const q = String(req.body?.question || '').trim();
    if (!q) return sendSuccess(res, { matches: [] });
    sendSuccess(res, { matches: await faqs.findDuplicates(q, { excludeId: req.body?.excludeId ? Number(req.body.excludeId) : null }) });
  } catch (err) { fail(res, err, 'Could not check for duplicates'); }
});

router.post('/faqs/import/preview', withFile, async (req, res) => {
  try {
    sendSuccess(res, await faqImport.preview(req.file, req.admin?.id));
  } catch (err) { fail(res, err, 'Could not read the file'); }
});

router.post('/faqs/import/preview-text', async (req, res) => {
  try {
    sendSuccess(res, await faqImport.previewText(req.body?.text, req.admin?.id));
  } catch (err) { fail(res, err, 'Could not read the pasted text'); }
});

router.post('/faqs/import/check', async (req, res) => {
  try {
    const { importId, mapping } = req.body || {};
    sendSuccess(res, await faqImport.check(importId, mapping || {}));
  } catch (err) { fail(res, err, 'Could not check the rows'); }
});

router.post('/faqs/import/commit', async (req, res) => {
  try {
    const { importId, mapping, publish, include } = req.body || {};
    const r = await faqImport.commit(importId, mapping || {}, { publish: Boolean(publish), include: Array.isArray(include) && include.length ? include : undefined }, req.admin?.id);
    await auditFaq(req, 'rag.faq.imported', importId, `Imported ${r.created} questions${publish ? ' (publishing in the background)' : ' as drafts'}; ${r.skipped} skipped`, { failed: r.failed.length });
    sendSuccess(res, r, `Imported ${r.created} questions`, 201);
  } catch (err) { fail(res, err, 'Import failed'); }
});

/** body: { ids: [], action: publish|review|archive|restore|delete|category, category? } */
router.post('/faqs/bulk', async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 1000);
    const action = String(req.body?.action || '');
    const run = {
      publish: (id) => faqs.publish(id, req.admin?.id),
      review: (id) => faqs.submitForReview(id),
      archive: (id) => faqs.archive(id),
      restore: (id) => faqs.restore(id),
      delete: (id) => faqs.remove(id),
      category: (id) => faqs.update(id, { category: req.body?.category || null, note: 'Category changed (bulk)' }, req.admin?.id),
    }[action];
    if (!run) return sendError(res, null, 'Unknown bulk action', 400);
    if (!ids.length) return sendError(res, null, 'Select at least one question', 400);
    const runAll = async () => {
      let done = 0;
      const failed = [];
      for (const id of ids) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await run(id);
          done += 1;
        } catch (err) { failed.push({ id, message: err.message }); }
      }
      await auditFaq(req, `rag.faq.bulk_${action}`, null, `Bulk ${action}: ${done} of ${ids.length}`, { failed: failed.length });
      return { done, failed };
    };
    // Publishing is ~1 s per question (source + queued job); a big selection
    // finishes in the background and shows up in the counters.
    if (action === 'publish' && ids.length > 25) {
      runAll().catch((err) => console.error('[ai] bulk publish:', err.message));
      return sendSuccess(res, { done: 0, failed: [], background: ids.length }, `Publishing ${ids.length} questions in the background`, 202);
    }
    const r = await runAll();
    sendSuccess(res, r, `${r.done} updated`);
  } catch (err) { fail(res, err, 'Bulk action failed'); }
});

router.post('/faqs', async (req, res) => {
  try {
    const status = ['draft', 'review', 'published'].includes(req.body?.status) ? req.body.status : 'draft';
    const f = await faqs.create(req.body || {}, req.admin?.id, { status });
    await auditFaq(req, 'rag.faq.created', f.id, `Created “${f.question.slice(0, 120)}” (${status})`);
    sendSuccess(res, f, 'Question saved', 201);
  } catch (err) { fail(res, err, 'Could not save the question'); }
});

router.get('/faqs/:id', async (req, res) => {
  try { sendSuccess(res, await faqs.get(Number(req.params.id))); } catch (err) { fail(res, err, 'Could not load the question'); }
});

router.put('/faqs/:id', async (req, res) => {
  try {
    const f = await faqs.update(Number(req.params.id), req.body || {}, req.admin?.id);
    await auditFaq(req, 'rag.faq.updated', f.id, `Edited → v${f.version}`);
    sendSuccess(res, f, 'Saved');
  } catch (err) { fail(res, err, 'Could not save'); }
});

router.get('/faqs/:id/history', async (req, res) => {
  try { sendSuccess(res, { versions: await faqs.history(Number(req.params.id)) }); } catch (err) { fail(res, err, 'Could not load the history'); }
});

const faqAction = (name, fn, msg) =>
  router.post(`/faqs/:id/${name}`, async (req, res) => {
    try {
      const r = await fn(Number(req.params.id), req);
      await auditFaq(req, `rag.faq.${name}`, req.params.id, typeof msg === 'function' ? msg(req, r) : msg);
      sendSuccess(res, r, typeof msg === 'function' ? msg(req, r) : msg);
    } catch (err) { fail(res, err, `Could not ${name}`); }
  });

faqAction('review', (id) => faqs.submitForReview(id), 'Sent for review');
faqAction('publish', (id, req) => faqs.publish(id, req.admin?.id), 'Published — indexing in the background');
faqAction('archive', (id) => faqs.archive(id), 'Archived — removed from the assistant');
faqAction('restore', (id) => faqs.restore(id), 'Restored as a draft');
faqAction('rollback', (id, req) => faqs.rollback(id, Number(req.body?.version), req.admin?.id), (req) => `Rolled back to v${req.body?.version} (publish to make it live)`);

router.delete('/faqs/:id', async (req, res) => {
  try {
    const r = await faqs.remove(Number(req.params.id));
    await auditFaq(req, 'rag.faq.deleted', req.params.id, 'Deleted');
    sendSuccess(res, r, 'Deleted');
  } catch (err) { fail(res, err, 'Could not delete'); }
});

// ── Retrieval (Phase 8) ──────────────────────────────────────────────────────

const retriever = require('../retrieve');
const retrievalEval = require('../retrieve/eval');

/** body: { query, destination?, k?, includeInternal? } — what the assistant would get as context. */
router.post('/retrieval/test', async (req, res) => {
  try {
    const b = req.body || {};
    sendSuccess(res, await retriever.retrieve(b.query, { audience: 'admin', destination: b.destination, k: b.k, includeInternal: Boolean(b.includeInternal) }));
  } catch (err) {
    sendError(res, err, err.message || 'Retrieval failed', err.status || llmErrorStatus(err));
  }
});

router.get('/retrieval/eval', async (req, res) => {
  try { sendSuccess(res, { cases: retrievalEval.loadCases() }); } catch (err) { fail(res, err, 'Could not load the eval set'); }
});

router.post('/retrieval/eval', async (req, res) => {
  try {
    sendSuccess(res, await retrievalEval.run({ k: Number(req.body?.k) || 5 }));
  } catch (err) {
    sendError(res, err, err.message || 'Eval failed', err.status || llmErrorStatus(err));
  }
});

// ── Live API Integration (Phase 9) ───────────────────────────────────────────

const tools = require('../tools');

const auditTool = (req, action, name, summary, metadata) =>
  audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action, entityType: 'rag_tool', entityId: name, summary, metadata });

router.get('/tools', async (req, res) => {
  try { sendSuccess(res, { tools: await tools.list() }); } catch (err) { fail(res, err, 'Could not list tools'); }
});

router.put('/tools/:name', async (req, res) => {
  try {
    const now = await tools.getTool(req.params.name);
    const permissionChange = Boolean(now) && req.body?.permission !== undefined && req.body.permission !== now.permission;
    if (permissionChange) {
      await requireToken(req, 'tools.permission', req.params.name);
      await require('../security/events').onSensitiveChange({ req, adminId: req.admin?.id, what: `tool ${req.params.name} permission` });
    }
    const { before, after } = await tools.configure(req.params.name, req.body || {}, req.admin?.id);
    if (permissionChange && before.permission !== after.permission) {
      require('../security/emails').sendChangeNotice({ actor: req.admin, what: `Live tool "${after.title}" is now for ${after.permission === 'user' ? 'signed-in visitors only' : 'every visitor'}`, section: 'rag-tools' }).catch(() => {});
    }
    const changed = ['enabled', 'permission', 'description', 'timeoutMs', 'cacheSec', 'maxResults'].filter((k) => before[k] !== after[k]);
    await auditTool(req, 'rag.tool.updated', req.params.name, changed.length ? `Changed ${changed.join(', ')}${changed.includes('enabled') ? ` (now ${after.enabled ? 'on' : 'off'})` : ''}` : 'Saved (no change)');
    sendSuccess(res, after, 'Saved');
  } catch (err) { fail(res, err, 'Could not save'); }
});

/** body: { input: {...}, userId? } — a real call, cache skipped. userId lets the admin test bookings.mine for one customer. */
router.post('/tools/:name/test', async (req, res) => {
  try {
    const userId = req.body?.userId ? Number(req.body.userId) : null;
    const r = await tools.run(req.params.name, req.body?.input || {}, { audience: 'admin', userId, skipCache: true });
    if (userId) await auditTool(req, 'rag.tool.tested_as_user', req.params.name, `Test call as customer #${userId}`);
    sendSuccess(res, r);
  } catch (err) { fail(res, err, 'Test call failed'); }
});

// ── Orchestrator test turn (Phase 10; the full Playground is Phase 19) ──────

const orchestrator = require('../orchestrator');
const traces = require('../orchestrator/traces');

/** body: { message, history?, state?, userId? } → reply, next state, trace (stored). */
router.post('/playground/turn', async (req, res) => {
  try {
    const b = req.body || {};
    const out = await orchestrator.handleTurn({ message: b.message, history: b.history, state: b.state, userId: b.userId ? Number(b.userId) : null, sessionId: b.sessionId || `admin-${req.admin?.id || 0}`, audience: 'admin' });
    const id = await traces.save({ sessionId: b.sessionId || `admin-${req.admin?.id || 0}`, audience: 'admin', message: b.message, ...out }).catch(() => null);
    sendSuccess(res, { ...out, traceId: id });
  } catch (err) { fail(res, err, 'The turn failed'); }
});

router.get('/playground/traces', async (req, res) => {
  try { sendSuccess(res, { traces: await traces.recent({ sessionId: req.query.sessionId, limit: req.query.limit }) }); } catch (err) { fail(res, err, 'Could not load traces'); }
});

// ── System Prompt Controller (Phase 11) ──────────────────────────────────────

const promptStore = require('../prompt/store');
const promptManifest = require('../prompt/manifest');
const promptLayers = require('../prompt');

const auditPrompt = (req, action, id, summary, metadata) =>
  audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action, entityType: 'rag_prompt', entityId: id, summary, metadata });

router.get('/prompt', async (req, res) => {
  try {
    const [published, draft, manifest] = await Promise.all([promptStore.published(), promptStore.draft(), promptManifest.get({ fresh: true })]);
    sendSuccess(res, {
      core: promptLayers.CORE,
      published,
      draft,
      manifest,
      warnings: draft ? promptStore.guard(draft.content) : [],
      limits: { maxChars: promptStore.MAX_CHARS, patterns: promptStore.PATTERNS },
      publishing: { available: false, reason: 'Publishing needs step-up verification, which arrives with Phase 12.' },
    });
  } catch (err) { fail(res, err, 'Could not load the prompt'); }
});

router.put('/prompt/draft', async (req, res) => {
  try {
    const r = await promptStore.saveDraft(req.body?.content, String(req.body?.note || '').slice(0, 200), req.admin?.id);
    await auditPrompt(req, 'rag.prompt.draft_saved', r.draft.id, `Draft saved (${r.draft.content.length} chars)${r.warnings.length ? `; warnings: ${r.warnings.join(', ')}` : ''}`, { hash: r.draft.hash });
    sendSuccess(res, r, 'Draft saved');
  } catch (err) { fail(res, err, 'Could not save the draft'); }
});

router.delete('/prompt/draft', async (req, res) => {
  try {
    await promptStore.discardDraft();
    await auditPrompt(req, 'rag.prompt.draft_discarded', null, 'Draft discarded');
    sendSuccess(res, {}, 'Draft discarded');
  } catch (err) { fail(res, err, 'Could not discard the draft'); }
});

router.get('/prompt/versions', async (req, res) => {
  try { sendSuccess(res, { versions: await promptStore.versions() }); } catch (err) { fail(res, err, 'Could not load the history'); }
});

/** ?from=<version|0>&to=<version|draft> */
router.get('/prompt/diff', async (req, res) => {
  try {
    const to = await promptStore.byRef(String(req.query.to || 'draft'));
    if (!to) return sendError(res, null, 'Version not found', 404);
    const fromV = Number(req.query.from) || 0;
    const from = fromV ? await promptStore.byRef(fromV) : null;
    sendSuccess(res, { from: from?.version || 0, to: to.status === 'draft' ? 'draft' : to.version, ...promptStore.diffLines(from?.content || '', to.content) });
  } catch (err) { fail(res, err, 'Could not build the diff'); }
});

/** body: { question } → the same question answered with the draft and with the live instructions. */
router.post('/prompt/preview', async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim().slice(0, 1000);
    if (!question) return sendError(res, null, 'Type a question', 400);
    const [draft, live] = await Promise.all([promptStore.draft(), promptStore.published()]);
    const turn = (business, tag) => orchestrator.handleTurn({ message: question, sessionId: `prompt-preview-${tag}-${req.admin?.id || 0}`, audience: 'admin' }, { business });
    // One after the other: two answers at once would trip the model rate limit.
    const d = await turn(draft?.content || live.content, 'draft');
    const p = await turn(live.content, 'live');
    sendSuccess(res, { draft: d, published: p, usedDraft: Boolean(draft) });
  } catch (err) { fail(res, err, 'Preview failed'); }
});

// ── Prompt security (Phase 12) ───────────────────────────────────────────────
// Publish and rollback need a change token from step-up (password + email
// code), bound to exactly what was verified: the draft's id and content hash,
// or the version being restored.

const stepup = require('../security/stepup');
const secEvents = require('../security/events');
const secEmails = require('../security/emails');
const pending = require('../security/pending');

const draftTarget = (d) => `draft:${d.id}:${d.hash.slice(0, 16)}`;
const stepupFail = (res, err, fallback) => {
  const body = { status: 'error', code: err.code || 'ERROR', message: err.message || fallback };
  if (err.stepup) Object.assign(body, err.stepup);
  return res.status(err.status || 500).json(body);
};
/** Spend the change token for this action+target; a missing one answers 428 with what to verify. */
async function requireToken(req, action, target) {
  try {
    await stepup.consume({ adminId: req.admin?.id, token: req.get('x-change-token') || req.body?.changeToken, action, target });
  } catch (err) {
    err.stepup = { action, target };
    throw err;
  }
}

/** What to verify for a gated action, so the client can start step-up. */
router.get('/security/target', async (req, res) => {
  try {
    const action = String(req.query.action || '');
    const label = stepup.ACTIONS[action];
    if (!label) return sendError(res, null, 'Unknown action', 400);
    let target;
    if (action === 'prompt.publish') {
      const d = await promptStore.draft();
      if (!d) return sendError(res, null, 'There is no draft to publish', 400);
      target = draftTarget(d);
    } else if (action === 'prompt.rollback') target = `version:${Number(req.query.version)}`;
    else if (action === 'prompt.approve') target = `pending:${Number(req.query.id)}`;
    else if (action === 'tools.permission') target = String(req.query.tool || '');
    else if (action === 'settings.models') target = 'settings';
    else if (action === 'settings.key') target = 'nvidiaApiKey';
    sendSuccess(res, { action, target, label });
  } catch (err) { fail(res, err, 'Could not prepare verification'); }
});

router.post('/security/step-up/start', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await stepup.start({ req, adminId: req.admin?.id, action: b.action, target: b.target, password: b.password });
    await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.security.stepup_started', entityType: 'rag_security', entityId: String(b.target).slice(0, 60), summary: `Verification code sent for: ${stepup.ACTIONS[b.action]}` });
    sendSuccess(res, r, `Code sent to ${r.email}`);
  } catch (err) { stepupFail(res, err, 'Could not start verification'); }
});

router.post('/security/step-up/resend', async (req, res) => {
  try { sendSuccess(res, await stepup.resend({ req, adminId: req.admin?.id, challengeId: req.body?.challengeId }), 'New code sent'); } catch (err) { stepupFail(res, err, 'Could not resend'); }
});

router.post('/security/step-up/verify', async (req, res) => {
  try {
    const r = await stepup.verify({ req, adminId: req.admin?.id, challengeId: req.body?.challengeId, code: req.body?.code });
    await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.security.stepup_verified', entityType: 'rag_security', entityId: String(r.target).slice(0, 60), summary: `Verified: ${stepup.ACTIONS[r.action]}` });
    sendSuccess(res, r, 'Verified');
  } catch (err) { stepupFail(res, err, 'Could not verify'); }
});

async function applyPublish(req, { actor, note }) {
  const before = await promptStore.published();
  const { after } = await promptStore.publishDraft(actor.id);
  promptLayers.invalidateBusiness();
  promptManifest.invalidate();
  const diff = promptStore.diffLines(before?.content || '', after.content);
  await audit({
    req,
    adminId: actor.id,
    adminEmail: actor.email,
    action: 'rag.prompt.published',
    entityType: 'rag_prompt',
    entityId: after.version,
    summary: `Published business instructions v${after.version} (+${diff.added}/−${diff.removed} lines)`,
    metadata: { beforeVersion: before?.version || 0, beforeHash: before?.hash || null, afterHash: after.hash, note: note || null },
  });
  secEmails.sendChangeNotice({ actor, what: `Business instructions published as v${after.version}`, details: [['Version', `v${before?.version || 0} → v${after.version}`], ['Note', note || '—']], diff }).catch(() => {});
  return { version: after.version, diff: { added: diff.added, removed: diff.removed } };
}

router.post('/prompt/publish', async (req, res) => {
  try {
    const d = await promptStore.draft();
    if (!d) return sendError(res, null, 'There is no draft to publish', 400);
    const target = draftTarget(d);
    await requireToken(req, 'prompt.publish', target);
    await secEvents.onSensitiveChange({ req, adminId: req.admin?.id, what: 'publish business instructions' });
    if ((await settingsStore.getEffective()).requireSecondApproval) {
      const p = await pending.create({ action: 'prompt.publish', target, payload: { draftId: d.id, hash: d.hash }, summary: `Publish business instructions (${d.note || 'no note'})`, requestedBy: req.admin });
      await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.prompt.publish_requested', entityType: 'rag_prompt', entityId: p.id, summary: `Publish requested; waiting for a second admin (#${p.id})` });
      return sendSuccess(res, { pending: p }, 'Sent for approval by a second admin', 202);
    }
    const r = await applyPublish(req, { actor: req.admin, note: d.note });
    sendSuccess(res, r, `Published v${r.version}`);
  } catch (err) { stepupFail(res, err, 'Publish failed'); }
});

/** Rollback = publish an old version's text again, as a new version. Needs its own step-up. */
router.post('/prompt/rollback', async (req, res) => {
  try {
    const version = Number(req.body?.version);
    const old = await promptStore.byRef(version);
    if (!old) return sendError(res, null, 'Version not found', 404);
    const live = await promptStore.published();
    if (live.version === version) return sendError(res, null, `v${version} is already live`, 400);
    await requireToken(req, 'prompt.rollback', `version:${version}`);
    await secEvents.onSensitiveChange({ req, adminId: req.admin?.id, what: `roll back to v${version}` });
    await promptStore.discardDraft();
    await promptStore.saveDraft(old.content, `Rollback to v${version}`, req.admin?.id).catch((err) => {
      if (!/same as the live/.test(err.message)) throw err;
    });
    const r = await applyPublish(req, { actor: req.admin, note: `Rollback to v${version}` });
    await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.prompt.rolled_back', entityType: 'rag_prompt', entityId: r.version, summary: `Rolled back to the text of v${version} (now v${r.version})` });
    sendSuccess(res, r, `Rolled back: v${version}'s text is live as v${r.version}`);
  } catch (err) { stepupFail(res, err, 'Rollback failed'); }
});

// ── Second-admin approval (D6: setting requireSecondApproval, default off) ───

router.get('/security/pending', async (req, res) => {
  try { sendSuccess(res, { pending: await pending.list(), required: Boolean((await settingsStore.getEffective()).requireSecondApproval) }); } catch (err) { fail(res, err, 'Could not load requests'); }
});

router.post('/security/pending/:id/approve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const p = await pending.get(id);
    if (!p || p.status !== 'pending') return sendError(res, null, 'This request is no longer pending', 400);
    if (Number(p.requestedBy) === Number(req.admin?.id)) return sendError(res, null, 'A second admin must approve this, not the one who asked.', 403);
    await requireToken(req, 'prompt.approve', `pending:${id}`);
    const d = await promptStore.draft();
    if (!d || d.id !== p.payload.draftId || d.hash !== p.payload.hash) {
      await pending.decide(id, 'expired', req.admin, 'The draft changed after the request');
      return sendError(res, null, 'The draft changed after this request, so nothing was published. Ask for a new request.', 409);
    }
    const requester = (await pending.adminById(p.requestedBy)) || req.admin;
    const r = await applyPublish(req, { actor: requester, note: `${d.note || ''} (approved by ${req.admin?.email})`.trim() });
    await pending.decide(id, 'approved', req.admin);
    await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.prompt.publish_approved', entityType: 'rag_prompt', entityId: r.version, summary: `Approved request #${id}; published v${r.version}` });
    sendSuccess(res, r, `Approved: v${r.version} is live`);
  } catch (err) { stepupFail(res, err, 'Approval failed'); }
});

router.post('/security/pending/:id/reject', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const p = await pending.get(id);
    if (!p || p.status !== 'pending') return sendError(res, null, 'This request is no longer pending', 400);
    await pending.decide(id, 'rejected', req.admin, String(req.body?.reason || '').slice(0, 255));
    await audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action: 'rag.prompt.publish_rejected', entityType: 'rag_prompt', entityId: id, summary: `Rejected request #${id}` });
    sendSuccess(res, {}, 'Rejected');
  } catch (err) { fail(res, err, 'Could not reject'); }
});

// ── Audit & Security screen ──────────────────────────────────────────────────

/** ?kind=security|prompt|tools|settings|knowledge (default all AI rows)&limit&offset */
router.get('/audit', async (req, res) => {
  try {
    const kinds = { security: ['rag_security'], prompt: ['rag_prompt'], tools: ['rag_tool'], settings: ['rag_settings'], knowledge: ['rag_source', 'rag_faq', 'rag_destination'], flows: ['bot_flow'] };
    const types = kinds[req.query.kind] || null;
    const lim = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const off = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const where = types ? `entity_type IN (${types.map((_, i) => `$${i + 1}`).join(',')})` : "(entity_type LIKE 'rag%' OR entity_type = 'bot_flow')";
    const { rows } = await db.query(`SELECT * FROM admin_audit_log WHERE ${where} ORDER BY id DESC LIMIT ${lim} OFFSET ${off}`, types || []);
    const { rows: warn } = await db.query("SELECT COUNT(*) AS n FROM admin_audit_log WHERE entity_type LIKE 'rag%' AND status = 'warning' AND created_at > (NOW() - INTERVAL 30 DAY)");
    sendSuccess(res, { items: rows, warnings30d: Number(warn[0]?.n || 0) });
  } catch (err) { fail(res, err, 'Could not load the audit log'); }
});

// ── Bot Connection: flows (Phase 16; the visual builder is Phase 17) ──────────

const flowStore = require('../flows/store');
const { validate: validateFlow } = require('../flows/schema');

const auditFlow = (req, action, key, summary, metadata) =>
  audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action, entityType: 'bot_flow', entityId: key, summary, metadata });

router.get('/flows', async (req, res) => {
  try { sendSuccess(res, { flows: await flowStore.list() }); } catch (err) { fail(res, err, 'Could not list flows'); }
});

router.get('/flows/:key', async (req, res) => {
  try {
    const f = await flowStore.get(req.params.key);
    if (!f) return sendError(res, null, 'Flow not found', 404);
    const check = validateFlow(f.draft, { tools: (await tools.list()).map((t) => ({ name: t.name, enabled: t.enabled })) });
    sendSuccess(res, { flow: f, check, versions: await flowStore.versions(req.params.key) });
  } catch (err) { fail(res, err, 'Could not load the flow'); }
});

/** Install the default flows (body: { force } republishes ones that already exist). */
router.post('/flows/install-defaults', async (req, res) => {
  try {
    const r = await require('../flows/seed').install({ force: Boolean(req.body?.force), adminId: req.admin?.id });
    await auditFlow(req, 'bot.flow.defaults_installed', null, r.map((x) => `${x.key}: ${x.action}${x.version ? ` v${x.version}` : ''}`).join(', '));
    sendSuccess(res, { results: r }, 'Default flows installed');
  } catch (err) { fail(res, err, 'Could not install the default flows'); }
});

router.post('/flows/validate', async (req, res) => {
  try { sendSuccess(res, validateFlow(req.body || {}, { tools: (await tools.list()).map((t) => ({ name: t.name, enabled: t.enabled })) })); } catch (err) { fail(res, err, 'Could not validate'); }
});

router.put('/flows/:key', async (req, res) => {
  try {
    const graph = { ...(req.body || {}), key: req.params.key };
    const r = await flowStore.saveDraft(graph, req.admin?.id);
    await auditFlow(req, 'bot.flow.draft_saved', req.params.key, `Draft saved (${(graph.nodes || []).length} nodes)`);
    sendSuccess(res, r, 'Draft saved');
  } catch (err) { fail(res, err, 'Could not save the flow'); }
});

router.post('/flows/:key/publish', async (req, res) => {
  try {
    const r = await flowStore.publish(req.params.key, req.admin?.id, String(req.body?.note || '').slice(0, 255));
    await auditFlow(req, 'bot.flow.published', req.params.key, `Published v${r.version}`);
    sendSuccess(res, r, `Published v${r.version} — new conversations use it`);
  } catch (err) { fail(res, err, 'Could not publish'); }
});

/** A published version's graph (history, diff). */
router.get('/flows/:key/versions/:version', async (req, res) => {
  try {
    const v = await flowStore.version(req.params.key, Number(req.params.version));
    if (!v) return sendError(res, null, 'Version not found', 404);
    sendSuccess(res, v);
  } catch (err) { fail(res, err, 'Could not load the version'); }
});

/** Rollback = the old version's graph becomes the draft and is published as a new version. */
router.post('/flows/:key/rollback', async (req, res) => {
  try {
    const version = Number(req.body?.version);
    const old = await flowStore.version(req.params.key, version);
    if (!old) return sendError(res, null, 'Version not found', 404);
    await flowStore.saveDraft({ ...old.graph, key: req.params.key }, req.admin?.id);
    const r = await flowStore.publish(req.params.key, req.admin?.id, `Rollback to v${version}`);
    await auditFlow(req, 'bot.flow.rolled_back', req.params.key, `Rolled back to v${version} (now v${r.version})`);
    sendSuccess(res, r, `v${version} is live again as v${r.version}`);
  } catch (err) { fail(res, err, 'Rollback failed'); }
});

/**
 * Preview ▶: run the DRAFT graph (from the body, so unsaved edits work too)
 * against live tools. The preview state lives in the builder, not in a session.
 * body: { graph, state?, input? }
 */
router.post('/flows/preview', async (req, res) => {
  try {
    const engine = require('../flows/engine');
    const flowsLib = require('../flows');
    const b = req.body || {};
    const graph = b.graph;
    const check = validateFlow(graph, { tools: (await tools.list()).map((t) => ({ name: t.name, enabled: t.enabled })) });
    if (!check.ok) return sendError(res, null, `Fix the problems first: ${check.errors[0]}`, 400);
    const today = orchestrator.todayInSeychelles(new Date());
    const text = b.input?.text || '';
    const state = b.state || { key: graph.key, version: 0, nodeId: graph.entry, waiting: false, vars: { ...flowsLib.varsFromText(text, today), today } };
    const ai = async (q) => (await orchestrator.handleTurn({ message: q, audience: 'admin', sessionId: `flow-preview-${req.admin?.id || 0}` })).reply;
    const r = await engine.run({
      graph,
      state,
      input: b.state ? b.input || {} : {},
      deps: {
        tools,
        ai,
        knowledge: ai,
        loadFlow: async (key) => (await flowStore.published()).find((f) => f.key === key) || null,
        startChips: orchestrator.START_CHIPS,
        today,
        userId: null,
        links: require('../tools/catalog/site').links,
      },
    });
    sendSuccess(res, r);
  } catch (err) { fail(res, err, 'Preview failed'); }
});

router.post('/flows/:key/archive', async (req, res) => {
  try {
    await flowStore.setStatus(req.params.key, 'archived');
    await auditFlow(req, 'bot.flow.archived', req.params.key, 'Archived — no longer starts');
    sendSuccess(res, {}, 'Archived');
  } catch (err) { fail(res, err, 'Could not archive'); }
});

router.delete('/flows/:key', async (req, res) => {
  try {
    await flowStore.remove(req.params.key);
    await auditFlow(req, 'bot.flow.deleted', req.params.key, 'Deleted');
    sendSuccess(res, {}, 'Deleted');
  } catch (err) { fail(res, err, 'Could not delete'); }
});

// ── Playground, feedback & analytics (Phase 19) ──────────────────────────────

const insights = require('../insights/analytics');
const convos = require('../insights/conversations');
const suite = require('../insights/tests');
const review = require('../insights/review');
const { sandboxFor } = require('../insights/sandbox');

const auditInsight = (req, action, id, summary, metadata) =>
  audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action, entityType: 'rag_insight', entityId: id, summary, metadata });

/** The visitor's full path (flows, then the assistant, with memory) in a sandbox, against the draft or published prompt. */
router.post('/playground/chat', async (req, res) => {
  try {
    const b = req.body || {};
    const key = `${req.admin?.id || 0}:${String(b.key || 'default').slice(0, 40)}`;
    const box = sandboxFor(key, { promptRef: b.promptRef || 'published', reset: Boolean(b.reset) });
    if (b.reset && !b.message && !b.action) return sendSuccess(res, { reset: true });
    const out = await box.turn(b.message || '', { action: b.action });
    traces.save({ sessionId: `playground-${req.admin?.id || 0}`, audience: 'admin', message: b.message || b.action?.label || '', reply: out.reply, trace: out.trace }).catch(() => {});
    sendSuccess(res, out);
  } catch (err) { fail(res, err, 'The turn failed'); }
});

router.get('/analytics', async (req, res) => {
  try { sendSuccess(res, await insights.analytics({ days: req.query.days })); } catch (err) { fail(res, err, 'Could not load the analytics'); }
});

router.get('/analytics/usage', async (req, res) => {
  try { sendSuccess(res, await insights.usage({ days: req.query.days })); } catch (err) { fail(res, err, 'Could not load the usage'); }
});

/** CSV of one analytics table: perDay | questions | tools | usage | models. */
router.get('/analytics/export', async (req, res) => {
  try {
    const t = String(req.query.table || 'perDay');
    const a = ['usage', 'models'].includes(t) ? await insights.usage({ days: req.query.days }) : await insights.analytics({ days: req.query.days });
    const tables = {
      perDay: () => [a.perDay, [{ key: 'day', label: 'Day' }, { key: 'chats', label: 'Chats' }, { key: 'turns', label: 'Answers' }]],
      questions: () => [a.topQuestions, [{ key: 'question', label: 'Question' }, { key: 'count', label: 'Times asked' }]],
      tools: () => [a.tools, [{ key: 'tool', label: 'Tool' }, { key: 'calls', label: 'Calls' }, { key: 'ok', label: 'Succeeded' }, { label: 'Success rate', value: (r) => (r.successRate === null ? '' : `${Math.round(r.successRate * 100)}%`) }]],
      usage: () => [a.perDay, [{ key: 'day', label: 'Day' }, { key: 'calls', label: 'Model calls' }, { key: 'tokensIn', label: 'Tokens in' }, { key: 'tokensOut', label: 'Tokens out' }, { key: 'cost', label: 'Estimated cost' }, { key: 'errors', label: 'Errors' }]],
      models: () => [a.perModel, [{ key: 'model', label: 'Model' }, { key: 'purpose', label: 'Purpose' }, { key: 'calls', label: 'Calls' }, { key: 'tokensIn', label: 'Tokens in' }, { key: 'tokensOut', label: 'Tokens out' }, { key: 'cost', label: 'Estimated cost' }, { key: 'errors', label: 'Errors' }, { key: 'avgMs', label: 'Avg ms' }]],
    };
    if (!tables[t]) return sendError(res, null, 'Unknown table', 400);
    const [rows, cols] = tables[t]();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-${t}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(`﻿${insights.toCsv(rows, cols)}`);
  } catch (err) { fail(res, err, 'Could not export'); }
});

router.get('/conversations', async (req, res) => {
  try { sendSuccess(res, await convos.listConversations(req.query)); } catch (err) { fail(res, err, 'Could not load conversations'); }
});

router.get('/conversations/:id', async (req, res) => {
  try {
    const c = await convos.getConversation(req.params.id);
    await auditInsight(req, 'rag.conversation.viewed', null, `Opened a transcript (${c.messages.length} messages)`, { sessionId: c.id });
    sendSuccess(res, c);
  } catch (err) { fail(res, err, 'Could not load the conversation'); }
});

router.get('/feedback', async (req, res) => {
  try { sendSuccess(res, await convos.feedbackQueue({ status: req.query.status, limit: req.query.limit })); } catch (err) { fail(res, err, 'Could not load feedback'); }
});

router.post('/feedback/:id/fix', async (req, res) => {
  try {
    const r = await convos.fixWithFaq(Number(req.params.id), req.body || {}, req.admin?.id);
    await auditInsight(req, 'rag.feedback.fixed', req.params.id, `Fixed a 👎 with FAQ #${r.faqId}${r.published ? ' (published)' : ' (draft)'}`, { faqId: r.faqId });
    sendSuccess(res, r, r.published ? 'Fixed — the FAQ is live' : 'Fixed — the FAQ is saved as a draft');
  } catch (err) { fail(res, err, 'Could not fix'); }
});

router.post('/feedback/:id/dismiss', async (req, res) => {
  try {
    await convos.dismissFeedback(Number(req.params.id), req.body?.note, req.admin?.id);
    sendSuccess(res, {}, 'Dismissed');
  } catch (err) { fail(res, err, 'Could not dismiss'); }
});

router.get('/tests/cases', async (req, res) => {
  try { sendSuccess(res, { cases: await suite.listCases() }); } catch (err) { fail(res, err, 'Could not load test cases'); }
});
router.post('/tests/cases', async (req, res) => {
  try { sendSuccess(res, await suite.createCase(req.body || {}, req.admin?.id), 'Test case added', 201); } catch (err) { fail(res, err, 'Could not add the test case'); }
});
router.post('/tests/seed', async (req, res) => {
  try { const r = await suite.seedStarter(req.admin?.id); sendSuccess(res, r, r.added ? `Added ${r.added} starter test cases` : 'You already have test cases'); } catch (err) { fail(res, err, 'Could not add the starter cases'); }
});
router.put('/tests/cases/:id', async (req, res) => {
  try { sendSuccess(res, await suite.updateCase(Number(req.params.id), req.body || {}), 'Saved'); } catch (err) { fail(res, err, 'Could not save'); }
});
router.delete('/tests/cases/:id', async (req, res) => {
  try { sendSuccess(res, await suite.deleteCase(Number(req.params.id)), 'Deleted'); } catch (err) { fail(res, err, 'Could not delete'); }
});
router.post('/tests/run', async (req, res) => {
  try {
    const r = await suite.startRun({ promptRef: req.body?.promptRef, caseIds: req.body?.caseIds }, req.admin?.id);
    sendSuccess(res, r, 'Running the test suite', 202);
  } catch (err) { fail(res, err, 'Could not start the run'); }
});
router.get('/tests/runs', async (req, res) => {
  try { sendSuccess(res, { runs: await suite.listRuns(req.query) }); } catch (err) { fail(res, err, 'Could not load runs'); }
});
router.get('/tests/runs/:id', async (req, res) => {
  try { sendSuccess(res, await suite.getRun(Number(req.params.id))); } catch (err) { fail(res, err, 'Could not load the run'); }
});
router.get('/tests/compare', async (req, res) => {
  try { sendSuccess(res, await suite.compareRuns(Number(req.query.a), Number(req.query.b))); } catch (err) { fail(res, err, 'Could not compare'); }
});

router.get('/suggestions', async (req, res) => {
  try { sendSuccess(res, { suggestions: await review.listSuggestions({ status: req.query.status }) }); } catch (err) { fail(res, err, 'Could not load suggestions'); }
});
router.post('/suggestions/refresh', async (req, res) => {
  try { sendSuccess(res, await review.refreshSuggestions({ days: req.body?.days }), 'Unanswered questions grouped'); } catch (err) { fail(res, err, 'Could not group the questions'); }
});
router.post('/suggestions/:id/draft', async (req, res) => {
  try {
    const r = await review.draftFromSuggestion(Number(req.params.id), req.body || {}, req.admin?.id);
    await auditInsight(req, 'rag.suggestion.drafted', req.params.id, `Draft FAQ #${r.faqId} from an unanswered question`, { faqId: r.faqId });
    sendSuccess(res, r, 'Saved as a draft FAQ — review and publish it in AI Questions Training');
  } catch (err) { fail(res, err, 'Could not create the draft'); }
});
router.post('/suggestions/:id/dismiss', async (req, res) => {
  try { sendSuccess(res, await review.dismissSuggestion(Number(req.params.id)), 'Dismissed'); } catch (err) { fail(res, err, 'Could not dismiss'); }
});

router.get('/conflicts', async (req, res) => {
  try { sendSuccess(res, { conflicts: await review.listConflicts({ status: req.query.status }) }); } catch (err) { fail(res, err, 'Could not load conflicts'); }
});
router.post('/conflicts/scan', async (req, res) => {
  try { sendSuccess(res, await review.scanConflicts(), 'Knowledge checked'); } catch (err) { fail(res, err, 'Could not check the knowledge'); }
});
router.post('/conflicts/:id', async (req, res) => {
  try { sendSuccess(res, await review.setConflict(Number(req.params.id), String(req.body?.status || '')), 'Saved'); } catch (err) { fail(res, err, 'Could not save'); }
});

// ── API connectors (extra track 2.3 / 2.4) ────────────────────────────────────
// Our own GET routes and outside GET APIs the assistant may call as tools.

const connectors = require('../tools/connectors');
const auditConn = (req, action, id, summary) =>
  audit({ req, adminId: req.admin?.id, adminEmail: req.admin?.email, action, entityType: 'rag_connector', entityId: id, summary });

router.get('/connectors', async (req, res) => {
  try {
    sendSuccess(res, { connectors: await connectors.list({ fresh: true }), routes: connectors.discover(), cache: require('../../services/cache').stats() });
  } catch (err) { fail(res, err, 'Could not load the APIs'); }
});

router.post('/connectors', async (req, res) => {
  try {
    const c = await connectors.create(req.body || {}, req.admin?.id);
    await auditConn(req, 'rag.connector.created', c.id, `Added ${c.kind === 'external' ? 'outside' : 'our'} API “${c.name}” (${c.url})${c.enabled ? ', on for the assistant' : ''}`);
    if (c.kind === 'external' && c.enabled) require('../security/emails').sendChangeNotice({ actor: req.admin, what: `Outside API "${c.name}" (${c.url}) is now used by the assistant`, section: 'rag-tools' }).catch(() => {});
    sendSuccess(res, c, 'API added', 201);
  } catch (err) { fail(res, err, 'Could not add the API'); }
});

router.put('/connectors/:id', async (req, res) => {
  try {
    const before = connectors.shape(await connectors.getRow(Number(req.params.id)));
    const c = await connectors.update(Number(req.params.id), req.body || {});
    const turnedOn = !before.enabled && c.enabled;
    await auditConn(req, 'rag.connector.updated', c.id, `Saved “${c.name}”${before.enabled !== c.enabled ? ` (now ${c.enabled ? 'on' : 'off'} for the assistant)` : ''}`);
    if (turnedOn && c.kind === 'external') require('../security/emails').sendChangeNotice({ actor: req.admin, what: `Outside API "${c.name}" (${c.url}) is now used by the assistant`, section: 'rag-tools' }).catch(() => {});
    sendSuccess(res, c, 'Saved');
  } catch (err) { fail(res, err, 'Could not save'); }
});

router.delete('/connectors/:id', async (req, res) => {
  try {
    const before = connectors.shape(await connectors.getRow(Number(req.params.id)));
    await connectors.remove(Number(req.params.id));
    await auditConn(req, 'rag.connector.deleted', before.id, `Removed “${before.name}” from the assistant (the API itself is untouched)`);
    sendSuccess(res, {}, 'Removed');
  } catch (err) { fail(res, err, 'Could not remove'); }
});

/** body: { args } — a real call, cache skipped. */
router.post('/connectors/:id/test', async (req, res) => {
  try {
    const c = connectors.shape(await connectors.getRow(Number(req.params.id)));
    const t0 = Date.now();
    const r = await connectors.call(c, req.body?.args || {}, { skipCache: true });
    sendSuccess(res, { ...r, ms: Date.now() - t0, url: connectors.buildUrl(c, req.body?.args || {}, '') });
  } catch (err) { fail(res, err, 'The test call failed'); }
});

/** Forget cached answers so the next question fetches the newest data. */
router.post('/connectors/:id/refresh', async (req, res) => {
  try {
    await require('../../services/cache').delPrefix(`conn:${Number(req.params.id)}:`);
    sendSuccess(res, {}, 'Cached answers cleared — the next call fetches fresh data');
  } catch (err) { fail(res, err, 'Could not clear'); }
});

const PLANNED = {};

router.use('/:section', (req, res) => {
  const phase = PLANNED[req.params.section];
  res.status(phase ? 501 : 404).json({
    status: 'error',
    message: phase ? `This part of the AI assistant is built in phase ${phase}.` : 'Unknown AI section',
  });
});

module.exports = router;
