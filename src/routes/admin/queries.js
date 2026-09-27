/**
 * The support console.
 *
 * One thread per customer question, with the conversation, the customer's own
 * history beside it, and the notes the team leaves for each other.
 *
 * Three things are worth knowing before changing anything here:
 *
 *  1. **Ownership and authorship are different columns.** `assigned_to_admin_id`
 *     is who owns the thread; `handled_by_admin_id` is who last acted on it.
 *     Merging them means every reply silently reassigns the thread.
 *
 *  2. **`first_response_at` is written once and never recomputed.** The useful
 *     number is how long the customer actually waited, and deriving it from
 *     "earliest surviving admin message" would improve the metric whenever a
 *     message was removed.
 *
 *  3. **An internal note is never emailed.** `is_internal` gates both the
 *     customer-facing API and the reply email; if you add another send path,
 *     it has to honour the flag too.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const { runLimited } = require('../../utils/concurrency');
const { sendTemplate } = require('../../services/emailTemplates');
const { escapeHtml, frontendUrl } = require('../../utils/emailLayout');

const router = express.Router();
const num = (v) => Number(v || 0);

const STATUSES = ['new', 'in_progress', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function invalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, null, errors.array()[0].msg, 400);
  return true;
}

// ── Attachments ──────────────────────────────────────────────────────────────

const uploadsDir = path.join(__dirname, '../../..', process.env.UPLOAD_DIR || 'uploads', 'support');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

/**
 * Attachments are stored under a generated name.
 *
 * The customer's own filename is kept in the database for display only — using
 * it on disk would let a crafted name escape the directory or overwrite another
 * thread's file.
 */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
      cb(null, `q${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image\/|application\/pdf$|text\/plain$|application\/(msword|vnd\.))/;
    if (!allowed.test(file.mimetype || '')) {
      cb(new Error('Only images, PDFs and documents can be attached'));
      return;
    }
    cb(null, true);
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The very first message of a thread lives on `queries.message`, not in
 * `query_messages` — the public contact form predates the conversation table.
 * This lifts it in so the thread reads as one conversation.
 */
async function ensureInitialMessage(queryRow) {
  const { rows } = await pool.query(
    'SELECT id FROM query_messages WHERE query_id = $1 LIMIT 1',
    [queryRow.id]
  );
  if (rows.length) return;
  await pool.query(
    `INSERT INTO query_messages (query_id, sender_type, sender_user_id, message, created_at)
     VALUES ($1, 'user', $2, $3, COALESCE($4, NOW()))`,
    [queryRow.id, queryRow.user_id || null, queryRow.message, queryRow.created_at || null]
  );
}

const THREAD_COLUMNS = `
  q.id, q.user_id, q.name, q.email, q.mobile, q.subject, q.category, q.status,
  q.priority, q.source, q.message, q.admin_notes, q.created_at, q.updated_at,
  q.handled_at, q.first_response_at, q.closed_at, q.admin_last_seen_at,
  q.handled_by_admin_id, q.assigned_to_admin_id,
  handler.name AS handled_by_name,
  assignee.name AS assigned_to_name,
  COALESCE(stats.message_count, 0) AS message_count,
  stats.last_message_at,
  stats.last_sender_type,
  stats.last_message,
  COALESCE(unread.unread_count, 0) AS unread_count`;

/**
 * Per-thread aggregates as two joined derived tables rather than four
 * correlated subqueries. The old version ran a subquery per row per column and
 * then ran the whole list query a second time; on this database that was the
 * difference between a fast list and a timeout.
 */
const THREAD_SOURCE = `
  FROM queries q
  LEFT JOIN admins handler ON handler.id = q.handled_by_admin_id
  LEFT JOIN admins assignee ON assignee.id = q.assigned_to_admin_id
  LEFT JOIN (
    SELECT m.query_id,
           COUNT(*) AS message_count,
           MAX(m.created_at) AS last_message_at,
           -- "The value from the latest row", done as one grouped pass instead
           -- of a correlated subquery per column. CHAR(1) is the separator
           -- because it cannot occur in text somebody typed; the timestamp
           -- prefix sorts correctly as a string, so MAX picks the newest row.
           SUBSTRING_INDEX(MAX(CONCAT(m.created_at, CHAR(1), m.sender_type)), CHAR(1), -1) AS last_sender_type,
           SUBSTRING_INDEX(MAX(CONCAT(m.created_at, CHAR(1), m.message)), CHAR(1), -1) AS last_message
      FROM query_messages m
     WHERE m.is_internal = 0
     GROUP BY m.query_id
  ) stats ON stats.query_id = q.id
  LEFT JOIN (
    SELECT m.query_id, COUNT(*) AS unread_count
      FROM query_messages m
      JOIN queries qq ON qq.id = m.query_id
     WHERE m.sender_type = 'user'
       AND m.is_internal = 0
       AND m.created_at > COALESCE(qq.admin_last_seen_at, '1970-01-01 00:00:00')
     GROUP BY m.query_id
  ) unread ON unread.query_id = q.id`;

async function getThread(queryId) {
  const { rows } = await pool.query(
    `SELECT ${THREAD_COLUMNS} ${THREAD_SOURCE} WHERE q.id = $1`,
    [queryId]
  );
  if (!rows.length) return null;
  const thread = rows[0];
  await ensureInitialMessage(thread);

  const [messages, attachments] = await runLimited([
    () =>
      pool.query(
        `SELECT m.id, m.sender_type, m.sender_user_id, m.sender_admin_id, m.message,
                m.is_internal, m.email_sent, m.email_sent_at, m.created_at,
                a.name AS admin_name
           FROM query_messages m
           LEFT JOIN admins a ON a.id = m.sender_admin_id
          WHERE m.query_id = $1
          ORDER BY m.created_at ASC, m.id ASC`,
        [queryId]
      ),
    () =>
      pool.query(
        `SELECT id, message_id, filename, original_name, mime_type, size_bytes, created_at
           FROM query_attachments WHERE query_id = $1 ORDER BY id ASC`,
        [queryId]
      ),
  ]);

  return {
    ...thread,
    unread_count: num(thread.unread_count),
    message_count: num(thread.message_count),
    messages: messages.rows.map((m) => ({
      ...m,
      is_internal: !!m.is_internal,
      attachments: attachments.rows.filter((a) => a.message_id === m.id),
    })),
    attachments: attachments.rows,
  };
}

/**
 * Everything the operator should see about this person without leaving the
 * thread — matched on email OR user id, so a guest booking counts as theirs.
 */
async function customerContext(thread) {
  const [profile, bookings, spend, otherQueries] = await runLimited([
    () =>
      pool.query(
        `SELECT id, first_middle_name, last_name, email, mobile_country_code, mobile_number,
                country, status, created_at, last_login_at
           FROM users WHERE id = $1 OR email = $2 LIMIT 1`,
        [thread.user_id || 0, thread.email]
      ),
    () =>
      pool.query(
        `SELECT id, booking_reference, product_title, status, payment_status,
                payment_amount, currency, check_in_date, created_at
           FROM bookings WHERE lead_email = $1 OR user_id = $2
          ORDER BY created_at DESC LIMIT 5`,
        [thread.email, thread.user_id || 0]
      ),
    () =>
      pool.query(
        `SELECT COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN payment_amount ELSE 0 END), 0) AS lifetime,
                COUNT(*) AS bookings,
                SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid
           FROM bookings WHERE lead_email = $1 OR user_id = $2`,
        [thread.email, thread.user_id || 0]
      ),
    () =>
      pool.query(
        `SELECT id, subject, status, created_at FROM queries
          WHERE (email = $1 OR user_id = $2) AND id <> $3
          ORDER BY created_at DESC LIMIT 10`,
        [thread.email, thread.user_id || 0, thread.id]
      ),
  ]);

  const u = profile.rows[0] || null;
  const s = spend.rows[0] || {};

  return {
    registered: Boolean(u),
    customerId: u?.id || null,
    name: u ? [u.first_middle_name, u.last_name].filter(Boolean).join(' ') : thread.name,
    email: thread.email,
    mobile: u
      ? [u.mobile_country_code, u.mobile_number].filter(Boolean).join(' ')
      : thread.mobile,
    country: u?.country || null,
    accountStatus: u?.status || null,
    joined: u?.created_at || null,
    lastSeen: u?.last_login_at || null,
    lifetimeSpend: Number(num(s.lifetime).toFixed(2)),
    bookings: num(s.bookings),
    paidBookings: num(s.paid),
    recentBookings: bookings.rows,
    otherQueries: otherQueries.rows,
  };
}

// ── List ─────────────────────────────────────────────────────────────────────

router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    if (req.query.status) add('q.status = ?', req.query.status);
    if (req.query.category) add('q.category = ?', req.query.category);
    if (req.query.priority) add('q.priority = ?', req.query.priority);

    // "Mine" is resolved from the session, never from a client-supplied id.
    if (req.query.assigned === 'me') add('q.assigned_to_admin_id = ?', req.admin.id);
    else if (req.query.assigned === 'unassigned') conditions.push('q.assigned_to_admin_id IS NULL');
    else if (req.query.assigned) add('q.assigned_to_admin_id = ?', req.query.assigned);

    if (req.query.unread === 'true') conditions.push('COALESCE(unread.unread_count, 0) > 0');
    if (req.query.open === 'true') conditions.push("q.status IN ('new', 'in_progress')");
    if (req.query.from) add('q.created_at >= ?', `${req.query.from} 00:00:00`);
    if (req.query.to) add('q.created_at <= ?', `${req.query.to} 23:59:59`);

    // Searching the conversation, not just the first message — the answer to
    // "what did we tell them about the refund?" is usually in a later reply.
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const p = `$${params.length}`;
      conditions.push(
        `(q.name LIKE ${p} OR q.email LIKE ${p} OR q.subject LIKE ${p} OR q.message LIKE ${p}
          OR EXISTS (SELECT 1 FROM query_messages sm WHERE sm.query_id = q.id AND sm.message LIKE ${p}))`
      );
    }

    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    const SORTS = {
      recent: 'COALESCE(stats.last_message_at, q.updated_at, q.created_at) DESC',
      oldest: 'q.created_at ASC',
      waiting: 'q.first_response_at IS NULL DESC, q.created_at ASC',
      priority: "FIELD(q.priority, 'urgent', 'high', 'normal', 'low') ASC, q.created_at ASC",
    };
    const order = SORTS[req.query.sort] || SORTS.recent;

    const [rows, total, stats] = await runLimited([
      () =>
        pool.query(
          `SELECT ${THREAD_COLUMNS} ${THREAD_SOURCE} ${where}
            ORDER BY ${order}, q.id DESC LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
      () => pool.query(`SELECT COUNT(*) AS total ${THREAD_SOURCE} ${where}`, params),
      () =>
        pool.query(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN q.status IN ('new','in_progress') THEN 1 ELSE 0 END) AS open_count,
                  SUM(CASE WHEN q.status = 'new' THEN 1 ELSE 0 END) AS new_count,
                  SUM(CASE WHEN q.assigned_to_admin_id IS NULL AND q.status IN ('new','in_progress') THEN 1 ELSE 0 END) AS unassigned,
                  SUM(CASE WHEN q.assigned_to_admin_id = $1 AND q.status IN ('new','in_progress') THEN 1 ELSE 0 END) AS mine,
                  SUM(CASE WHEN q.priority IN ('high','urgent') AND q.status IN ('new','in_progress') THEN 1 ELSE 0 END) AS urgent,
                  SUM(CASE WHEN COALESCE(unread.unread_count, 0) > 0 THEN 1 ELSE 0 END) AS with_unread,
                  SUM(CASE WHEN q.first_response_at IS NULL AND q.status IN ('new','in_progress') THEN 1 ELSE 0 END) AS never_answered
             ${THREAD_SOURCE}`,
          [req.admin.id]
        ),
    ]);

    // Ensure the opening message exists for anything on this page, once.
    await runLimited(rows.rows.filter((r) => !num(r.message_count)).map((r) => () => ensureInitialMessage(r)));

    const s = stats.rows[0] || {};
    const totalCount = num(total.rows[0]?.total);

    sendSuccess(
      res,
      {
        queries: rows.rows.map((r) => ({
          ...r,
          unread_count: num(r.unread_count),
          message_count: num(r.message_count) || 1,
          last_message: r.last_message || r.message,
          last_sender_type: r.last_sender_type || 'user',
        })),
        total: totalCount,
        page,
        limit,
        pages: Math.max(1, Math.ceil(totalCount / limit)),
        stats: {
          total: num(s.total),
          open: num(s.open_count),
          new: num(s.new_count),
          unassigned: num(s.unassigned),
          mine: num(s.mine),
          urgent: num(s.urgent),
          withUnread: num(s.with_unread),
          neverAnswered: num(s.never_answered),
        },
      },
      'Queries retrieved'
    );
  } catch (err) {
    console.error('queries list error:', err);
    sendError(res, err, 'Failed to load the queries', 500);
  }
});

// ── Metrics ──────────────────────────────────────────────────────────────────

/**
 * Response times.
 *
 * Measured only over threads that HAVE been answered — averaging in an
 * unanswered thread as zero would make a backlog look like good service. The
 * number still waiting is reported separately, which is the figure that
 * actually needs acting on.
 */
router.get('/metrics', adminAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365);

    const [response, volume, byCategory, backlog] = await runLimited([
      () =>
        pool.query(
          `SELECT COUNT(*) AS answered,
                  AVG(TIMESTAMPDIFF(MINUTE, created_at, first_response_at)) AS avg_first_minutes,
                  MIN(TIMESTAMPDIFF(MINUTE, created_at, first_response_at)) AS fastest_minutes,
                  MAX(TIMESTAMPDIFF(MINUTE, created_at, first_response_at)) AS slowest_minutes,
                  SUM(CASE WHEN TIMESTAMPDIFF(HOUR, created_at, first_response_at) <= 24 THEN 1 ELSE 0 END) AS within_24h
             FROM queries
            WHERE first_response_at IS NOT NULL
              AND created_at >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)`
        ),
      () =>
        pool.query(
          `SELECT DATE(created_at) AS day, COUNT(*) AS opened
             FROM queries
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)
            GROUP BY DATE(created_at) ORDER BY day ASC`
        ),
      () =>
        pool.query(
          `SELECT COALESCE(category, 'uncategorised') AS category,
                  COUNT(*) AS total,
                  AVG(TIMESTAMPDIFF(MINUTE, created_at, first_response_at)) AS avg_first_minutes
             FROM queries
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)
            GROUP BY COALESCE(category, 'uncategorised') ORDER BY total DESC`
        ),
      () =>
        pool.query(
          `SELECT COUNT(*) AS waiting,
                  AVG(TIMESTAMPDIFF(HOUR, created_at, NOW())) AS avg_wait_hours,
                  MAX(TIMESTAMPDIFF(HOUR, created_at, NOW())) AS longest_wait_hours
             FROM queries
            WHERE first_response_at IS NULL AND status IN ('new', 'in_progress')`
        ),
    ]);

    const r = response.rows[0] || {};
    const b = backlog.rows[0] || {};
    const answered = num(r.answered);

    const [resolution] = await runLimited([
      () =>
        pool.query(
          `SELECT COUNT(*) AS resolved,
                  AVG(TIMESTAMPDIFF(HOUR, created_at, closed_at)) AS avg_hours
             FROM queries
            WHERE closed_at IS NOT NULL
              AND created_at >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)`
        ),
    ]);
    const res2 = resolution.rows[0] || {};

    sendSuccess(
      res,
      {
        days,
        firstResponse: {
          answered,
          avgMinutes: answered ? Math.round(num(r.avg_first_minutes)) : null,
          fastestMinutes: answered ? num(r.fastest_minutes) : null,
          slowestMinutes: answered ? num(r.slowest_minutes) : null,
          within24h: num(r.within_24h),
          within24hRate: answered ? Number(((num(r.within_24h) / answered) * 100).toFixed(1)) : null,
        },
        resolution: {
          resolved: num(res2.resolved),
          avgHours: num(res2.resolved) ? Math.round(num(res2.avg_hours)) : null,
        },
        backlog: {
          waiting: num(b.waiting),
          avgWaitHours: num(b.waiting) ? Math.round(num(b.avg_wait_hours)) : null,
          longestWaitHours: num(b.waiting) ? num(b.longest_wait_hours) : null,
        },
        volume: volume.rows.map((v) => ({ day: v.day, opened: num(v.opened) })),
        byCategory: byCategory.rows.map((c) => ({
          category: c.category,
          total: num(c.total),
          avgMinutes: c.avg_first_minutes === null ? null : Math.round(num(c.avg_first_minutes)),
        })),
        note: 'Averages cover answered threads only. Anything still waiting is counted in the backlog instead, so a growing queue cannot hide inside a good average.',
      },
      'Support metrics retrieved'
    );
  } catch (err) {
    console.error('query metrics error:', err);
    sendError(res, err, 'Failed to load the support metrics', 500);
  }
});

// ── Assignable operators ─────────────────────────────────────────────────────

router.get('/assignees', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.email,
              (SELECT COUNT(*) FROM queries q
                WHERE q.assigned_to_admin_id = a.id AND q.status IN ('new','in_progress')) AS open_threads
         FROM admins a WHERE a.status = 'active' ORDER BY a.name ASC`
    );
    sendSuccess(
      res,
      {
        assignees: rows.map((a) => ({ ...a, open_threads: num(a.open_threads) })),
        // Said out loud because the plan asked for "assign to a team member" and
        // this panel has no team: roles and multi-operator were dropped.
        note:
          rows.length > 1
            ? null
            : 'There is one admin account, so assignment marks a thread as owned rather than handing it to someone else.',
      },
      'Assignees retrieved'
    );
  } catch (err) {
    console.error('assignees error:', err);
    sendError(res, err, 'Failed to load the operator list', 500);
  }
});

