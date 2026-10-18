/**
 * Private file storage for uploaded training documents.
 *
 * Lives under the backend root (storage/rag by default), not under uploads/,
 * which express serves publicly. A deny-all .htaccess is written too, in case
 * the hosting ever maps the app folder to a web root.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const DENY_ALL = 'Require all denied\nDeny from all\n';

function ensureStorage(dir = config.storageDir) {
  fs.mkdirSync(dir, { recursive: true });
  const htaccess = path.join(dir, '.htaccess');
  if (!fs.existsSync(htaccess)) fs.writeFileSync(htaccess, DENY_ALL);
  return dir;
}

/** { ok, path, writable, reason? } for the admin overview. */
function storageHealth(dir = config.storageDir) {
  try {
    ensureStorage(dir);
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true, writable: true, path: dir };
  } catch (err) {
    return { ok: false, writable: false, path: dir, reason: err.message };
  }
}

/** True when `dir` is inside the publicly served uploads folder (must never be). */
function isPublic(dir = config.storageDir) {
  const uploads = path.resolve(path.join(__dirname, '..', '..'), process.env.UPLOAD_DIR || 'uploads');
  const rel = path.relative(uploads, path.resolve(dir));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { ensureStorage, storageHealth, isPublic };
