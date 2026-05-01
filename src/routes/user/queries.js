const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const userAuth = require('../../middleware/userAuth');
const { sendSuccess, sendError } = require('../../utils/response');

const router = express.Router();

async function ensureInitialQueryMessage(client, queryRow) {
  const { rows } = await client.query('SELECT id FROM query_messages WHERE query_id = $1 LIMIT 1', [queryRow.id]);
  if (rows.length > 0) return;

  await client.query(
    `INSERT INTO query_messages (query_id, sender_type, sender_user_id, message, created_at)
     VALUES ($1, 'user', $2, $3, COALESCE($4, NOW()))`,
    [queryRow.id, queryRow.user_id || null, queryRow.message, queryRow.created_at || null]
  );
}

async function getQueryThread(client, queryId) {
  const { rows: queryRows } = await client.query(
    `SELECT q.*, 
            COALESCE(message_stats.message_count, 0) AS message_count,
            message_stats.last_message_at
     FROM queries q
     LEFT JOIN (
       SELECT query_id, COUNT(*)::int AS message_count, MAX(created_at) AS last_message_at
       FROM query_messages
       GROUP BY query_id
     ) AS message_stats ON message_stats.query_id = q.id
     WHERE q.id = $1`,
    [queryId]
  );

  if (queryRows.length === 0) return null;

  const query = queryRows[0];
  await ensureInitialQueryMessage(client, query);

  const { rows: messages } = await client.query(
    `SELECT qm.id, qm.query_id, qm.sender_type, qm.sender_user_id, qm.sender_admin_id, qm.message,
            qm.email_sent, qm.email_sent_at, qm.created_at,
            a.name AS admin_name
     FROM query_messages qm
     LEFT JOIN admins a ON a.id = qm.sender_admin_id
     WHERE qm.query_id = $1
     ORDER BY qm.created_at ASC, qm.id ASC`,
    [queryId]
  );

  return {
    ...query,
    messages,
  };
}

async function markUserSeen(client, queryId) {
  await client.query(
    `UPDATE queries
     SET user_last_seen_at = NOW()
     WHERE id = $1`,
    [queryId]
  );
}

router.post(
  '/',
  userAuth,
  body('name').trim().notEmpty(),
  body('email').isEmail(),
  body('subject').trim().notEmpty(),
  body('message').trim().notEmpty(),
  body('mobile').optional().trim(),
  body('category').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    const client = await pool.connect();
    try {
      const { id: userId } = req.user;
      const { name, email, mobile, subject, category, message } = req.body;

      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO queries (user_id, name, email, mobile, subject, category, message, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [userId, name, email, mobile || null, subject, category || 'general', message, 'user_queries_panel']
      );

      const createdQuery = rows[0];
      await client.query(
        `INSERT INTO query_messages (query_id, sender_type, sender_user_id, message)
         VALUES ($1, 'user', $2, $3)`,
        [createdQuery.id, userId, message]
      );
      await client.query('COMMIT');

      const thread = await getQueryThread(client, createdQuery.id);
      sendSuccess(res, thread, 'Query submitted successfully', 201);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('submit query error:', err);
      sendError(res, err, 'Failed to submit query', 500);
    } finally {
      client.release();
    }
  }
);