// ── Canned replies ───────────────────────────────────────────────────────────

router.get('/canned', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, category, shortcut, body, use_count, updated_at FROM canned_replies ORDER BY use_count DESC, title ASC'
    );
    sendSuccess(res, { replies: rows.map((r) => ({ ...r, use_count: num(r.use_count) })) }, 'Canned replies retrieved');
  } catch (err) {
    console.error('canned list error:', err);
    sendError(res, err, 'Failed to load the saved replies', 500);
  }
});

router.post(
  '/canned',
  adminAuth,
  body('title').trim().isLength({ min: 3 }).withMessage('Give the reply a title'),
  body('body').trim().isLength({ min: 10 }).withMessage('Write the reply'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const result = await pool.query(
        `INSERT INTO canned_replies (title, category, shortcut, body, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.body.title,
          req.body.category || 'general',
          req.body.shortcut || null,
          req.body.body,
          req.admin.id,
        ]
      );
      sendSuccess(res, { id: result.insertId }, 'Saved reply created');
    } catch (err) {
      if (/duplicate/i.test(err.message)) {
        return sendError(res, null, 'A saved reply with that title already exists', 409);
      }
      console.error('canned create error:', err);
      sendError(res, err, 'Failed to save the reply', 500);
    }
  }
);

router.put('/canned/:id', adminAuth, async (req, res) => {
  try {
    const updates = [];
    const params = [];
    for (const field of ['title', 'category', 'shortcut', 'body']) {
      if (req.body[field] === undefined) continue;
      params.push(req.body[field]);
      updates.push(`${field} = $${params.length}`);
    }
    if (!updates.length) return sendError(res, null, 'Nothing to update', 400);

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE canned_replies SET ${updates.join(', ')} WHERE id = $${params.length}`,
      params
    );
    if (!result.rowCount) return sendError(res, null, 'Saved reply not found', 404);
    sendSuccess(res, { id: Number(req.params.id) }, 'Saved reply updated');
  } catch (err) {
    console.error('canned update error:', err);
    sendError(res, err, 'Failed to update the saved reply', 500);
  }
});

