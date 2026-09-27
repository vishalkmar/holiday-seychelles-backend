/**
 * Content studio.
 *
 * Posts, their publishing state and their readership. Three rules live here:
 *
 *  1. **The slug only changes when asked.** Regenerating it on a title edit
 *     breaks every link anybody has already shared.
 *  2. **published_at survives a re-save.** An edit to a year-old post must not
 *     make it look new.
 *  3. **Status, published_at and scheduled_for are set together** by
 *     publishingState(), or a post ends up both scheduled and live.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const slugify = require('slugify');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const { runLimited } = require('../../utils/concurrency');

const router = express.Router();
const uploadsDir = path.join(__dirname, '../../..', process.env.UPLOAD_DIR || 'uploads');
const hasCloudinaryConfig = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const base = slugify(path.basename(file.originalname || 'blog-image', ext), {
      lower: true,
      strict: true,
    }) || 'blog-image';
    cb(null, `blog-${Date.now()}-${base}${ext}`);
  },
});

const upload = multer({
  storage: hasCloudinaryConfig ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) {
      cb(new Error('Only image uploads are allowed'));
      return;
    }
    cb(null, true);
  },
});

async function uploadToCloudinary(file) {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = process.env.CLOUDINARY_FOLDER || 'holiday-seychelles/blogs';
  const publicIdBase = slugify(path.basename(file.originalname || 'blog-image', path.extname(file.originalname || '')), {
    lower: true,
    strict: true,
  }) || 'blog-image';
  const publicId = `${publicIdBase}-${Date.now()}`;

  const signaturePayload = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(signaturePayload).digest('hex');

  const formData = new FormData();
  formData.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'blog-image');
  formData.append('api_key', process.env.CLOUDINARY_API_KEY);
  formData.append('timestamp', String(timestamp));
  formData.append('folder', folder);
  formData.append('public_id', publicId);
  formData.append('signature', signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    {
      method: 'POST',
      body: formData,
    }
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'Cloudinary upload failed');
  }

  return {
    filename: data.public_id,
    path: data.public_id,
    url: data.secure_url,
    absoluteUrl: data.secure_url,
    publicPath: data.secure_url,
  };
}

router.post('/upload', adminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, null, 'Image file is required', 400);
    }

    const uploaded = hasCloudinaryConfig
      ? await uploadToCloudinary(req.file)
      : {
          filename: req.file.filename,
          path: req.file.filename,
          url: `/uploads/${req.file.filename}`,
          absoluteUrl: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`,
          publicPath: `/uploads/${req.file.filename}`,
        };

    sendSuccess(
      res,
      uploaded,
      'Image uploaded successfully',
      201
    );
  } catch (err) {
    console.error('blog image upload error:', err);
    sendError(res, err, 'Failed to upload image', 500);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const num = (v) => Number(v || 0);
const STATUSES = ['draft', 'scheduled', 'published', 'archived'];

function invalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, null, errors.array()[0].msg, 400);
  return true;
}

/**
 * A unique slug.
 *
 * `excludeId` exists so editing a post does not collide with itself and quietly
 * become "my-post-1" every time it is saved.
 */
