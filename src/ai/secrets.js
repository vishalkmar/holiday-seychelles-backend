/**
 * Encryption for secrets saved from the admin panel (API keys).
 *
 * AES-256-GCM with RAG_SECRET_KEY (32 bytes, base64 or 64 hex). The stored form
 * is "v1:<iv>:<tag>:<ciphertext>" in base64 parts, so a later key or algorithm
 * change can be told apart. Without RAG_SECRET_KEY, saving secrets is refused —
 * they are never written in plain text.
 */

const crypto = require('crypto');

function keyFrom(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  return b.length === 32 ? b : null;
}

function encrypt(plain, rawKey = process.env.RAG_SECRET_KEY) {
  const key = keyFrom(rawKey);
  if (!key) throw Object.assign(new Error('RAG_SECRET_KEY is missing or not 32 bytes, so secrets cannot be saved.'), { code: 'NO_SECRET_KEY' });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(stored, rawKey = process.env.RAG_SECRET_KEY) {
  const key = keyFrom(rawKey);
  if (!key || typeof stored !== 'string') return null;
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key or tampered value
  }
}

/** "nvapi-…" → "nvap••••••3f9a": enough to recognise, useless to copy. */
function mask(secret) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}••••••${s.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask, keyFrom };
