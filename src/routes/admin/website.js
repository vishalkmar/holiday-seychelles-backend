/**
 * Website configuration — home hero and header logo.
 *
 *   GET  /api/admin/website/settings        current settings + defaults
 *   PUT  /api/admin/website/settings        replace (normalised server-side)
 *   POST /api/admin/website/settings/reset  back to the shipped defaults
 *   POST /api/admin/website/media           upload one image or video
 *
 * Media goes to Cloudinary when it is configured (same account as the blog
 * images), otherwise to `uploads/site/` on this server. Either way the URL that
 * comes back is absolute, because the public site is served from a different
 * origin than this API and a relative `/uploads/...` would point at the wrong
 * host.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const slugify = require('slugify');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const website = require('../../services/websiteSettings');

const router = express.Router();

const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 60 * 1024 * 1024;

const hasCloudinary = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

function siteUploadsDir() {
  const dir = path.join(__dirname, '../../..', process.env.UPLOAD_DIR || 'uploads', 'site');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function kindOf(mimetype = '') {
  if (/^image\/(png|jpe?g|webp|gif|svg\+xml|avif)$/.test(mimetype)) return 'image';
  if (/^video\/(mp4|webm|quicktime|ogg)$/.test(mimetype)) return 'video';
  return null;
}

function safeBase(originalname, fallback) {
  const ext = path.extname(originalname || '');
  return (
    slugify(path.basename(originalname || fallback, ext), { lower: true, strict: true }).slice(0, 60) ||
    fallback
  );
}

const upload = multer({
  storage: hasCloudinary
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, siteUploadsDir()),
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 6);
          cb(null, `site-${Date.now()}-${safeBase(file.originalname, 'media')}${ext}`);
        },
      }),
  // The video ceiling; images are held to their own lower limit after upload.
  limits: { fileSize: VIDEO_MAX },
  fileFilter: (_req, file, cb) => {
    if (!kindOf(file.mimetype)) {
      cb(new Error('Only images (JPG, PNG, WebP, GIF, SVG) and videos (MP4, WebM, MOV) can be uploaded'));
      return;
    }
    cb(null, true);
  },
});

async function uploadToCloudinary(file, kind) {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `${process.env.CLOUDINARY_FOLDER_SITE || 'holiday-seychelles/site'}`;
  const publicId = `${safeBase(file.originalname, 'media')}-${Date.now()}`;

  const signature = crypto
    .createHash('sha1')
    .update(`folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`)
    .digest('hex');

  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'media');
  form.append('api_key', process.env.CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('public_id', publicId);
  form.append('signature', signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${kind}/upload`,
    { method: 'POST', body: form }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'Cloudinary upload failed');
  return data.secure_url;
}

/** Absolute base of this API, honouring the proxy cPanel puts in front of it. */
function publicBase(req) {
  if (process.env.PUBLIC_API_BASE_URL) return process.env.PUBLIC_API_BASE_URL.replace(/\/api\/?$/, '').replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

// ── Settings ─────────────────────────────────────────────────────────────────

router.get('/settings', adminAuth, async (req, res) => {
  try {
    const settings = await website.getSettings();
    sendSuccess(
      res,
      { settings, defaults: website.DEFAULTS, heroTypes: website.HERO_TYPES, storage: hasCloudinary ? 'cloudinary' : 'server' },
      'Website settings retrieved'
    );
  } catch (err) {
    console.error('website settings error:', err);
    sendError(res, err, 'Failed to load the website settings', 500);
  }
});

router.put('/settings', adminAuth, async (req, res) => {
  try {
    const settings = await website.saveSettings(req.body, req.admin.id);
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.website.settings_updated',
      entityType: 'settings',
      summary: `Updated the website configuration (hero: ${settings.homeHero.type})`,
    });
    sendSuccess(res, { settings }, 'Website settings saved');
  } catch (err) {
    console.error('website settings save error:', err);
    sendError(res, err, 'Failed to save the website settings', 500);
  }
});

router.post('/settings/reset', adminAuth, async (req, res) => {
  try {
    const settings = await website.resetSettings(req.admin.id);
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.website.settings_reset',
      entityType: 'settings',
      summary: 'Reset the website configuration to the defaults',
    });
    sendSuccess(res, { settings }, 'Website settings reset');
  } catch (err) {
    console.error('website settings reset error:', err);
    sendError(res, err, 'Failed to reset the website settings', 500);
  }
});

// ── Media ────────────────────────────────────────────────────────────────────

router.post('/media', adminAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return sendError(res, null, 'Choose an image or a video', 400);

    const kind = kindOf(req.file.mimetype);
    if (kind === 'image' && req.file.size > IMAGE_MAX) {
      if (req.file.path) fs.unlink(req.file.path, () => {});
      return sendError(res, null, 'Images must be 8MB or smaller', 413);
    }

    const url = hasCloudinary
      ? await uploadToCloudinary(req.file, kind)
      : `${publicBase(req)}/uploads/site/${req.file.filename}`;

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.website.media_uploaded',
      entityType: 'settings',
      summary: `Uploaded website ${kind} (${req.file.originalname})`,
    });

    sendSuccess(res, { url, kind, name: req.file.originalname, size: req.file.size }, 'Uploaded', 201);
  } catch (err) {
    console.error('website media upload error:', err);
    sendError(res, err, 'Failed to upload the file', 500);
  }
});

// Multer rejections arrive here; without this a too-large file returns
// Express's HTML error page and the panel shows "unexpected token <".
router.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, null, 'Videos must be 60MB or smaller', 413);
  }
  if (/can be uploaded/.test(err.message || '')) {
    return sendError(res, null, err.message, 415);
  }
  console.error('website route error:', err);
  return sendError(res, err, 'Something went wrong handling that request', 500);
});

module.exports = router;
