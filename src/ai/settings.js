/**
 * Admin-editable AI settings, stored in rag_settings.
 *
 * Defaults live here; a saved row overrides its default. Secrets (the NVIDIA
 * key) are saved encrypted and only ever leave this file masked. Where a key
 * exists in both places, the admin-saved one wins over .env, so the key can be
 * rotated from the panel without a deploy.
 *
 * Model names are deliberately settings, not code (DESIGN.md §3.1): they are
 * picked from the account's own model list in AI Settings.
 *
 * Defaults were chosen by testing this NVIDIA account on 2026-10-16: many
 * models in /v1/models answer 404 "not found for account" and several free
 * endpoints time out under load, so the chat model has an ordered fallback
 * chain. Only 2048-dimension embedding models are callable.
 */

const { db } = require('./ports');
const { ensureAiTables } = require('./db');
const { config } = require('./config');
const { encrypt, decrypt, mask } = require('./secrets');

/** Every setting the admin can change, with its default and bounds. */
const SCHEMA = {
  chatModel: { type: 'string', default: 'nvidia/nemotron-3-super-120b-a12b', max: 160 },
  // Tried in order when the chat model fails (timeout, 404, quota, server error).
  chatFallbackModels: {
    type: 'list',
    default: ['openai/gpt-oss-20b', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'deepseek-ai/deepseek-v4.1-flash'],
    maxItems: 5,
    max: 160,
  },
  // No fallback for embeddings: vectors from two models are not comparable, so
  // switching model silently would corrupt search. A failed embed is an error.
  // Intent & slot extraction (Phase 10): a fast model; empty = the chat chain.
  routerModel: { type: 'string', default: 'openai/gpt-oss-20b', max: 160 },
  embedModel: { type: 'string', default: 'nvidia/nemotron-3-embed-1b', max: 160 },
  rerankModel: { type: 'string', default: 'nvidia/nv-rerankqa-mistral-4b-v3', max: 160 },
  // Hosted rerankers live on a different host than chat/embeddings.
  rerankUrl: { type: 'string', default: 'https://ai.api.nvidia.com/v1/retrieval/nvidia/nv-rerankqa-mistral-4b-v3/reranking', max: 300 },
  rerankEnabled: { type: 'boolean', default: false },
  temperature: { type: 'number', default: 0.2, min: 0, max: 1.5 },
  // Reasoning models spend ~150–300 tokens thinking before they answer.
  maxTokens: { type: 'number', default: 1200, min: 64, max: 4096, int: true },
  timeoutMs: { type: 'number', default: 30000, min: 3000, max: 120000, int: true },
  // How long to wait on a model that still has a fallback after it, before moving on.
  fallbackAfterMs: { type: 'number', default: 15000, min: 2000, max: 60000, int: true },
  requestsPerMinute: { type: 'number', default: 40, min: 1, max: 1000, int: true },
  embedBatchSize: { type: 'number', default: 32, min: 1, max: 128, int: true },
  // Chunking (Phase 4). Target size of a chunk, overlap carried into the next,
  // and a cap so one huge file cannot flood the index.
  chunkTokens: { type: 'number', default: 500, min: 150, max: 1200, int: true },
  chunkOverlapPct: { type: 'number', default: 15, min: 0, max: 40, int: true },
  maxChunksPerSource: { type: 'number', default: 2000, min: 10, max: 20000, int: true },
  // Retrieval (Phase 8). Candidates from each of vector and keyword search,
  // fused by rank; chunks kept for the answer; best semantic score below
  // retrievalMinScore → "not enough knowledge" (no guessing).
  retrievalCandidates: { type: 'number', default: 20, min: 5, max: 100, int: true },
  retrievalTopK: { type: 'number', default: 6, min: 1, max: 20, int: true },
  // Keyword boost: a chunk's semantic score × (1 + w / (1 + keyword rank)).
  retrievalKeywordWeight: { type: 'number', default: 0.7, min: 0, max: 3 },
  retrievalMinScore: { type: 'number', default: 0.35, min: 0, max: 0.95 },
  retrievalContextTokens: { type: 'number', default: 2500, min: 300, max: 8000, int: true },
  // Public chat (Phase 14): limits per visitor session, and the widget's look.
  chatMessagesPerMinute: { type: 'number', default: 8, min: 1, max: 60, int: true },
  chatDailyTokenBudget: { type: 'number', default: 60000, min: 2000, max: 2000000, int: true },
  chatMaxMessageChars: { type: 'number', default: 1000, min: 100, max: 4000, int: true },
  widgetEnabled: { type: 'boolean', default: true },
  // Phase 20: off = guided flows only; a free question gets the menu and the team's contact, no AI answer.
  aiFreeText: { type: 'boolean', default: true },
  // Phase 20 soft launch: 'admins' shows the widget only to signed-in admins (their browser sends the admin token).
  widgetAudience: { type: 'string', default: 'everyone', max: 10 },
  widgetTitle: { type: 'string', default: 'Seychelles travel assistant', max: 60 },
  widgetSubtitle: { type: 'string', default: 'Islands, hotels, excursions & transfers', max: 80 },
  widgetAccent: { type: 'string', default: '#2563EB', max: 9 },
  widgetPosition: { type: 'string', default: 'right', max: 5 },
  // Prompt security (Phase 12, D6): publishing the business instructions also
  // needs a second admin's approval. Off by default.
  requireSecondApproval: { type: 'boolean', default: false },
  // Prompt (Phase 11): token budget for L1–L4 + history; history and old tool
  // results are trimmed first, then knowledge. The core rules never are.
  promptBudgetTokens: { type: 'number', default: 6000, min: 2000, max: 30000, int: true },
  // Estimated cost per 1k tokens, for the usage dashboard. 0 while on the free tier.
  costPer1kIn: { type: 'number', default: 0, min: 0, max: 100 },
  costPer1kOut: { type: 'number', default: 0, min: 0, max: 100 },
};

