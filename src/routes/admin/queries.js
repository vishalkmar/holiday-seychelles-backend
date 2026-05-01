const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const { sendQueryReplyEmail } = require('../../utils/mailer');

const router = express.Router();

// Self-healing: ensure the chat-related schema exists even if migrations 010/011
// were never applied on this database. Runs once per process (cached).
let schemaReady = false;
async function ensureQueryChatSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS query_messages (
      id BIGSERIAL PRIMARY KEY,
      query_id BIGINT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
      sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('user', 'admin', 'system')),
      sender_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      sender_admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      email_sent BOOLEAN NOT NULL DEFAULT FALSE,
      email_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_query_messages_query_id ON query_messages(query_id, created_at ASC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_query_messages_sender_type ON query_messages(sender_type);`);
  await pool.query(`
    ALTER TABLE queries
      ADD COLUMN IF NOT EXISTS user_last_seen_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS admin_last_seen_at TIMESTAMPTZ;
  `);
  schemaReady = true;
  console.log('✅ query_messages + seen-tracking schema verified');
}

// Run once at module load so the very first request already has schema ready.
ensureQueryChatSchema().catch((err) => {
  console.error('Failed to verify query chat schema:', err.message);
});

async function ensureInitialQueryMessage(client, queryRow) {
  const { rows } = await client.query('SELECT id FROM query_messages WHERE query_id = $1 LIMIT 1', [queryRow.id]);
  if (rows.length > 0) return;

  await client.query(
    `INSERT INTO query_messages (query_id, sender_type, sender_user_id, message, created_at)
     VALUES ($1, 'user', $2, $3, COALESCE($4, NOW()))`,
    [queryRow.id, queryRow.user_id || null, queryRow.message, queryRow.created_at || null]
  );
}

async function getQueryDetail(client, queryId) {
  const { rows } = await client.query(
    `SELECT q.*, 
            handler.name AS handled_by_name,
            COALESCE(stats.message_count, 0) AS message_count,
            stats.last_message_at,
            latest_admin.message AS last_admin_reply,
            COALESCE(unread_user.unread_count, 0) AS unread_count
     FROM queries q
     LEFT JOIN admins handler ON handler.id = q.handled_by_admin_id
     LEFT JOIN (
       SELECT query_id, COUNT(*)::int AS message_count, MAX(created_at) AS last_message_at
       FROM query_messages
       GROUP BY query_id
     ) stats ON stats.query_id = q.id
     LEFT JOIN LATERAL (
       SELECT message
       FROM query_messages
       WHERE query_id = q.id AND sender_type = 'admin'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) latest_admin ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS unread_count
       FROM query_messages
       WHERE query_id = q.id
         AND sender_type = 'user'
         AND created_at > COALESCE(q.admin_last_seen_at, TO_TIMESTAMP(0))
     ) unread_user ON TRUE
     WHERE q.id = $1`,
    [queryId]
  );

  if (rows.length === 0) return null;

  const query = rows[0];
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

async function markAdminSeen(client, queryId) {
  await client.query(
    `UPDATE queries
     SET admin_last_seen_at = NOW()
     WHERE id = $1`,
    [queryId]
  );
}

router.get('/', adminAuth, async (req, res) => {
  try { await ensureQueryChatSchema(); } catch (e) { /* logged inside */ }
  const client = await pool.connect();
  try {
    const { page = 1, limit = 20, status = '', category = '', search = '' } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (status) {
      conditions.push(`q.status = $${params.length + 1}`);
      params.push(status);
    }

    if (category) {
      conditions.push(`q.category = $${params.length + 1}`);
      params.push(category);
    }

    if (search) {
      conditions.push(
        `(q.name ILIKE $${params.length + 1} OR q.email ILIKE $${params.length + 1} OR q.subject ILIKE $${params.length + 1} OR q.message ILIKE $${params.length + 1})`
      );
      params.push(`%${search}%`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const listQuery = `
      SELECT q.id, q.user_id, q.name, q.email, q.mobile, q.subject, q.category, q.status, q.source,
             q.message, q.admin_notes, q.created_at, q.updated_at, q.handled_at,
             handler.name AS handled_by_name,
             COALESCE(stats.message_count, 0) AS message_count,
             stats.last_message_at,
             last_message.sender_type AS last_sender_type,
             last_message.message AS last_message,
             last_admin.message AS last_admin_reply,
             COALESCE(unread_user.unread_count, 0) AS unread_count
      FROM queries q
      LEFT JOIN admins handler ON handler.id = q.handled_by_admin_id
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
          AND sender_type = 'user'
          AND created_at > COALESCE(q.admin_last_seen_at, TO_TIMESTAMP(0))
      ) unread_user ON TRUE
      ${whereClause}
      ORDER BY COALESCE(stats.last_message_at, q.updated_at, q.created_at) DESC, q.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countQuery = `SELECT COUNT(*)::int AS total FROM queries q ${whereClause}`;

    const { rows } = await client.query(listQuery, [...params, limit, offset]);
    for (const row of rows) {
      await ensureInitialQueryMessage(client, row);
    }

    const { rows: finalRows } = await client.query(listQuery, [...params, limit, offset]);
    const { rows: countRows } = await client.query(countQuery, params);

    sendSuccess(
      res,
      {
        queries: finalRows,
        total: countRows[0]?.total || 0,
        page: Number(page),
        limit: Number(limit),
      },
      'Queries retrieved successfully'
    );
  } catch (err) {
    console.error('get queries error:', err);
    sendError(res, err, 'Failed to get queries', 500);
  } finally {
    client.release();
  }
});

