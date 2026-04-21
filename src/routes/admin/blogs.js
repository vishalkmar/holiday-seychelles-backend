const express = require('express');
const { body, validationResult } = require('express-validator');
const slugify = require('slugify');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

// Get all blogs (admin view - includes drafts)
router.get('/', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = `SELECT id, slug, title, excerpt, status, published_at, views, created_at
                 FROM blogs`;
    let countQuery = 'SELECT COUNT(*) as total FROM blogs';
    const params = [];

    if (status) {
      query += ' WHERE status = $1';
      countQuery += ' WHERE status = $1';
      params.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const { rows } = await pool.query(query, [...params, limit, offset]);

    const { rows: countRows } = await pool.query(countQuery, params);

    sendSuccess(
      res,
      { blogs: rows, total: parseInt(countRows[0].total), page, limit },
      'Blogs retrieved successfully'
    );
  } catch (err) {
    console.error('get blogs error:', err);
    sendError(res, err, 'Failed to get blogs', 500);
  }
});

// Get single blog
router.get('/:blogId', adminAuth, async (req, res) => {
  try {
    const { blogId } = req.params;

    const { rows } = await pool.query(
      'SELECT * FROM blogs WHERE id = $1',
      [blogId]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'Blog not found', 404);
    }

    sendSuccess(res, rows[0], 'Blog retrieved successfully');
  } catch (err) {
    console.error('get blog error:', err);
    sendError(res, err, 'Failed to get blog', 500);
  }
});

// Create blog
router.post(
  '/',
  adminAuth,
  body('title').trim().notEmpty(),
  body('content').trim().notEmpty(),
  body('excerpt').optional().trim(),
  body('tags').optional().trim(),
  body('status').optional().isIn(['draft', 'published']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { id: adminId } = req.admin;
      const { title, excerpt, content, cover_image, tags, status = 'draft' } = req.body;

      // Generate slug
      let slug = slugify(title, { lower: true, strict: true });

      // Check if slug already exists
      let counter = 1;
      let uniqueSlug = slug;
      while (true) {
        const { rows } = await pool.query(
          'SELECT id FROM blogs WHERE slug = $1',
          [uniqueSlug]
        );
        if (rows.length === 0) break;
        uniqueSlug = `${slug}-${counter}`;
        counter++;
      }

      const publishedAt = status === 'published' ? new Date() : null;

      const { rows } = await pool.query(
        `INSERT INTO blogs (slug, title, excerpt, content, cover_image, tags, status, published_at, author_admin_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, slug, title, status, published_at, created_at`,
        [uniqueSlug, title, excerpt, content, cover_image || null, tags, status, publishedAt, adminId]
      );

      sendSuccess(res, rows[0], 'Blog created successfully', 201);
    } catch (err) {
      console.error('create blog error:', err);
      sendError(res, err, 'Failed to create blog', 500);
    }
  }
);

// Update blog
router.put(
  '/:blogId',
  adminAuth,
  body('title').optional().trim(),
  body('content').optional().trim(),
  body('excerpt').optional().trim(),
  body('tags').optional().trim(),
  body('status').optional().isIn(['draft', 'published']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { blogId } = req.params;
      const { title, excerpt, content, cover_image, tags, status } = req.body;

      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (title) {
        updates.push(`title = $${paramIndex}`);
        params.push(title);
        paramIndex++;
      }

      if (excerpt !== undefined) {
        updates.push(`excerpt = $${paramIndex}`);
        params.push(excerpt);
        paramIndex++;
      }

      if (content) {
        updates.push(`content = $${paramIndex}`);
        params.push(content);
        paramIndex++;
      }

      if (cover_image !== undefined) {
        updates.push(`cover_image = $${paramIndex}`);
        params.push(cover_image);
        paramIndex++;
      }

      if (tags !== undefined) {
        updates.push(`tags = $${paramIndex}`);
        params.push(tags);
        paramIndex++;
      }

      if (status) {
        updates.push(`status = $${paramIndex}`);
        params.push(status);
        paramIndex++;

        if (status === 'published') {
          updates.push(`published_at = NOW()`);
        }
      }

      if (updates.length === 0) {
        return sendError(res, null, 'No fields to update', 400);
      }

      updates.push('updated_at = NOW()');
      params.push(blogId);

      const { rows } = await pool.query(
        `UPDATE blogs SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        params
      );

      if (rows.length === 0) {
        return sendError(res, null, 'Blog not found', 404);
      }

      sendSuccess(res, rows[0], 'Blog updated successfully');
    } catch (err) {
      console.error('update blog error:', err);
      sendError(res, err, 'Failed to update blog', 500);
    }
  }
);

// Delete blog
router.delete('/:blogId', adminAuth, async (req, res) => {
  try {
    const { blogId } = req.params;

    const { rows } = await pool.query(
      'DELETE FROM blogs WHERE id = $1 RETURNING id',
      [blogId]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'Blog not found', 404);
    }

    sendSuccess(res, { id: rows[0].id }, 'Blog deleted successfully');
  } catch (err) {
    console.error('delete blog error:', err);
    sendError(res, err, 'Failed to delete blog', 500);
  }
});

module.exports = router;