async function uniqueSlug(desired, excludeId = null) {
  const base = slugify(desired || 'post', { lower: true, strict: true }) || 'post';
  let candidate = base;
  let counter = 1;

  // Bounded, because a runaway loop here would hold a connection on a database
  // that has very few to spare.
  while (counter < 200) {
    const { rows } = await pool.query(
      excludeId
        ? 'SELECT id FROM blogs WHERE slug = $1 AND id <> $2 LIMIT 1'
        : 'SELECT id FROM blogs WHERE slug = $1 LIMIT 1',
      excludeId ? [candidate, excludeId] : [candidate]
    );
    if (!rows.length) return candidate;
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return `${base}-${Date.now()}`;
}

/** Strip HTML and count words. 200 wpm is the usual reading speed. */
function readingMinutes(html) {
  const words = String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/**
 * Work out what publishing state a save should land in.
 *
 * Kept in one place because the three columns have to agree: a scheduled post
 * has a future date and no published_at; a published post has published_at and
 * no schedule. Letting each caller set them separately is how a post ends up
 * both scheduled and live.
 */
function publishingState(status, scheduledFor, existing = {}) {
  if (status === 'scheduled') {
    // `scheduled_for` must be a full ISO-8601 instant (with Z or an offset).
    // A bare "2026-10-01 09:00" is parsed in the SERVER's timezone, which is
    // not necessarily the operator's - so the admin UI converts the value from
    // its datetime-local input with toISOString() before sending it.
    const when = scheduledFor ? new Date(scheduledFor) : null;
    if (!when || Number.isNaN(when.getTime())) {
      return { error: 'A scheduled post needs a valid date and time' };
    }
    if (when.getTime() <= Date.now()) {
      return { error: 'That time has already passed — publish it now instead' };
    }
    return { status: 'scheduled', publishedAt: null, scheduledFor: when };
  }

  if (status === 'published') {
    // Keep the original publication date on re-save, so an edit does not make a
    // year-old post look new.
    return {
      status: 'published',
      publishedAt: existing.published_at || new Date(),
      scheduledFor: null,
    };
  }

  return { status: status || 'draft', publishedAt: null, scheduledFor: null };
}

const EDITABLE = {
  title: 'title',
  excerpt: 'excerpt',
  content: 'content',
  cover_image: 'cover_image',
  tags: 'tags',
  category: 'category',
  meta_title: 'meta_title',
  meta_description: 'meta_description',
  author_name: 'author_name',
  is_featured: 'is_featured',
};

// ── List ─────────────────────────────────────────────────────────────────────

router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    if (req.query.status) add('b.status = ?', req.query.status);
    if (req.query.category) add('b.category = ?', req.query.category);
    if (req.query.author) add('b.author_admin_id = ?', req.query.author);
    if (req.query.tag) {
      params.push(`%${req.query.tag}%`);
      conditions.push(`b.tags LIKE $${params.length}`);
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const p = `$${params.length}`;
      conditions.push(`(b.title LIKE ${p} OR b.excerpt LIKE ${p} OR b.content LIKE ${p} OR b.slug LIKE ${p})`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    const SORTS = {
      newest: 'b.created_at DESC',
      oldest: 'b.created_at ASC',
      updated: 'b.updated_at DESC',
      views: 'b.views DESC',
      title: 'b.title ASC',
      published: 'b.published_at IS NULL ASC, b.published_at DESC',
    };
    const order = SORTS[req.query.sort] || SORTS.newest;

    const source = `
      FROM blogs b
      LEFT JOIN admins a ON a.id = b.author_admin_id
      ${where}`;

    const [rows, total, stats, categories] = await runLimited([
      () =>
        pool.query(
          `SELECT b.id, b.slug, b.title, b.excerpt, b.cover_image, b.tags, b.category,
                  b.status, b.is_featured, b.published_at, b.scheduled_for, b.views, b.reading_minutes,
                  b.last_viewed_at, b.created_at, b.updated_at, b.author_admin_id,
                  COALESCE(b.author_name, a.name) AS author
           ${source}
           ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
      () => pool.query(`SELECT COUNT(*) AS total ${source}`, params),
      () =>
        pool.query(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
                  SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
                  SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
                  SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
                  COALESCE(SUM(views), 0) AS views
             FROM blogs`
        ),
      () =>
        pool.query(
          `SELECT COALESCE(category, 'Uncategorised') AS category, COUNT(*) AS total
             FROM blogs GROUP BY COALESCE(category, 'Uncategorised') ORDER BY total DESC`
        ),
    ]);

    const s = stats.rows[0] || {};
    const totalCount = num(total.rows[0]?.total);

    sendSuccess(
      res,
      {
        blogs: rows.rows.map((b) => ({ ...b, views: num(b.views) })),
        total: totalCount,
        page,
        limit,
        pages: Math.max(1, Math.ceil(totalCount / limit)),
        stats: {
          total: num(s.total),
          published: num(s.published),
          drafts: num(s.drafts),
          scheduled: num(s.scheduled),
          archived: num(s.archived),
          views: num(s.views),
        },
        categories: categories.rows.map((c) => ({ category: c.category, total: num(c.total) })),
        // Views are counted server-side on each public page load. That counts
        // reloads and crawlers too, so it is a readership signal and not a
        // unique-visitor figure.
        note: 'Views are page loads on the public site, not unique readers.',
      },
      'Blogs retrieved'
    );
  } catch (err) {
    console.error('blogs list error:', err);
    sendError(res, err, 'Failed to load the posts', 500);
  }
});

// ── Per-post metrics ─────────────────────────────────────────────────────────

router.get('/:blogId/metrics', adminAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365);

    const { rows } = await pool.query(
      'SELECT id, title, views, published_at, last_viewed_at FROM blogs WHERE id = $1',
      [req.params.blogId]
    );
    if (!rows.length) return sendError(res, null, 'Post not found', 404);
    const post = rows[0];

    const [daily, rank] = await runLimited([
      () =>
        pool.query(
          `SELECT day, views FROM blog_views
            WHERE blog_id = $1 AND day >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)
            ORDER BY day ASC`,
          [req.params.blogId]
        ),
      () =>
        pool.query(
          `SELECT COUNT(*) AS ahead FROM blogs
            WHERE status = 'published' AND views > $1`,
          [num(post.views)]
        ),
    ]);

    const tracked = daily.rows.reduce((a, d) => a + num(d.views), 0);
    const daysLive = post.published_at
      ? Math.max(1, Math.round((Date.now() - new Date(post.published_at).getTime()) / 86400000))
      : null;

    sendSuccess(
      res,
      {
        views: num(post.views),
        lastViewedAt: post.last_viewed_at,
        rank: num(rank.rows[0]?.ahead) + 1,
        daysLive,
        viewsPerDay: daysLive ? Number((num(post.views) / daysLive).toFixed(1)) : null,
        daily: daily.rows.map((d) => ({ day: d.day, views: num(d.views) })),
        trackedInWindow: tracked,
        // The lifetime counter predates the daily table, so the two will not
        // agree on old posts. Saying so beats letting somebody treat the gap as
        // lost traffic.
        note:
          tracked < num(post.views)
            ? 'The lifetime total includes views from before daily tracking began, so it is higher than the chart.'
            : null,
      },
      'Post metrics retrieved'
    );
  } catch (err) {
    console.error('blog metrics error:', err);
    sendError(res, err, 'Failed to load the metrics for this post', 500);
  }
});