router.get('/:queryId', adminAuth, async (req, res) => {
  try { await ensureQueryChatSchema(); } catch (e) { /* logged inside */ }
  const client = await pool.connect();
  try {
    const { queryId } = req.params;
    const detail = await getQueryDetail(client, queryId);
    if (!detail) {
      return sendError(res, null, 'Query not found', 404);
    }

    await markAdminSeen(client, queryId);
    const updatedDetail = await getQueryDetail(client, queryId);

    sendSuccess(res, updatedDetail, 'Query retrieved successfully');
  } catch (err) {
    console.error('get query detail error:', err);
    sendError(res, err, 'Failed to get query', 500);
  } finally {
    client.release();
  }
});

router.patch(
  '/:queryId',
  adminAuth,
  body('status').optional().isIn(['new', 'in_progress', 'resolved', 'closed']),
  body('admin_notes').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { queryId } = req.params;
      const { id: adminId } = req.admin;
      const { status, admin_notes } = req.body;

      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (status) {
        updates.push(`status = $${paramIndex}`);
        params.push(status);
        paramIndex++;

        if (['in_progress', 'resolved', 'closed'].includes(status)) {
          updates.push(`handled_by_admin_id = $${paramIndex}`);
          params.push(adminId);
          paramIndex++;
        }

        if (['resolved', 'closed'].includes(status)) {
          updates.push('handled_at = NOW()');
        }
      }

      if (admin_notes !== undefined) {
        updates.push(`admin_notes = $${paramIndex}`);
        params.push(admin_notes);
        paramIndex++;
      }

      if (updates.length === 0) {
        return sendError(res, null, 'No fields to update', 400);
      }

      updates.push('updated_at = NOW()');
      params.push(queryId);

      const { rows } = await pool.query(
        `UPDATE queries SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        params
      );

      if (rows.length === 0) {
        return sendError(res, null, 'Query not found', 404);
      }

      const client = await pool.connect();
      try {
        const detail = await getQueryDetail(client, queryId);
        sendSuccess(res, detail, 'Query updated successfully');
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('update query error:', err);
      sendError(res, err, 'Failed to update query', 500);
    }
  }
);

router.post(
  '/:queryId/reply',
  adminAuth,
  body('message').trim().notEmpty(),
  body('status').optional().isIn(['new', 'in_progress', 'resolved', 'closed']),
  body('admin_notes').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      await ensureQueryChatSchema();
    } catch (schemaErr) {
      console.error('schema ensure failed in reply route:', schemaErr);
      return sendError(res, schemaErr, 'Database schema is not ready. Please run `npm run migrate` in the backend.', 500);
    }

    const client = await pool.connect();
    let transactionStarted = false;
    let replySaved = false;
    try {
      const queryId = Number(req.params.queryId);
      const adminId = Number(req.admin?.id);
      const { message, status, admin_notes } = req.body;

      if (!Number.isInteger(queryId) || queryId <= 0) {
        return sendError(res, null, 'Invalid query id', 400);
      }

      if (!Number.isInteger(adminId) || adminId <= 0) {
        return sendError(res, null, 'Admin session is invalid. Please log out and sign in again.', 401);
      }

      const detail = await getQueryDetail(client, queryId);
      if (!detail) {
        return sendError(res, null, 'Query not found', 404);
      }

      await client.query('BEGIN');
      transactionStarted = true;

      const { rows: messageRows } = await client.query(
        `INSERT INTO query_messages (query_id, sender_type, sender_admin_id, message, email_sent, email_sent_at)
         VALUES ($1::BIGINT, 'admin', $2::BIGINT, $3::TEXT, FALSE, NULL)
         RETURNING *`,
        [queryId, adminId, message]
      );

      const nextStatus = status || 'in_progress';
      const updateParams = [nextStatus, admin_notes ?? detail.admin_notes ?? null, adminId, queryId];
      await client.query(
        `UPDATE queries
         SET status = $1::VARCHAR(20),
             admin_notes = $2::TEXT,
             handled_by_admin_id = $3::BIGINT,
             user_last_seen_at = NULL,
             handled_at = CASE
               WHEN $1::VARCHAR(20) IN ('resolved', 'closed') THEN NOW()
               ELSE handled_at
             END,
             updated_at = NOW()
         WHERE id = $4::BIGINT`,
        updateParams
      );
      await client.query('COMMIT');
      transactionStarted = false;
      replySaved = true;

      let emailResult = { success: false, error: 'Email not attempted' };
      let updatedDetail = null;

      try {
        emailResult = await sendQueryReplyEmail(detail, message);

        if (emailResult.success) {
          await client.query(
            `UPDATE query_messages
             SET email_sent = TRUE, email_sent_at = NOW()
             WHERE id = $1`,
            [messageRows[0].id]
          );
        }
      } catch (emailErr) {
        console.error('query reply email step error:', emailErr);
        emailResult = { success: false, error: emailErr.message || 'Email delivery failed' };
      }

      try {
        updatedDetail = await getQueryDetail(client, queryId);
      } catch (detailErr) {
        console.error('query reply refresh error:', detailErr);
      }

      return sendSuccess(
        res,
        {
          query: updatedDetail || {
            ...detail,
            id: detail.id,
            status: status || 'in_progress',
            admin_notes: admin_notes ?? detail.admin_notes ?? null,
            handled_by_admin_id: adminId,
            messages: [...(detail.messages || []), {
              ...messageRows[0],
              email_sent: Boolean(emailResult.success),
              email_sent_at: emailResult.success ? new Date() : null,
            }],
          },
          reply: {
            ...messageRows[0],
            email_sent: Boolean(emailResult.success),
            email_sent_at: emailResult.success ? new Date() : null,
          },
          email: emailResult,
        },
        emailResult.success ? 'Reply sent successfully' : 'Reply saved but email could not be delivered'
      );
    } catch (err) {
      if (transactionStarted) {
        await client.query('ROLLBACK');
      }
      if (replySaved) {
        console.error('reply saved but response assembly failed:', err);
        return sendSuccess(
          res,
          {
            email: { success: false, error: err.message || 'Post-save processing failed' },
          },
          'Reply saved but email/status refresh could not be completed'
        );
      }
      console.error('reply to query error:', {
        message: err.message,
        code: err.code,
        detail: err.detail,
        constraint: err.constraint,
        table: err.table,
        column: err.column,
      });

      // Surface PG error details so the admin UI can show a useful message
      const friendly =
        err.code === '42P01' ? 'Schema is missing the query_messages table. Run `npm run migrate` in the backend.' :
        err.code === '42703' ? `Schema is missing column "${err.column || 'unknown'}". Run \`npm run migrate\` in the backend.` :
        err.code === '23503' ? 'Foreign key constraint failed (query or admin not found).' :
        'Failed to send reply';

      sendError(res, err, friendly, 500);
    } finally {
      client.release();
    }
  }
);