const SECRET_KEYS = ['nvidiaApiKey'];

let cache = null;
let cachedAt = 0;
const CACHE_MS = 15000;

function clean(key, value) {
  const spec = SCHEMA[key];
  if (!spec) throw Object.assign(new Error(`Unknown setting "${key}"`), { status: 400 });
  if (spec.type === 'string') {
    const s = String(value ?? '').trim();
    if (!s) throw Object.assign(new Error(`${key} cannot be empty`), { status: 400 });
    return s.slice(0, spec.max);
  }
  if (spec.type === 'boolean') return value === true || value === 'true';
  if (spec.type === 'list') {
    const items = (Array.isArray(value) ? value : String(value ?? '').split(','))
      .map((v) => String(v).trim())
      .filter(Boolean)
      .map((v) => v.slice(0, spec.max));
    return [...new Set(items)].slice(0, spec.maxItems);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw Object.assign(new Error(`${key} must be a number`), { status: 400 });
  const bounded = Math.min(spec.max, Math.max(spec.min, n));
  return spec.int ? Math.round(bounded) : bounded;
}

async function loadRows() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  await ensureAiTables();
  const { rows } = await db.query('SELECT setting_key, value_json, is_secret, updated_at FROM rag_settings');
  cache = new Map(
    rows.map((r) => {
      let v = r.value_json;
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { /* keep raw */ }
      }
      return [r.setting_key, { value: v, isSecret: Boolean(r.is_secret), updatedAt: r.updated_at }];
    })
  );
  cachedAt = Date.now();
  return cache;
}

function clearCache() {
  cache = null;
}

/**
 * Settings that may also be given in the backend .env, so the model choice is
 * visible there. Order of precedence: saved in AI Settings → .env → default.
 */
const ENV_OVERRIDES = {
  chatModel: 'RAG_CHAT_MODEL',
  chatFallbackModels: 'RAG_CHAT_FALLBACK_MODELS', // comma-separated
  embedModel: 'RAG_EMBED_MODEL',
};