// ── Single post ──────────────────────────────────────────────────────────────

router.get('/:blogId', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, COALESCE(b.author_name, a.name) AS author, a.name AS admin_name
         FROM blogs b LEFT JOIN admins a ON a.id = b.author_admin_id
        WHERE b.id = $1`,
      [req.params.blogId]
    );
    if (!rows.length) return sendError(res, null, 'Post not found', 404);

    sendSuccess(
      res,
      {
        blog: { ...rows[0], views: num(rows[0].views) },
        publicUrl: `${(process.env.HS_FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/blog/${rows[0].slug}`,
      },
      'Post retrieved'
    );
  } catch (err) {
    console.error('get blog error:', err);
    sendError(res, err, 'Failed to load this post', 500);
  }
});

// ── Create ───────────────────────────────────────────────────────────────────

router.post(
  '/',
  adminAuth,
  body('title').trim().isLength({ min: 3 }).withMessage('Give the post a title'),
  body('content').trim().isLength({ min: 10 }).withMessage('Write something first'),
  body('status').optional().isIn(STATUSES).withMessage('Unknown status'),
  body('meta_description').optional().isLength({ max: 320 }).withMessage('The meta description is too long'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const state = publishingState(req.body.status, req.body.scheduled_for);
      if (state.error) return sendError(res, null, state.error, 400);

      const slug = await uniqueSlug(req.body.slug || req.body.title);

      const result = await pool.query(
        `INSERT INTO blogs
           (slug, title, excerpt, content, cover_image, tags, category, meta_title,
            meta_description, status, published_at, scheduled_for, author_admin_id,
            author_name, reading_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          slug,
          req.body.title,
          req.body.excerpt || null,
          req.body.content,
          req.body.cover_image || null,
          req.body.tags || null,
          req.body.category || null,
          req.body.meta_title || req.body.title,
          req.body.meta_description || (req.body.excerpt || '').slice(0, 320) || null,
          state.status,
          state.publishedAt,
          state.scheduledFor,
          req.admin.id,
          req.body.author_name || null,
          readingMinutes(req.body.content),
        ]
      );

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.blog.created',
        entityType: 'blog',
        entityId: result.insertId,
        summary: `Created "${req.body.title}" (${state.status})`,
      });

      sendSuccess(res, { id: result.insertId, slug, status: state.status }, 'Post created', 201);
    } catch (err) {
      console.error('create blog error:', err);
      sendError(res, err, 'Failed to create the post', 500);
    }
  }
);

