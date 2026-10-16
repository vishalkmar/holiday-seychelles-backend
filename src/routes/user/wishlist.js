/**
 * The signed-in customer's wishlist (the heart on hotel cards).
 *
 * Each row is a snapshot of the card at the time it was saved - name, photo,
 * place, stars and the price seen - so the dashboard can list it without a new
 * supplier search. Prices go stale; the dashboard says "price when saved".
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { pool } = require('../../config/db');
const userAuth = require('../../middleware/userAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

const TYPES = ['hotel'];

// The table comes from migration 031. Creating it here as well means a deploy
// that forgot `npm run migrate` still works instead of 500-ing on every heart.
let ensured = null;
function ensureTable() {
  if (!ensured) {
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations/031_user_wishlist.sql'), 'utf8');
    ensured = pool.query(sql).catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : null);

function toItem(row) {
  let meta = row.meta;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = null;
    }
  }
  return {
    type: row.item_type,
    itemId: row.item_id,
    title: row.title,
    image: row.image_url,
    location: row.location,
    stars: row.stars == null ? null : Number(row.stars),
    price: row.price == null ? null : Number(row.price),
    currency: row.currency,
    meta: meta || {},
    savedAt: row.created_at,
  };
}

/** GET /api/user/wishlist[?type=hotel] */
router.get('/', userAuth, async (req, res) => {
  try {
    await ensureTable();
    const params = [req.user.id];
    let where = 'user_id = $1';
    if (TYPES.includes(req.query.type)) {
      params.push(req.query.type);
      where += ' AND item_type = $2';
    }
    const { rows } = await pool.query(
      `SELECT * FROM user_wishlist WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
      params
    );
    sendSuccess(res, { items: rows.map(toItem) });
  } catch (err) {
    sendError(res, err, 'Could not load your wishlist', 500);
  }
});

/** POST /api/user/wishlist - save (or refresh) one item. */
router.post('/', userAuth, async (req, res) => {
  const b = req.body || {};
  const type = b.type || 'hotel';
  const itemId = str(b.itemId, 64);
  const title = str(b.title, 255);
  if (!TYPES.includes(type) || !itemId || !title) {
    return sendError(res, null, 'type, itemId and title are required', 400);
  }
  try {
    await ensureTable();
    await pool.query(
      `INSERT INTO user_wishlist
         (user_id, item_type, item_id, title, image_url, location, stars, price, currency, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title), image_url = VALUES(image_url), location = VALUES(location),
         stars = VALUES(stars), price = VALUES(price), currency = VALUES(currency), meta = VALUES(meta)`,
      [
        req.user.id,
        type,
        itemId,
        title,
        str(b.image, 1000),
        str(b.location, 255),
        num(b.stars),
        num(b.price),
        str(b.currency, 8),
        JSON.stringify(b.meta && typeof b.meta === 'object' ? b.meta : {}),
      ]
    );
    sendSuccess(res, { type, itemId }, 'Saved to wishlist', 201);
  } catch (err) {
    sendError(res, err, 'Could not save to wishlist', 500);
  }
});

/** DELETE /api/user/wishlist/:type/:itemId */
router.delete('/:type/:itemId', userAuth, async (req, res) => {
  const { type, itemId } = req.params;
  if (!TYPES.includes(type)) return sendError(res, null, 'Unknown item type', 400);
  try {
    await ensureTable();
    await pool.query(
      'DELETE FROM user_wishlist WHERE user_id = $1 AND item_type = $2 AND item_id = $3',
      [req.user.id, type, String(itemId).slice(0, 64)]
    );
    sendSuccess(res, { type, itemId }, 'Removed from wishlist');
  } catch (err) {
    sendError(res, err, 'Could not remove from wishlist', 500);
  }
});

module.exports = router;