function envDefault(key, spec) {
  const name = ENV_OVERRIDES[key];
  const raw = name ? process.env[name] : undefined;
  if (raw === undefined || String(raw).trim() === '') return spec.default;
  try {
    return clean(key, raw);
  } catch {
    return spec.default;
  }
}

/** Where each overridable setting currently comes from: 'admin' | 'env' | 'default'. */
function sourceOf(key, rows) {
  if (rows.has(key)) return 'admin';
  const name = ENV_OVERRIDES[key];
  return name && String(process.env[name] || '').trim() ? 'env' : 'default';
}

/** Effective settings for the engine (secrets decrypted). Never send this to a client. */
async function getEffective() {
  const rows = await loadRows();
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    out[key] = rows.has(key) ? rows.get(key).value : envDefault(key, spec);
  }
  const savedKey = rows.has('nvidiaApiKey') ? decrypt(rows.get('nvidiaApiKey').value) : null;
  out.nvidiaApiKey = savedKey || config.nvidia.apiKey || '';
  out.nvidiaKeySource = savedKey ? 'admin' : config.nvidia.apiKey ? 'env' : 'none';
  out.baseUrl = config.nvidia.baseUrl;
  return out;
}

/** What the admin screen sees: values, defaults, and secrets masked. */
async function getPublic() {
  const eff = await getEffective();
  const rows = await loadRows();
  const values = {};
  for (const key of Object.keys(SCHEMA)) values[key] = eff[key];
  return {
    values,
    sources: Object.fromEntries(Object.keys(ENV_OVERRIDES).map((k) => [k, sourceOf(k, rows)])),
    defaults: Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, envDefault(k, s)])),
    schema: Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, { type: s.type, min: s.min, max: s.max, maxItems: s.maxItems }])),
    nvidia: {
      keySet: Boolean(eff.nvidiaApiKey),
      keyMasked: mask(eff.nvidiaApiKey),
      keySource: eff.nvidiaKeySource,
      baseUrl: eff.baseUrl,
      canSaveSecrets: config.secretKeySet,
      keyUpdatedAt: rows.get('nvidiaApiKey')?.updatedAt || null,
    },
  };
}

/** Save plain settings. Returns the list of changed keys. */
async function update(changes, adminId) {
  await ensureAiTables();
  const rows = await loadRows();
  const changed = [];
  for (const [key, raw] of Object.entries(changes || {})) {
    if (SECRET_KEYS.includes(key)) continue; // secrets go through setSecret
    const value = clean(key, raw);
    const current = rows.has(key) ? rows.get(key).value : envDefault(key, SCHEMA[key]);
    if (JSON.stringify(current) === JSON.stringify(value)) continue;
    await db.query(
      `INSERT INTO rag_settings (setting_key, value_json, is_secret, updated_by)
       VALUES ($1, $2, FALSE, $3)
       ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), is_secret = FALSE, updated_by = VALUES(updated_by)`,
      [key, JSON.stringify(value), adminId || null]
    );
    changed.push(key);
  }
  clearCache();
  return changed;
}

/** Save (or with an empty value, remove) the admin-held NVIDIA key, encrypted. */
async function setSecret(key, plain, adminId) {
  if (!SECRET_KEYS.includes(key)) throw Object.assign(new Error('Unknown secret'), { status: 400 });
  await ensureAiTables();
  if (!plain) {
    await db.query('DELETE FROM rag_settings WHERE setting_key = $1', [key]);
  } else {
    const sealed = encrypt(String(plain).trim());
    await db.query(
      `INSERT INTO rag_settings (setting_key, value_json, is_secret, updated_by)
       VALUES ($1, $2, TRUE, $3)
       ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), is_secret = TRUE, updated_by = VALUES(updated_by)`,
      [key, JSON.stringify(sealed), adminId || null]
    );
  }
  clearCache();
}

module.exports = { SCHEMA, getEffective, getPublic, update, setSecret, clean, clearCache };