router.delete('/canned/:id', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM canned_replies WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return sendError(res, null, 'Saved reply not found', 404);
    sendSuccess(res, { id: Number(req.params.id) }, 'Saved reply deleted');
  } catch (err) {
    console.error('canned delete error:', err);
    sendError(res, err, 'Failed to delete the saved reply', 500);
  }
});

// ── One thread ───────────────────────────────────────────────────────────────

router.get('/:queryId', adminAuth, async (req, res) => {
  try {
    const thread = await getThread(req.params.queryId);
    if (!thread) return sendError(res, null, 'Query not found', 404);

    const context = await customerContext(thread);

    // Opening a thread marks it read. Done after the thread is read out, so the
    // response still shows what was unread when the operator opened it.
    await pool.query('UPDATE queries SET admin_last_seen_at = NOW() WHERE id = $1', [
      req.params.queryId,
    ]);

    sendSuccess(res, { query: thread, customer: context }, 'Query retrieved');
  } catch (err) {
    console.error('query detail error:', err);
    sendError(res, err, 'Failed to load this conversation', 500);
  }
});

// ── Update ───────────────────────────────────────────────────────────────────

router.patch(
  '/:queryId',
  adminAuth,
  body('status').optional().isIn(STATUSES).withMessage('Unknown status'),
  body('priority').optional().isIn(PRIORITIES).withMessage('Unknown priority'),
  body('admin_notes').optional().isString(),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const { rows } = await pool.query(
        'SELECT id, status, priority, assigned_to_admin_id, email FROM queries WHERE id = $1',
        [req.params.queryId]
      );
      if (!rows.length) return sendError(res, null, 'Query not found', 404);
      const before = rows[0];

      const updates = [];
      const params = [];
      const set = (sql, value) => {
        params.push(value);
        updates.push(sql.replace('?', `$${params.length}`));
      };

      if (req.body.status) {
        set('status = ?', req.body.status);
        set('handled_by_admin_id = ?', req.admin.id);
        if (['resolved', 'closed'].includes(req.body.status)) {
          updates.push('handled_at = NOW()', 'closed_at = COALESCE(closed_at, NOW())');
        } else {
          // Reopening has to clear the close time, or resolution metrics keep
          // counting a thread that is open again.
          updates.push('closed_at = NULL');
        }
      }
      if (req.body.priority) set('priority = ?', req.body.priority);
      if (req.body.admin_notes !== undefined) set('admin_notes = ?', req.body.admin_notes);

      if (req.body.assigned_to !== undefined) {
        const assignee = req.body.assigned_to === null || req.body.assigned_to === ''
          ? null
          : Number(req.body.assigned_to);
        if (assignee !== null) {
          const check = await pool.query("SELECT id FROM admins WHERE id = $1 AND status = 'active'", [assignee]);
          if (!check.rows.length) return sendError(res, null, 'That operator does not exist', 400);
        }
        set('assigned_to_admin_id = ?', assignee);
      }

      if (!updates.length) return sendError(res, null, 'Nothing to update', 400);

      updates.push('updated_at = NOW()');
      params.push(req.params.queryId);
      await pool.query(
        `UPDATE queries SET ${updates.join(', ')} WHERE id = $${params.length}`,
        params
      );

      const changes = [];
      if (req.body.status && req.body.status !== before.status) {
        changes.push(`status ${before.status} → ${req.body.status}`);
      }
      if (req.body.priority && req.body.priority !== before.priority) {
        changes.push(`priority ${before.priority} → ${req.body.priority}`);
      }
      if (req.body.assigned_to !== undefined) changes.push('assignment changed');
      if (req.body.admin_notes !== undefined) changes.push('internal note edited');

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.query.updated',
        entityType: 'query',
        entityId: before.id,
        summary: `Query #${before.id} (${before.email}): ${changes.join(', ') || 'no visible change'}`,
        metadata: { changes },
      });

      sendSuccess(res, { query: await getThread(req.params.queryId) }, 'Conversation updated');
    } catch (err) {
      console.error('query update error:', err);
      sendError(res, err, 'Failed to update this conversation', 500);
    }
  }
);

