/**
 * Public website configuration.
 *
 *   GET /api/site/settings   branding + home hero, as the admin saved them
 *
 * No auth: the home page needs this before anyone signs in. It only ever
 * returns what is meant to be on the public page — media URLs, sizes and
 * wording — never who changed it or when.
 */

const express = require('express');
const { sendSuccess, sendError } = require('../../utils/response');
const website = require('../../services/websiteSettings');

const router = express.Router();

router.get('/settings', async (req, res) => {
  try {
    const settings = await website.getSettings();
    // Short cache: an admin change shows within a minute without hammering the DB.
    res.set('Cache-Control', 'public, max-age=60');
    sendSuccess(res, settings, 'Site settings');
  } catch (err) {
    console.error('public site settings error:', err);
    sendError(res, err, 'Failed to load the site settings', 500);
  }
});

module.exports = router;
