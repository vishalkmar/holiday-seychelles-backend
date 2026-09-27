/**
 * Customer 360.
 *
 * Everything the business knows about one person, assembled from the tables
 * that actually exist: their account, every booking, every payment and refund,
 * every voucher, every email we sent them, and their support history.
 *
 * Bookings are matched by user_id OR lead_email — a guest checkout made before
 * the customer registered is still theirs, and pretending otherwise would hide
 * spend from the very screen meant to show it.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const { runLimited } = require('../../utils/concurrency');
const { sendTemplate } = require('../../services/emailTemplates');
const { generateVoucherPDF } = require('../../utils/voucher');

const router = express.Router();
const num = (v) => Number(v || 0);
const money = (v) => Number(Number(v || 0).toFixed(2));

// The mount's customers.manage permission protects this write endpoint.
router.post('/', adminAuth,
  body('email').isString().bail().trim().isLength({ max: 190 }).isEmail().withMessage('Enter a valid email address'),
  body('first_middle_name').isString().bail().trim().isLength({ min: 1, max: 120 }).withMessage('First name is required'),
  body('last_name').optional().isString().bail().trim().isLength({ max: 120 }),
  body('mobile_number').optional().isString().bail().trim().isLength({ max: 30 }),
  body('country').optional().isString().bail().trim().isLength({ max: 120 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ status: 'error', message: errors.array()[0].msg, errors: errors.array() });
    try {
      const { first_middle_name, last_name, mobile_number, country } = req.body;
      const email = req.body.email.toLowerCase();
      const result = await pool.query(
        `INSERT INTO users (email, first_middle_name, last_name, mobile_number, country)
         VALUES ($1, $2, $3, $4, $5)`,
        [email, first_middle_name, last_name || null, mobile_number || null, country || null]
      );
      await sec.audit({ req, adminId: req.admin.id, action: 'admin.customer.created', entityType: 'user', entityId: result.insertId, summary: `Customer created: ${email}` });
      return sendSuccess(res, { id: result.insertId }, 'Customer created', 201);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return sendError(res, null, 'A customer with this email already exists', 409);
      return sendError(res, err, 'Failed to create customer', 500);
    }
  }
);

function fullName(u) {
  return [u.first_middle_name, u.last_name].filter(Boolean).join(' ').trim() || 'Unnamed';
}

// ── GET / ────────────────────────────────────────────────────────────────────
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

    if (req.query.status) add('u.status = ?', req.query.status);
    if (req.query.profile === 'complete') conditions.push('u.is_profile_complete = 1');
    if (req.query.profile === 'incomplete') conditions.push('u.is_profile_complete = 0');
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const p = `$${params.length}`;
      conditions.push(
        `(u.email LIKE ${p} OR u.first_middle_name LIKE ${p} OR u.last_name LIKE ${p} OR u.mobile_number LIKE ${p})`
      );
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    const SORTS = {
      newest: 'u.created_at DESC',
      oldest: 'u.created_at ASC',
      spend_desc: 'lifetime_spend DESC',
      bookings_desc: 'booking_count DESC',
      name: 'u.first_middle_name ASC',
    };
    const order = SORTS[req.query.sort] || SORTS.newest;

    // Spend is aggregated per customer in a subquery keyed on email, so guest
    // bookings count towards the account that shares the address.
    const listSql = `
      SELECT u.id, u.email, u.first_middle_name, u.last_name, u.mobile_country_code,
             u.mobile_number, u.status, u.is_profile_complete, u.country,
             u.created_at, u.last_login_at,
             COALESCE(b.booking_count, 0) AS booking_count,
             COALESCE(b.lifetime_spend, 0) AS lifetime_spend,
             COALESCE(b.paid_count, 0) AS paid_count,
             COALESCE(b.cancelled_count, 0) AS cancelled_count,
             b.last_booking_at
        FROM users u
        LEFT JOIN (
          SELECT lead_email,
                 COUNT(*) AS booking_count,
                 COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN payment_amount ELSE 0 END), 0) AS lifetime_spend,
                 SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
                 SUM(CASE WHEN status IN ('cancelled','refunded') THEN 1 ELSE 0 END) AS cancelled_count,
                 MAX(created_at) AS last_booking_at
            FROM bookings GROUP BY lead_email
        ) AS b ON b.lead_email = u.email
        ${where}`;

    const [rows, totals, stats, registrations] = await runLimited([
      () => pool.query(`${listSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params),
      () => pool.query(`SELECT COUNT(*) AS total FROM users u ${where}`, params),
      () =>
        pool.query(
          `SELECT COUNT(*) AS customers,
                  SUM(CASE WHEN u.status = 'active' THEN 1 ELSE 0 END) AS active,
                  SUM(CASE WHEN u.is_profile_complete = 1 THEN 1 ELSE 0 END) AS complete,
                  SUM(CASE WHEN u.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS new_30d
             FROM users u`
        ),
      () => pool.query(`SELECT DATE(created_at) AS day, COUNT(*) AS registered,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN is_profile_complete = 1 THEN 1 ELSE 0 END) AS complete,
          SUM(CASE WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS recent
        FROM users GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 14`),
    ]);

    const total = num(totals.rows[0]?.total);
    const s = stats.rows[0] || {};

    sendSuccess(
      res,
      {
        customers: rows.rows.map((u) => ({
          id: u.id,
          name: fullName(u),
          email: u.email,
          mobile: [u.mobile_country_code, u.mobile_number].filter(Boolean).join(' '),
          country: u.country,
          status: u.status,
          profileComplete: !!u.is_profile_complete,
          joined: u.created_at,
          lastSeen: u.last_login_at,
          bookings: num(u.booking_count),
          paid: num(u.paid_count),
          cancelled: num(u.cancelled_count),
          lifetimeSpend: money(u.lifetime_spend),
          lastBookingAt: u.last_booking_at,
        })),
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit)),
        stats: {
          trends: Object.fromEntries(['registered', 'active', 'complete', 'recent'].map((key) => [
            key, [...registrations.rows].reverse().map((row) => num(row[key])),
          ])),
          customers: num(s.customers),
          active: num(s.active),
          profileComplete: num(s.complete),
          newLast30: num(s.new_30d),
        },
      },
      'Customers retrieved'
    );
  } catch (err) {
    console.error('customers list error:', err);
    sendError(res, err, 'Failed to load customers', 500);
  }
});

// ── GET /:id ─────────────────────────────────────────────────────────────────
router.get('/:id', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return sendError(res, null, 'Customer not found', 404);
    const u = rows[0];

    // Everything below is keyed on the email, so guest bookings are included.
    const [bookings, payments, emails, queries, spend] = await runLimited([
      () =>
        pool.query(
          `SELECT id, booking_reference, product_title, booking_type, status, payment_status,
                  payment_amount, refund_amount, currency, check_in_date, check_out_date,
                  total_travellers, supplier_reference, supplier_status, voucher_path,
                  voucher_generated_at, created_at
             FROM bookings
            WHERE lead_email = $1 OR user_id = $2
            ORDER BY created_at DESC`,
          [u.email, u.id]
        ),
      () =>
        pool.query(
          `SELECT o.order_reference, o.status, o.decision, o.amount, o.currency,
                  o.gateway, o.gateway_reference, o.product_title, o.created_at, o.paid_at,
                  o.booking_id
             FROM payment_orders o
            WHERE o.lead_email = $1 OR o.user_id = $2
            ORDER BY o.created_at DESC`,
          [u.email, u.id]
        ),
      () =>
        pool.query(
          `SELECT n.kind, n.recipient, n.status, n.error, n.sent_at,
                  b.booking_reference
             FROM email_notifications n
             LEFT JOIN bookings b ON b.id = n.booking_id
            WHERE n.recipient = $1
            ORDER BY n.sent_at DESC LIMIT 100`,
          [u.email]
        ),
      () =>
        pool.query(
          `SELECT id, subject, category, status, created_at, updated_at
             FROM queries WHERE user_id = $1 OR email = $2
            ORDER BY created_at DESC LIMIT 50`,
          [u.id, u.email]
        ),
      () =>
        pool.query(
          `SELECT COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN payment_amount ELSE 0 END), 0) AS lifetime,
                  COALESCE(SUM(refund_amount), 0) AS refunded,
                  COUNT(*) AS bookings,
                  SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
                  SUM(CASE WHEN status IN ('cancelled','refunded') THEN 1 ELSE 0 END) AS cancelled,
                  SUM(CASE WHEN status = 'pending_supplier' THEN 1 ELSE 0 END) AS pending_supplier,
                  COALESCE(SUM(total_travellers), 0) AS travellers,
                  MAX(CASE WHEN payment_status = 'paid' THEN created_at ELSE NULL END) AS last_paid_at
             FROM bookings WHERE lead_email = $1 OR user_id = $2`,
          [u.email, u.id]
        ),
    ]);

    const st = spend.rows[0] || {};
    const paidCount = num(st.paid);
    const pendingOrders = payments.rows.filter((p) =>
      ['created', 'redirected'].includes(p.status)
    );

    sendSuccess(
      res,
      {
        profile: {
          id: u.id,
          name: fullName(u),
          firstName: u.first_middle_name,
          lastName: u.last_name,
          email: u.email,
          mobile: [u.mobile_country_code, u.mobile_number].filter(Boolean).join(' '),
          mobileVerified: !!u.mobile_verified,
          gender: u.gender,
          dateOfBirth: u.date_of_birth,
          nationality: u.nationality,
          maritalStatus: u.marital_status,
          anniversary: u.anniversary,
          city: u.city_of_residence,
          state: u.state,
          country: u.country,
          passportNo: u.passport_no,
          passportExpiry: u.passport_expiry,
          passportCountry: u.passport_issuing_country,
          panCard: u.pan_card_number,
          profileImage: u.profile_image,
          profileComplete: !!u.is_profile_complete,
          status: u.status,
          joined: u.created_at,
          lastSeen: u.last_login_at,
          adminNotes: u.admin_notes || '',
        },
        stats: {
          lifetimeSpend: money(st.lifetime),
          refunded: money(st.refunded),
          netSpend: money(num(st.lifetime) - num(st.refunded)),
          bookings: num(st.bookings),
          paid: paidCount,
          cancelled: num(st.cancelled),
          pendingSupplier: num(st.pending_supplier),
          travellers: num(st.travellers),
          avgBooking: paidCount > 0 ? money(num(st.lifetime) / paidCount) : 0,
          lastPaidAt: st.last_paid_at,
          pendingPayments: pendingOrders.length,
          pendingValue: money(pendingOrders.reduce((a, p) => a + num(p.amount), 0)),
          openQueries: queries.rows.filter((q) => q.status !== 'closed').length,
        },
        bookings: bookings.rows,
        payments: payments.rows,
        vouchers: bookings.rows
          .filter((b) => b.voucher_path || b.payment_status === 'paid')
          .map((b) => ({
            bookingId: b.id,
            reference: b.booking_reference,
            product: b.product_title,
            generatedAt: b.voucher_generated_at,
            available: !!b.voucher_path,
            amount: money(b.payment_amount),
            currency: b.currency,
          })),
        emails: emails.rows,
        queries: queries.rows,
        // Named explicitly so the UI can say "not tracked" rather than "zero".
        notTracked: ['wallet balance', 'wishlist', 'referrals'],
      },
      'Customer retrieved'
    );
  } catch (err) {
    console.error('customer detail error:', err);
    sendError(res, err, 'Failed to load this customer', 500);
  }
});

// ── PATCH /:id ───────────────────────────────────────────────────────────────
router.patch(
  '/:id',
  adminAuth,
  body('status').optional().isIn(['active', 'suspended', 'inactive']),
  body('admin_notes').optional().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { rows } = await pool.query('SELECT id, email, status FROM users WHERE id = $1', [
        req.params.id,
      ]);
      if (!rows.length) return sendError(res, null, 'Customer not found', 404);
      const before = rows[0];

      const updates = [];
      const params = [];
      if (req.body.status !== undefined) {
        params.push(req.body.status);
        updates.push(`status = $${params.length}`);
      }
      if (req.body.admin_notes !== undefined) {
        params.push(req.body.admin_notes);
        updates.push(`admin_notes = $${params.length}`);
      }
      if (!updates.length) return sendError(res, null, 'Nothing to update', 400);

      params.push(req.params.id);
      await pool.query(
        `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
        params
      );

      // Suspending must also end their sessions, or the account stays usable.
      if (req.body.status && req.body.status !== 'active') {
        await pool.query(
          `UPDATE auth_tokens SET revoked_at = NOW()
            WHERE subject_type = 'user' AND subject_id = $1 AND revoked_at IS NULL`,
          [req.params.id]
        );
      }

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: req.body.status ? 'admin.customer.status_changed' : 'admin.customer.note',
        entityType: 'user',
        entityId: req.params.id,
        summary: req.body.status
          ? `${before.email}: ${before.status} → ${req.body.status}`
          : `Note updated for ${before.email}`,
      });

      sendSuccess(res, { id: Number(req.params.id) }, 'Customer updated');
    } catch (err) {
      console.error('customer update error:', err);
      sendError(res, err, 'Failed to update the customer', 500);
    }
  }
);

// ── POST /:id/email ──────────────────────────────────────────────────────────
/**
 * Send a one-off email from the admin panel.
 *
 * Logged to `email_notifications` like every automated message, so the
 * customer's email history is one list rather than two. Rich templates arrive
 * in Module 10; this is a subject and a body.
 */