// ── Internal note ────────────────────────────────────────────────────────────

/**
 * A note on the thread that the customer never sees.
 *
 * Stored as a message so it sits in the conversation in the right place — a
 * note written between two replies belongs between them, not in a separate box
 * with no idea what it was about.
 */
router.post(
  '/:queryId/note',
  adminAuth,
  body('message').trim().isLength({ min: 1 }).withMessage('Write the note'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const { rows } = await pool.query('SELECT id FROM queries WHERE id = $1', [req.params.queryId]);
      if (!rows.length) return sendError(res, null, 'Query not found', 404);

      await pool.query(
        `INSERT INTO query_messages (query_id, sender_type, sender_admin_id, message, is_internal)
         VALUES ($1, 'admin', $2, $3, 1)`,
        [req.params.queryId, req.admin.id, req.body.message]
      );
      await pool.query('UPDATE queries SET updated_at = NOW() WHERE id = $1', [req.params.queryId]);

      sendSuccess(res, { query: await getThread(req.params.queryId) }, 'Internal note added');
    } catch (err) {
      console.error('query note error:', err);
      sendError(res, err, 'Failed to add the note', 500);
    }
  }
);

// ── Reply ────────────────────────────────────────────────────────────────────

router.post(
  '/:queryId/reply',
  adminAuth,
  upload.array('attachments', 5),
  body('message').trim().isLength({ min: 1 }).withMessage('Write a reply'),
  body('status').optional().isIn(STATUSES).withMessage('Unknown status'),
  async (req, res) => {
    if (invalid(req, res)) return;

    const client = await pool.connect();
    let inTransaction = false;
    try {
      const thread = await getThread(req.params.queryId);
      if (!thread) return sendError(res, null, 'Query not found', 404);

      const message = req.body.message;
      const nextStatus = req.body.status || 'in_progress';

      await client.query('BEGIN');
      inTransaction = true;

      const inserted = await client.query(
        `INSERT INTO query_messages (query_id, sender_type, sender_admin_id, message, is_internal, email_sent)
         VALUES ($1, 'admin', $2, $3, 0, 0)`,
        [thread.id, req.admin.id, message]
      );
      const messageId = inserted.insertId;

      for (const file of req.files || []) {
        await client.query(
          `INSERT INTO query_attachments
             (query_id, message_id, filename, original_name, mime_type, size_bytes, uploaded_by_admin_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [thread.id, messageId, file.filename, file.originalname, file.mimetype, file.size, req.admin.id]
        );
      }

      // first_response_at is set once and only once - see the note at the top.
      await client.query(
        `UPDATE queries
            SET status = $1,
                handled_by_admin_id = $2,
                assigned_to_admin_id = COALESCE(assigned_to_admin_id, $2),
                first_response_at = COALESCE(first_response_at, NOW()),
                handled_at = CASE WHEN $1 IN ('resolved','closed') THEN NOW() ELSE handled_at END,
                closed_at = CASE WHEN $1 IN ('resolved','closed') THEN COALESCE(closed_at, NOW()) ELSE NULL END,
                user_last_seen_at = NULL,
                updated_at = NOW()
          WHERE id = $3`,
        [nextStatus, req.admin.id, thread.id]
      );

      await client.query('COMMIT');
      inTransaction = false;

      // The reply is saved before the email is attempted. A mail outage must not
      // lose what the operator wrote, and the conversation is the record of
      // record - the email is a copy of it.
      const emailResult = await emailTheReply(thread, message, req.files || []);

      if (emailResult.success) {
        await pool.query(
          'UPDATE query_messages SET email_sent = 1, email_sent_at = NOW() WHERE id = $1',
          [messageId]
        );
      }

      if (req.body.cannedReplyId) {
        await pool
          .query('UPDATE canned_replies SET use_count = use_count + 1 WHERE id = $1', [
            req.body.cannedReplyId,
          ])
          .catch(() => {});
      }

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.query.replied',
        entityType: 'query',
        entityId: thread.id,
        summary: `Replied to ${thread.email} on query #${thread.id}`,
        status: emailResult.success ? 'success' : 'failed',
        metadata: { attachments: (req.files || []).length, status: nextStatus },
      });

      sendSuccess(
        res,
        { query: await getThread(thread.id), email: emailResult },
        emailResult.success
          ? 'Reply sent'
          : `Reply saved on the conversation, but the email could not be delivered: ${emailResult.reason}`
      );
    } catch (err) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => {});
      console.error('query reply error:', err);
      sendError(res, err, 'Failed to send the reply', 500);
    } finally {
      client.release();
    }
  }
);

