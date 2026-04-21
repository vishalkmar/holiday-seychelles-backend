const express = require('express');
const { pool } = require('../../config/db');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

// Get published blogs
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `SELECT id, slug, title, excerpt, cover_image, tags, published_at, views
       FROM blogs
       WHERE status = 'published'
       ORDER BY published_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) as total FROM blogs WHERE status = $1',
      ['published']
    );

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

// Get single blog by slug
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const { rows } = await pool.query(
      `SELECT id, slug, title, excerpt, content, cover_image, tags, published_at, views
       FROM blogs
       WHERE slug = $1 AND status = 'published'`,
      [slug]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'Blog not found', 404);
    }

    // Increment views
    await pool.query('UPDATE blogs SET views = views + 1 WHERE id = $1', [rows[0].id]);

    sendSuccess(res, rows[0], 'Blog retrieved successfully');
  } catch (err) {
    console.error('get blog detail error:', err);
    sendError(res, err, 'Failed to get blog', 500);
  }
});

module.exports = router;