router.post(
  '/:id/email',
  adminAuth,
  body('subject').trim().isLength({ min: 3 }).withMessage('Give the email a subject'),
  body('message').trim().isLength({ min: 10 }).withMessage('Write a message'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    }

    try {
      const { rows } = await pool.query(
        'SELECT id, email, first_middle_name, last_name FROM users WHERE id = $1',
        [req.params.id]
      );
      if (!rows.length) return sendError(res, null, 'Customer not found', 404);
      const u = rows[0];

      // Goes through the same template and the same log as every other email,
      // so an operator's one-off message appears in the customer's history
      // beside the automated ones instead of in a parallel record.
      const outcome = await sendTemplate({
        key: 'admin_message',
        kind: 'admin_message',
        to: u.email,
        vars: {
          guest_name: fullName(u),
          subject: req.body.subject,
          // Typed as plain text; newlines become breaks and nothing else is
          // interpreted, so an admin cannot paste markup into a customer email.
          message_html: escapeHtml(req.body.message).replace(/\r?\n/g, '<br />'),
        },
      });

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.customer.email_sent',
        entityType: 'user',
        entityId: u.id,
        summary: `Emailed ${u.email}: ${req.body.subject}`,
        status: outcome.success ? 'success' : 'failed',
        metadata: { subject: req.body.subject },
      });

      if (!outcome.success) {
        return sendError(res, null, `Could not send: ${outcome.reason}`, 502);
      }
      sendSuccess(res, { sentTo: u.email }, 'Email sent');
    } catch (err) {
      console.error('customer email error:', err);
      sendError(res, err, 'Failed to send the email', 500);
    }
  }
);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── GET /:id/voucher/:bookingId ──────────────────────────────────────────────
/**
 * Stream a customer's voucher to the operator.
 *
 * Vouchers sit in the public uploads directory, so linking to `voucher_path`
 * would hand out a URL that works for anyone who sees it. This streams the file
 * behind admin auth instead, and regenerates it if the row has no PDF yet —
 * which is the usual case for a booking confirmed before vouchers existed.
 */