router.post('/:queryId/resend-email', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { queryId } = req.params;
    const detail = await getQueryDetail(client, queryId);
    if (!detail) {
      return sendError(res, null, 'Query not found', 404);
    }

    const lastAdminMessage = [...detail.messages].reverse().find((message) => message.sender_type === 'admin');
    if (!lastAdminMessage) {
      return sendError(res, null, 'No admin reply available to resend', 400);
    }

    const emailResult = await sendQueryReplyEmail(detail, lastAdminMessage.message);
    if (emailResult.success) {
      await client.query(
        `UPDATE query_messages
         SET email_sent = TRUE, email_sent_at = NOW()
         WHERE id = $1`,
        [lastAdminMessage.id]
      );
    }

    sendSuccess(
      res,
      { email: emailResult },
      emailResult.success ? 'Reply email resent successfully' : 'Unable to resend reply email'
    );
  } catch (err) {
    console.error('resend query email error:', err);
    sendError(res, err, 'Failed to resend email', 500);
  } finally {
    client.release();
  }
});

router.delete('/:queryId', adminAuth, async (req, res) => {
  try {
    const { queryId } = req.params;
    const { rows } = await pool.query('DELETE FROM queries WHERE id = $1 RETURNING id', [queryId]);

    if (rows.length === 0) {
      return sendError(res, null, 'Query not found', 404);
    }

    sendSuccess(res, { id: rows[0].id }, 'Query deleted successfully');
  } catch (err) {
    console.error('delete query error:', err);
    sendError(res, err, 'Failed to delete query', 500);
  }
});

module.exports = router;