// ── Update ───────────────────────────────────────────────────────────────────

router.put(
  '/:blogId',
  adminAuth,
  body('is_featured').optional().isBoolean().withMessage('Featured must be true or false').toBoolean(),
  body('title').optional().trim().isLength({ min: 3 }).withMessage('The title is too short'),
  body('content').optional().trim().isLength({ min: 10 }).withMessage('The post is too short'),
  body('status').optional().isIn(STATUSES).withMessage('Unknown status'),
  body('meta_description').optional().isLength({ max: 320 }).withMessage('The meta description is too long'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const { rows } = await pool.query('SELECT * FROM blogs WHERE id = $1', [req.params.blogId]);
      if (!rows.length) return sendError(res, null, 'Post not found', 404);
      const before = rows[0];

      const updates = [];
      const params = [];
      const set = (sql, value) => {
        params.push(value);
        updates.push(sql.replace('?', `$${params.length}`));
      };

      for (const [field, column] of Object.entries(EDITABLE)) {
        if (req.body[field] === undefined) continue;
        set(`${column} = ?`, req.body[field]);
      }

      if (req.body.content !== undefined) set('reading_minutes = ?', readingMinutes(req.body.content));

      // The slug is only regenerated when asked for. Changing it silently on a
      // title edit breaks every link anyone has already shared.
      if (req.body.slug !== undefined && req.body.slug !== before.slug) {
        set('slug = ?', await uniqueSlug(req.body.slug, before.id));
      }

      if (req.body.status !== undefined || req.body.scheduled_for !== undefined) {
        const state = publishingState(
          req.body.status || before.status,
          req.body.scheduled_for !== undefined ? req.body.scheduled_for : before.scheduled_for,
          before
        );
        if (state.error) return sendError(res, null, state.error, 400);
        set('status = ?', state.status);
        set('published_at = ?', state.publishedAt);
        set('scheduled_for = ?', state.scheduledFor);
      }

      if (!updates.length) return sendError(res, null, 'Nothing to update', 400);

      updates.push('updated_at = NOW()');
      params.push(req.params.blogId);
      await pool.query(`UPDATE blogs SET ${updates.join(', ')} WHERE id = $${params.length}`, params);

      const after = (await pool.query('SELECT * FROM blogs WHERE id = $1', [req.params.blogId])).rows[0];

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.blog.updated',
        entityType: 'blog',
        entityId: before.id,
        summary:
          before.status !== after.status
            ? `"${after.title}" ${before.status} → ${after.status}`
            : `Edited "${after.title}"`,
      });

      sendSuccess(res, { blog: { ...after, views: num(after.views) } }, 'Post saved');
    } catch (err) {
      console.error('update blog error:', err);
      sendError(res, err, 'Failed to save this post', 500);
    }
  }
);