router.get('/:id/voucher/:bookingId', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.* FROM bookings b
         JOIN users u ON (u.email = b.lead_email OR u.id = b.user_id)
        WHERE b.id = $1 AND u.id = $2
        LIMIT 1`,
      [req.params.bookingId, req.params.id]
    );
    if (!rows.length) return sendError(res, null, 'No such voucher for this customer', 404);

    const booking = rows[0];
    const uploads = path.join(__dirname, '../../..', process.env.UPLOAD_DIR || 'uploads');
    let absolutePath = booking.voucher_path
      ? path.join(uploads, path.basename(booking.voucher_path))
      : null;

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      const generated = await generateVoucherPDF(booking);
      absolutePath = generated.absolutePath;
      await pool.query(
        'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
        [generated.relativePath, booking.id]
      );
    }

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.customer.voucher_downloaded',
      entityType: 'booking',
      entityId: booking.id,
      summary: `Downloaded the voucher for ${booking.booking_reference}`,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="voucher-${booking.booking_reference}.pdf"`
    );
    fs.createReadStream(absolutePath).pipe(res);
  } catch (err) {
    console.error('customer voucher error:', err);
    sendError(res, err, 'Failed to fetch this voucher', 500);
  }
});

// ── GET /:id/export ──────────────────────────────────────────────────────────
router.get('/:id/export', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return sendError(res, null, 'Customer not found', 404);
    const u = rows[0];

    const [bookings, payments, emails] = await runLimited([
      () =>
        pool.query(
          `SELECT booking_reference, created_at, product_title, booking_type, status,
                  payment_status, payment_amount, refund_amount, currency, check_in_date
             FROM bookings WHERE lead_email = $1 OR user_id = $2 ORDER BY created_at DESC`,
          [u.email, u.id]
        ),
      () =>
        pool.query(
          `SELECT order_reference, status, amount, currency, gateway_reference, created_at
             FROM payment_orders WHERE lead_email = $1 OR user_id = $2 ORDER BY created_at DESC`,
          [u.email, u.id]
        ),
      () =>
        pool.query(
          `SELECT kind, status, sent_at FROM email_notifications WHERE recipient = $1
            ORDER BY sent_at DESC`,
          [u.email]
        ),
    ]);

    const lines = [];
    const push = (section, ...cells) => lines.push([section, ...cells].map(csvCell).join(','));

    push('Section', 'Field', 'Value');
    push('Profile', 'Name', fullName(u));
    push('Profile', 'Email', u.email);
    push('Profile', 'Mobile', [u.mobile_country_code, u.mobile_number].filter(Boolean).join(' '));
    push('Profile', 'Country', u.country);
    push('Profile', 'Status', u.status);
    push('Profile', 'Joined', u.created_at);
    push('Profile', 'Last seen', u.last_login_at);

    lines.push('');
    push('Bookings', 'Reference', 'Date', 'Product', 'Type', 'Status', 'Payment', 'Amount', 'Refunded', 'Currency');
    bookings.rows.forEach((b) =>
      push('Booking', b.booking_reference, b.created_at, b.product_title, b.booking_type,
        b.status, b.payment_status, b.payment_amount, b.refund_amount, b.currency)
    );

    lines.push('');
    push('Payments', 'Order', 'Status', 'Amount', 'Currency', 'Reference', 'Date');
    payments.rows.forEach((p) =>
      push('Payment', p.order_reference, p.status, p.amount, p.currency, p.gateway_reference, p.created_at)
    );

    lines.push('');
    push('Emails', 'Kind', 'Status', 'Sent at');
    emails.rows.forEach((e) => push('Email', e.kind, e.status, e.sent_at));

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.customer.export',
      entityType: 'user',
      entityId: u.id,
      summary: `Exported the full record for ${u.email}`,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customer-${u.id}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (err) {
    console.error('customer export error:', err);
    sendError(res, err, 'Failed to export this customer', 500);
  }
});

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

module.exports = router;