/**
 * Email one reply to the customer.
 *
 * Goes through the `query_reply` template, so it is logged in
 * `email_notifications` beside every other email and shows up in the customer's
 * history. It used to build its own HTML and log nothing at all.
 */
async function emailTheReply(thread, message, files = []) {
  const attachmentNote = files.length
    ? `<p style="margin:14px 0 0; font-size:13px; color:#64748b;">${files.length} file${
        files.length === 1 ? '' : 's'
      } attached to this reply in your dashboard conversation.</p>`
    : '';

  return sendTemplate({
    key: 'query_reply',
    kind: 'query_reply',
    to: thread.email,
    vars: {
      guest_name: thread.name || 'there',
      subject: thread.subject || 'your question',
      reference: `#${thread.id}`,
      reply_html: escapeHtml(message).replace(/\r?\n/g, '<br />') + attachmentNote,
      original_html: escapeHtml(thread.message || '').replace(/\r?\n/g, '<br />'),
      conversation_url: `${frontendUrl()}/dashboard?tab=queries&query=${thread.id}`,
    },
  });
}

// ── Attachments ──────────────────────────────────────────────────────────────

router.get('/:queryId/attachments/:attachmentId', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM query_attachments WHERE id = $1 AND query_id = $2',
      [req.params.attachmentId, req.params.queryId]
    );
    if (!rows.length) return sendError(res, null, 'Attachment not found', 404);

    // path.basename, because the stored name is the only thing between a
    // database value and an arbitrary read off this disk.
    const filePath = path.join(uploadsDir, path.basename(rows[0].filename));
    if (!fs.existsSync(filePath)) return sendError(res, null, 'The file is missing from disk', 410);

    res.setHeader('Content-Type', rows[0].mime_type || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${rows[0].original_name.replace(/"/g, '')}"`
    );
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('attachment error:', err);
    sendError(res, err, 'Failed to fetch this attachment', 500);
  }
});

// ── Resend / delete ──────────────────────────────────────────────────────────

router.post('/:queryId/resend-email', adminAuth, async (req, res) => {
  try {
    const thread = await getThread(req.params.queryId);
    if (!thread) return sendError(res, null, 'Query not found', 404);

    const lastReply = [...thread.messages]
      .reverse()
      .find((m) => m.sender_type === 'admin' && !m.is_internal);
    if (!lastReply) return sendError(res, null, 'There is no reply to resend', 400);

    const emailResult = await emailTheReply(thread, lastReply.message);
    if (emailResult.success) {
      await pool.query(
        'UPDATE query_messages SET email_sent = 1, email_sent_at = NOW() WHERE id = $1',
        [lastReply.id]
      );
    }

    if (!emailResult.success) {
      return sendError(res, null, `Could not send: ${emailResult.reason}`, 502);
    }
    sendSuccess(res, { email: emailResult }, 'Reply emailed again');
  } catch (err) {
    console.error('resend query email error:', err);
    sendError(res, err, 'Failed to resend the reply', 500);
  }
});

router.delete('/:queryId', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, subject FROM queries WHERE id = $1', [
      req.params.queryId,
    ]);
    if (!rows.length) return sendError(res, null, 'Query not found', 404);

    await pool.query('DELETE FROM queries WHERE id = $1', [req.params.queryId]);
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.query.deleted',
      entityType: 'query',
      entityId: rows[0].id,
      summary: `Deleted query #${rows[0].id} from ${rows[0].email}`,
    });
    sendSuccess(res, { id: rows[0].id }, 'Conversation deleted');
  } catch (err) {
    console.error('delete query error:', err);
    sendError(res, err, 'Failed to delete this conversation', 500);
  }
});

/**
 * Turn an upload rejection into the JSON the panel expects.
 *
 * Without this, a file that is too large or of the wrong type reaches Express's
 * default handler and comes back as an HTML error page, which the admin UI
 * cannot parse - so the operator sees "unexpected token <" instead of "that
 * file is too big".
 */
router.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, null, 'Attachments must be 10MB or smaller', 413);
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return sendError(res, null, 'You can attach up to 5 files to one reply', 400);
  }
  if (/can be attached/.test(err.message || '')) {
    return sendError(res, null, err.message, 415);
  }
  console.error('queries route error:', err);
  return sendError(res, err, 'Something went wrong handling that request', 500);
});

module.exports = router;
