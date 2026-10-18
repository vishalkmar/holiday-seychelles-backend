/**
 * Configuration for the AI assistant module, read once from the environment.
 *
 * Nothing here is required for the rest of the backend to run: with no keys
 * set the module reports "not configured" in the admin overview and the public
 * chat answers 503. Problems are collected as warnings instead of throwing, so
 * a typo in an AI setting can never take the booking site down.
 *
 * See docs/rag-system/DESIGN.md §7.
 */

const path = require('path');

const VECTOR_DRIVERS = ['mysql', 'pinecone'];

function int(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function load(env = process.env) {
  const warnings = [];

  const requestedDriver = String(env.RAG_VECTOR_DRIVER || 'mysql').trim().toLowerCase();
  let vectorDriver = VECTOR_DRIVERS.includes(requestedDriver) ? requestedDriver : 'mysql';
  if (!VECTOR_DRIVERS.includes(requestedDriver)) {
    warnings.push(`RAG_VECTOR_DRIVER "${requestedDriver}" is not supported; using mysql.`);
  }

  // Either the index host, or the index name (its host is looked up from the
  // Pinecone control plane when the driver starts — Phase 3).
  const pinecone = {
    apiKey: env.PINECONE_API_KEY || '',
    index: env.PINECONE_INDEX || '',
    indexHost: String(env.PINECONE_INDEX_HOST || '').replace(/\/+$/, ''),
    cloud: env.PINECONE_CLOUD || 'aws',
    region: env.PINECONE_REGION || 'us-east-1',
    namespace: env.PINECONE_NAMESPACE || 'holidays-seychelles',
  };
  pinecone.configured = Boolean(pinecone.apiKey && (pinecone.indexHost || pinecone.index));
  if (vectorDriver === 'pinecone' && !pinecone.configured) {
    warnings.push('RAG_VECTOR_DRIVER is pinecone but PINECONE_API_KEY and PINECONE_INDEX (or PINECONE_INDEX_HOST) are missing; using mysql.');
    vectorDriver = 'mysql';
  }

  const secretKey = env.RAG_SECRET_KEY || '';
  if (secretKey && Buffer.from(secretKey, 'base64').length !== 32 && secretKey.length !== 64) {
    warnings.push('RAG_SECRET_KEY should be 32 bytes (base64) or 64 hex characters.');
  }

  const nvidia = {
    apiKey: env.NVIDIA_API_KEY || '',
    baseUrl: String(env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
  };
  nvidia.configured = Boolean(nvidia.apiKey);

  const backendRoot = path.join(__dirname, '..', '..');
  const storageDir = path.resolve(backendRoot, env.RAG_STORAGE_DIR || 'storage/rag');

  return {
    nvidia,
    vector: { requested: requestedDriver, driver: vectorDriver, pinecone },
    secretKeySet: Boolean(secretKey),
    storageDir,
    maxUploadMb: int(env.RAG_MAX_UPLOAD_MB, 20, { min: 1, max: 100 }),
    chatRetentionDays: int(env.CHAT_RETENTION_DAYS, 90, { min: 1, max: 3650 }),
    chatEnabled: env.CHAT_ENABLED !== 'false',
    warnings,
  };
}

const config = load();

module.exports = { config, load, VECTOR_DRIVERS };