router.get('/', userAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id: userId } = req.user;

    const { rows } = await client.query(
      `SELECT q.id, q.user_id, q.name, q.email, q.mobile, q.subject, q.category, q.status, q.created_at, q.updated_at,
              COALESCE(stats.message_count, 0) AS message_count,
              stats.last_message_at,
              last_message.sender_type AS last_sender_type,
              last_message.message AS last_message,
              last_admin.message AS last_admin_reply,
              COALESCE(unread_admin.unread_count, 0) AS unread_count
       FROM queries q
       LEFT JOIN (
         SELECT query_id, COUNT(*)::int AS message_count, MAX(created_at) AS last_message_at
         FROM query_messages
         GROUP BY query_id
       ) stats ON stats.query_id = q.id
       LEFT JOIN LATERAL (
         SELECT sender_type, message
         FROM query_messages
         WHERE query_id = q.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) last_message ON TRUE
       LEFT JOIN LATERAL (
         SELECT message
         FROM query_messages
         WHERE query_id = q.id AND sender_type = 'admin'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) last_admin ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS unread_count
         FROM query_messages
         WHERE query_id = q.id
           AND sender_type = 'admin'
           AND created_at > COALESCE(q.user_last_seen_at, TO_TIMESTAMP(0))
       ) unread_admin ON TRUE
       WHERE q.user_id = $1
       ORDER BY COALESCE(stats.last_message_at, q.updated_at, q.created_at) DESC, q.id DESC`,
      [userId]
    );

    for (const row of rows) {
      await ensureInitialQueryMessage(client, row);
    }

    const refreshedRows = await client.query(
      `SELECT q.id, q.user_id, q.name, q.email, q.mobile, q.subject, q.category, q.status, q.created_at, q.updated_at,
              COALESCE(stats.message_count, 0) AS message_count,
              stats.last_message_at,
              last_message.sender_type AS last_sender_type,
              last_message.message AS last_message,
              last_admin.message AS last_admin_reply,
              COALESCE(unread_admin.unread_count, 0) AS unread_count
       FROM queries q
       LEFT JOIN (
         SELECT query_id, COUNT(*)::int AS message_count, MAX(created_at) AS last_message_at
         FROM query_messages
         GROUP BY query_id
       ) stats ON stats.query_id = q.id
       LEFT JOIN LATERAL (
         SELECT sender_type, message
         FROM query_messages
         WHERE query_id = q.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) last_message ON TRUE
       LEFT JOIN LATERAL (
         SELECT message
         FROM query_messages
         WHERE query_id = q.id AND sender_type = 'admin'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) last_admin ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS unread_count
         FROM query_messages
         WHERE query_id = q.id
           AND sender_type = 'admin'
           AND created_at > COALESCE(q.user_last_seen_at, TO_TIMESTAMP(0))
       ) unread_admin ON TRUE
       WHERE q.user_id = $1
       ORDER BY COALESCE(stats.last_message_at, q.updated_at, q.created_at) DESC, q.id DESC`,
      [userId]
    );

    sendSuccess(
      res,
      { queries: refreshedRows.rows, total: refreshedRows.rows.length },
      'Queries retrieved successfully'
    );
  } catch (err) {
    console.error('get queries error:', err);
    sendError(res, err, 'Failed to get queries', 500);
  } finally {
    client.release();
  }
});

router.get('/:queryId', userAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id: userId } = req.user;
    const { queryId } = req.params;

    const thread = await getQueryThread(client, queryId);
    if (!thread || String(thread.user_id) !== String(userId)) {
      return sendError(res, null, 'Query not found', 404);
    }

    await markUserSeen(client, queryId);
    const updatedThread = await getQueryThread(client, queryId);

    sendSuccess(res, updatedThread, 'Query retrieved successfully');
  } catch (err) {
    console.error('get query detail error:', err);
    sendError(res, err, 'Failed to get query', 500);
  } finally {
    client.release();
  }
});

router.post(
  '/:queryId/messages',
  userAuth,
  body('message').trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    const client = await pool.connect();
    try {
      const { id: userId } = req.user;
      const { queryId } = req.params;
      const { message } = req.body;

      const { rows: queryRows } = await client.query('SELECT * FROM queries WHERE id = $1 AND user_id = $2', [queryId, userId]);
      if (queryRows.length === 0) {
        return sendError(res, null, 'Query not found', 404);
      }

      await ensureInitialQueryMessage(client, queryRows[0]);

      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO query_messages (query_id, sender_type, sender_user_id, message)
         VALUES ($1, 'user', $2, $3)
         RETURNING *`,
        [queryId, userId, message]
      );
      await client.query(
        `UPDATE queries
         SET message = $1,
             status = CASE WHEN status = 'closed' THEN 'closed' ELSE 'new' END,
             admin_last_seen_at = NULL,
             updated_at = NOW()
         WHERE id = $2`,
        [message, queryId]
      );
      await client.query('COMMIT');

      sendSuccess(res, rows[0], 'Message sent successfully', 201);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('send query message error:', err);
      sendError(res, err, 'Failed to send message', 500);
    } finally {
      client.release();
    }
  }
);

module.exports = router;