// ── Bulk actions ─────────────────────────────────────────────────────────────

/**
 * Publish, unpublish, archive or delete several posts at once.
 *
 * Delete is included but is the only action that cannot be undone, so it
 * reports exactly what it removed rather than a count.
 */
router.post(
  '/bulk',
  adminAuth,
  body('action').isIn(['publish', 'unpublish', 'archive', 'delete']).withMessage('Unknown action'),
  body('ids').isArray({ min: 1 }).withMessage('Select at least one post'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const ids = req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
      if (!ids.length) return sendError(res, null, 'No valid posts selected', 400);

      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await pool.query(
        `SELECT id, title, status FROM blogs WHERE id IN (${placeholders})`,
        ids
      );
      if (!rows.length) return sendError(res, null, 'None of those posts exist', 404);

      const found = rows.map((r) => r.id);
      const foundPlaceholders = found.map((_, i) => `$${i + 1}`).join(', ');

      if (req.body.action === 'delete') {
        await pool.query(`DELETE FROM blogs WHERE id IN (${foundPlaceholders})`, found);
      } else if (req.body.action === 'publish') {
        await pool.query(
          `UPDATE blogs SET status = 'published',
                  published_at = COALESCE(published_at, NOW()),
                  scheduled_for = NULL, updated_at = NOW()
            WHERE id IN (${foundPlaceholders})`,
          found
        );
      } else if (req.body.action === 'unpublish') {
        await pool.query(
          `UPDATE blogs SET status = 'draft', published_at = NULL, scheduled_for = NULL, updated_at = NOW()
            WHERE id IN (${foundPlaceholders})`,
          found
        );
      } else {
        await pool.query(
          `UPDATE blogs SET status = 'archived', scheduled_for = NULL, updated_at = NOW()
            WHERE id IN (${foundPlaceholders})`,
          found
        );
      }

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: `admin.blog.bulk_${req.body.action}`,
        entityType: 'blog',
        summary: `${req.body.action} on ${found.length} post(s): ${rows.map((r) => r.title).join(', ').slice(0, 300)}`,
        metadata: { ids: found },
      });

      sendSuccess(
        res,
        {
          affected: found.length,
          skipped: ids.length - found.length,
          posts: rows.map((r) => ({ id: r.id, title: r.title })),
        },
        `${found.length} post${found.length === 1 ? '' : 's'} ${req.body.action === 'delete' ? 'deleted' : req.body.action + 'ed'}`
      );
    } catch (err) {
      console.error('blog bulk error:', err);
      sendError(res, err, 'Failed to apply that to the selected posts', 500);
    }
  }
);

// ── Delete ───────────────────────────────────────────────────────────────────

router.delete('/:blogId', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, title FROM blogs WHERE id = $1', [req.params.blogId]);
    if (!rows.length) return sendError(res, null, 'Post not found', 404);

    await pool.query('DELETE FROM blogs WHERE id = $1', [req.params.blogId]);
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.blog.deleted',
      entityType: 'blog',
      entityId: rows[0].id,
      summary: `Deleted "${rows[0].title}"`,
    });

    sendSuccess(res, { id: rows[0].id }, 'Post deleted');
  } catch (err) {
    console.error('delete blog error:', err);
    sendError(res, err, 'Failed to delete this post', 500);
  }
});

/** Upload rejections as JSON, so the panel can show a real message. */
router.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, null, 'Images must be 5MB or smaller', 413);
  }
  if (/image uploads are allowed/.test(err.message || '')) {
    return sendError(res, null, err.message, 415);
  }
  console.error('blogs route error:', err);
  return sendError(res, err, 'Something went wrong handling that request', 500);
});

module.exports = router;
