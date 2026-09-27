/**
 * Vouchers & documents.
 *
 * Every booking that should have a voucher, whether it actually has one on
 * disk, when it was last emailed and to whom — plus the invoice that belongs
 * with it.
 *
 * The rule this screen exists to enforce: a voucher row in the database is a
 * claim, and the file on disk is the fact. They drift (a deploy wipes uploads,
 * a file is deleted), so every read checks the disk and every download
 * regenerates rather than 404s. A guest at a jetty needs the document, not an
 * explanation of why it is missing.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const { runLimited } = require('../../utils/concurrency');
const { generateVoucherPDF } = require('../../utils/voucher');
const { generateInvoicePDF, invoiceNumber } = require('../../utils/invoice');
const { sendVoucherEmail } = require('../../utils/mailer');
const { logEmail } = require('../../services/emailTemplates');
const docSettings = require('../../services/documentSettings');

const router = express.Router();
const num = (v) => Number(v || 0);

function invalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, null, errors.array()[0].msg, 400);
  return true;
}

function uploadsDir() {
  return path.join(__dirname, '../../..', process.env.UPLOAD_DIR || 'uploads');
}

/** basename, always — a stored filename is the only thing between the DB and this disk. */
function voucherFileFor(booking) {
  if (!booking.voucher_path) return null;
  return path.join(uploadsDir(), path.basename(booking.voucher_path));
}

async function loadBooking(id) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Get a voucher file, making one if it is not there.
 *
 * This is 13.8. A row can say a voucher exists while the file does not, and the
 * only useful response to that is to rebuild it from the booking — the data has
 * not gone anywhere.
 */
async function ensureVoucherFile(booking, settings) {
  const existing = voucherFileFor(booking);
  if (existing && fs.existsSync(existing)) {
    return { absolutePath: existing, regenerated: false };
  }

  const generated = await generateVoucherPDF(booking, { settings });
  await pool.query(
    'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
    [generated.relativePath, booking.id]
  );
  return { absolutePath: generated.absolutePath, regenerated: true };
}

// ── List ─────────────────────────────────────────────────────────────────────

router.get('/vouchers', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
    const offset = (page - 1) * limit;

    const conditions = ["b.payment_status = 'paid'"];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    if (req.query.status) add('b.status = ?', req.query.status);
    if (req.query.type) add('b.booking_type = ?', req.query.type);
    if (req.query.from) add('b.created_at >= ?', `${req.query.from} 00:00:00`);
    if (req.query.to) add('b.created_at <= ?', `${req.query.to} 23:59:59`);
    if (req.query.generated === 'yes') conditions.push('b.voucher_path IS NOT NULL');
    if (req.query.generated === 'no') conditions.push('b.voucher_path IS NULL');
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const p = `$${params.length}`;
      conditions.push(
        `(b.booking_reference LIKE ${p} OR b.lead_email LIKE ${p} OR b.product_title LIKE ${p}
          OR b.lead_first_name LIKE ${p} OR b.lead_last_name LIKE ${p})`
      );
    }
    const where = ` WHERE ${conditions.join(' AND ')}`;

    // The email trail comes from email_notifications, which is where every send
    // in this system is recorded - see Module 10.
    const source = `
      FROM bookings b
      LEFT JOIN (
        SELECT booking_id,
               COUNT(*) AS email_count,
               MAX(sent_at) AS last_emailed_at,
               SUBSTRING_INDEX(MAX(CONCAT(sent_at, CHAR(1), recipient)), CHAR(1), -1) AS last_emailed_to,
               SUBSTRING_INDEX(MAX(CONCAT(sent_at, CHAR(1), status)), CHAR(1), -1) AS last_email_status
          FROM email_notifications
         WHERE kind = 'voucher' AND booking_id IS NOT NULL
         GROUP BY booking_id
      ) e ON e.booking_id = b.id
      ${where}`;

    const SORTS = {
      newest: 'b.created_at DESC',
      oldest: 'b.created_at ASC',
      travel: 'COALESCE(b.check_in_date, b.travel_date) ASC',
      amount: 'b.payment_amount DESC',
    };
    const order = SORTS[req.query.sort] || SORTS.newest;

    const [rows, total, stats] = await runLimited([
      () =>
        pool.query(
          `SELECT b.id, b.booking_reference, b.product_title, b.booking_type, b.status,
                  b.payment_amount, b.currency, b.check_in_date, b.check_out_date,
                  b.travel_date, b.lead_first_name, b.lead_last_name, b.lead_email,
                  b.voucher_path, b.voucher_generated_at, b.created_at,
                  COALESCE(e.email_count, 0) AS email_count,
                  e.last_emailed_at, e.last_emailed_to, e.last_email_status
           ${source}
           ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
      () => pool.query(`SELECT COUNT(*) AS total ${source}`, params),
      () =>
        pool.query(
          // `generated` is a reserved word in MySQL 8 (GENERATED), so the
          // alias is not it - same trap as `lead` in the analytics queries.
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN b.voucher_path IS NOT NULL THEN 1 ELSE 0 END) AS generated_count,
                  SUM(CASE WHEN b.voucher_path IS NULL THEN 1 ELSE 0 END) AS missing_count,
                  SUM(CASE WHEN e.email_count > 0 THEN 1 ELSE 0 END) AS emailed_count
           ${source}`,
          params
        ),
    ]);

    // Whether the file is really there is a disk question, not a database one.
    const withFiles = rows.rows.map((b) => {
      const file = voucherFileFor(b);
      let fileStats = null;
      try { if (file) fileStats = fs.statSync(file); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      return {
        ...b,
        email_count: num(b.email_count),
        guest: [b.lead_first_name, b.lead_last_name].filter(Boolean).join(' ') || b.lead_email,
        invoice_number: invoiceNumber(b, 'INV'),
        fileOnDisk: Boolean(fileStats?.isFile()),
        sizeBytes: fileStats?.isFile() ? fileStats.size : null,
      };
    });

    const s = stats.rows[0] || {};
    const totalCount = num(total.rows[0]?.total);

    sendSuccess(
      res,
      {
        vouchers: withFiles,
        total: totalCount,
        page,
        limit,
        pages: Math.max(1, Math.ceil(totalCount / limit)),
        stats: {
          total: num(s.total),
          generated: num(s.generated_count),
          missing: num(s.missing_count),
          emailed: num(s.emailed_count),
          filesMissing: withFiles.filter((v) => v.voucher_path && !v.fileOnDisk).length,
        },
        note: 'Only paid bookings appear here — an unpaid booking has nothing to voucher. A missing file is rebuilt from the booking on download, so it is never a dead end.',
      },
      'Vouchers retrieved'
    );
  } catch (err) {
    console.error('voucher list error:', err);
    sendError(res, err, 'Failed to load the vouchers', 500);
  }
});

// ── Settings ─────────────────────────────────────────────────────────────────

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 6) || '.png';
      cb(null, `doc-logo-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // PDFKit can place PNG and JPEG. Anything else silently fails to draw.
    if (!/^image\/(png|jpe?g)$/.test(file.mimetype || '')) {
      cb(new Error('The logo must be a PNG or JPEG'));
      return;
    }
    cb(null, true);
  },
});

router.get('/settings', adminAuth, async (req, res) => {
  try {
    const settings = await docSettings.getSettings();
    sendSuccess(
      res,
      {
        settings,
        defaults: docSettings.DEFAULTS,
        note: 'The layout of a voucher is fixed in code. Only the wording, the colour and the logo are settings, so an edit here can never produce a document that fails to generate.',
      },
      'Document settings retrieved'
    );
  } catch (err) {
    console.error('doc settings error:', err);
    sendError(res, err, 'Failed to load the document settings', 500);
  }
});

router.put('/settings', adminAuth, async (req, res) => {
  try {
    const result = await docSettings.saveSettings(req.body, req.admin.id);
    if (result.error) return sendError(res, null, result.error, 400);

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.documents.settings_updated',
      entityType: 'settings',
      summary: 'Updated the voucher and invoice template settings',
    });

    sendSuccess(res, { settings: result.settings }, 'Document settings saved');
  } catch (err) {
    console.error('doc settings save error:', err);
    sendError(res, err, 'Failed to save the document settings', 500);
  }
});

router.post('/settings/reset', adminAuth, async (req, res) => {
  try {
    const settings = await docSettings.resetSettings(req.admin.id);
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.documents.settings_reset',
      entityType: 'settings',
      summary: 'Reset the voucher and invoice settings to the defaults',
    });
    sendSuccess(res, { settings }, 'Settings reset to the defaults');
  } catch (err) {
    console.error('doc settings reset error:', err);
    sendError(res, err, 'Failed to reset the settings', 500);
  }
});

router.post('/settings/logo', adminAuth, logoUpload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return sendError(res, null, 'Choose a PNG or JPEG file', 400);

    const result = await docSettings.saveSettings({ logoFilename: req.file.filename }, req.admin.id);
    if (result.error) return sendError(res, null, result.error, 400);

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.documents.logo_changed',
      entityType: 'settings',
      summary: `Voucher logo replaced (${req.file.originalname})`,
    });

    sendSuccess(
      res,
      { logoFilename: req.file.filename, url: `/uploads/${req.file.filename}`, settings: result.settings },
      'Logo updated'
    );
  } catch (err) {
    console.error('logo upload error:', err);
    sendError(res, err, 'Failed to upload the logo', 500);
  }
});

/**
 * A sample voucher, drawn from a made-up booking.
 *
 * Deliberately obvious placeholder data rather than a real booking — a preview
 * that looks like a genuine reservation invites somebody to treat it as one.
 */
router.get('/settings/preview', adminAuth, async (req, res) => {
  try {
    const settings = await docSettings.getRenderSettings();
    const sample = {
      id: 0,
      booking_reference: 'BS-SAMPLE-0001',
      product_title: 'Sample Villa — Room STANDARD',
      booking_type: 'hotel',
      status: 'confirmed',
      payment_status: 'paid',
      payment_amount: '150.00',
      currency: 'EUR',
      check_in_date: '2026-10-10',
      check_out_date: '2026-10-13',
      total_travellers: 2,
      total_adults: 2,
      total_children: 0,
      lead_first_name: 'Alex',
      lead_last_name: 'Traveller',
      lead_email: 'alex@example.com',
      supplier_reference: 'TV-SAMPLE',
      payment_reference: 'SAMPLE-TXN-0001',
      payment_gateway: 'cybersource',
      created_at: new Date(),
      details: {},
    };

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="voucher-preview.pdf"');
    doc.pipe(res);

    if (req.query.document === 'invoice') {
      await generateInvoicePDF(sample, { doc, settings });
    } else {
      await generateVoucherPDF(sample, { doc, settings });
    }
    doc.end();
  } catch (err) {
    console.error('preview error:', err);
    if (!res.headersSent) sendError(res, err, 'Failed to render the preview', 500);
  }
});

// ── One booking's documents ──────────────────────────────────────────────────

router.get('/vouchers/:bookingId', adminAuth, async (req, res) => {
  try {
    const booking = await loadBooking(req.params.bookingId);
    if (!booking) return sendError(res, null, 'Booking not found', 404);

    const { rows: emails } = await pool.query(
      `SELECT id, recipient, status, error, sent_at FROM email_notifications
        WHERE booking_id = $1 AND kind = 'voucher' ORDER BY sent_at DESC`,
      [booking.id]
    );

    const file = voucherFileFor(booking);
    const onDisk = Boolean(file && fs.existsSync(file));

    sendSuccess(
      res,
      {
        booking: {
          id: booking.id,
          reference: booking.booking_reference,
          product: booking.product_title,
          type: booking.booking_type,
          status: booking.status,
          amount: booking.payment_amount,
          currency: booking.currency,
          checkIn: booking.check_in_date,
          checkOut: booking.check_out_date,
          guest: [booking.lead_first_name, booking.lead_last_name].filter(Boolean).join(' '),
          email: booking.lead_email,
          travellers: booking.total_travellers,
        },
        voucher: {
          generatedAt: booking.voucher_generated_at,
          recordedPath: booking.voucher_path,
          fileOnDisk: onDisk,
          sizeBytes: onDisk ? fs.statSync(file).size : null,
        },
        invoice: { number: `INV-${booking.booking_reference}` },
        emails,
        note: onDisk
          ? null
          : booking.voucher_path
            ? 'The database says this voucher exists but the file is not on disk. Downloading it will rebuild it from the booking.'
            : 'No voucher has been generated yet. Downloading or emailing will create one.',
      },
      'Document record retrieved'
    );
  } catch (err) {
    console.error('voucher detail error:', err);
    sendError(res, err, 'Failed to load this document record', 500);
  }
});

/** Download or view the voucher. Regenerates silently if the file has gone. */
router.get('/vouchers/:bookingId/download', adminAuth, async (req, res) => {
  try {
    const booking = await loadBooking(req.params.bookingId);
    if (!booking) return sendError(res, null, 'Booking not found', 404);

    const settings = await docSettings.getRenderSettings();
    const { absolutePath, regenerated } = await ensureVoucherFile(booking, settings);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Voucher-Regenerated', regenerated ? 'true' : 'false');
    res.setHeader(
      'Content-Disposition',
      `${req.query.inline === 'true' ? 'inline' : 'attachment'}; filename="voucher-${booking.booking_reference}.pdf"`
    );
    fs.createReadStream(absolutePath).pipe(res);
  } catch (err) {
    console.error('voucher download error:', err);
    if (!res.headersSent) sendError(res, err, 'Failed to produce this voucher', 500);
  }
});

/** The invoice is always generated fresh — it is derived entirely from the booking. */
router.get('/vouchers/:bookingId/invoice', adminAuth, async (req, res) => {
  try {
    const booking = await loadBooking(req.params.bookingId);
    if (!booking) return sendError(res, null, 'Booking not found', 404);
    if (booking.payment_status !== 'paid') {
      return sendError(res, null, 'An invoice records a payment — this booking has not been paid', 409);
    }

    const settings = await docSettings.getRenderSettings();
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${req.query.inline === 'true' ? 'inline' : 'attachment'}; filename="invoice-${booking.booking_reference}.pdf"`
    );
    doc.pipe(res);
    await generateInvoicePDF(booking, { doc, settings });
    doc.end();
  } catch (err) {
    console.error('invoice error:', err);
    if (!res.headersSent) sendError(res, err, 'Failed to produce this invoice', 500);
  }
});

/** Regenerate from the current booking data and the current settings. */
router.post('/vouchers/:bookingId/regenerate', adminAuth, async (req, res) => {
  try {
    const booking = await loadBooking(req.params.bookingId);
    if (!booking) return sendError(res, null, 'Booking not found', 404);

    const settings = await docSettings.getRenderSettings();
    const generated = await generateVoucherPDF(booking, { settings });
    await pool.query(
      'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
      [generated.relativePath, booking.id]
    );

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.documents.voucher_regenerated',
      entityType: 'booking',
      entityId: booking.id,
      summary: `Regenerated the voucher for ${booking.booking_reference}`,
    });

    sendSuccess(
      res,
      { reference: booking.booking_reference, generatedAt: new Date() },
      'Voucher regenerated from the current booking data'
    );
  } catch (err) {
    console.error('regenerate error:', err);
    sendError(res, err, 'Failed to regenerate this voucher', 500);
  }
});

/** Email the voucher, and record the send like every other email. */
router.post(
  '/vouchers/:bookingId/email',
  adminAuth,
  body('to').optional().trim().isEmail().withMessage('That is not a valid email address'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const booking = await loadBooking(req.params.bookingId);
      if (!booking) return sendError(res, null, 'Booking not found', 404);

      const recipient = req.body.to || booking.lead_email;
      if (!recipient) {
        return sendError(res, null, 'This booking has no email address on it', 400);
      }

      const settings = await docSettings.getRenderSettings();
      const { absolutePath } = await ensureVoucherFile(booking, settings);

      const result = await sendVoucherEmail({ ...booking, lead_email: recipient }, absolutePath);

      // No dedupe key: this is a deliberate resend, and the log should show
      // every one of them rather than silently swallowing the second.
      await logEmail({
        kind: 'voucher',
        bookingId: booking.id,
        recipient,
        subject: `Your booking is confirmed · ${booking.booking_reference}`,
        result: result || { success: false, error: 'No result from the mailer' },
      });

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.documents.voucher_emailed',
        entityType: 'booking',
        entityId: booking.id,
        summary: `Emailed the voucher for ${booking.booking_reference} to ${recipient}`,
        status: result?.success ? 'success' : 'failed',
      });

      if (!result?.success) {
        return sendError(res, null, `Could not send: ${result?.error || 'unknown error'}`, 502);
      }
      sendSuccess(res, { sentTo: recipient }, 'Voucher emailed');
    } catch (err) {
      console.error('voucher email error:', err);
      sendError(res, err, 'Failed to email this voucher', 500);
    }
  }
);

// ── Bulk pack ────────────────────────────────────────────────────────────────

/**
 * Every voucher in a date range, as one printable PDF.
 *
 * A single multi-page document rather than a zip: this project has no archiving
 * dependency, and for the actual use — printing tomorrow's arrivals — one file
 * that goes straight to a printer beats a folder of separate ones.
 */
router.get('/vouchers/bulk/pack', adminAuth, async (req, res) => {
  try {
    const conditions = ["b.payment_status = 'paid'", "b.status NOT IN ('cancelled', 'refunded')"];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    const field = req.query.by === 'travel' ? 'COALESCE(b.check_in_date, b.travel_date)' : 'b.created_at';
    if (req.query.from) add(`${field} >= ?`, req.query.from);
    if (req.query.to) add(`${field} <= ?`, `${req.query.to} 23:59:59`);
    if (req.query.type) add('b.booking_type = ?', req.query.type);

    const { rows } = await pool.query(
      `SELECT b.* FROM bookings b WHERE ${conditions.join(' AND ')}
        ORDER BY ${field} ASC, b.id ASC LIMIT 200`,
      params
    );

    if (!rows.length) {
      return sendError(res, null, 'No paid bookings in that range', 404);
    }

    const settings = await docSettings.getRenderSettings();
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="vouchers-${req.query.from || 'all'}-to-${req.query.to || 'now'}.pdf"`
    );
    doc.pipe(res);

    // Sequential on purpose: each voucher draws into the same document, so they
    // cannot be produced in parallel without interleaving the pages.
    for (let i = 0; i < rows.length; i += 1) {
      await generateVoucherPDF(rows[i], { doc, settings, addPage: i > 0 });
    }

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.documents.bulk_pack',
      entityType: 'booking',
      summary: `Downloaded a pack of ${rows.length} voucher(s)`,
      metadata: { from: req.query.from, to: req.query.to, count: rows.length },
    });

    doc.end();
  } catch (err) {
    console.error('bulk pack error:', err);
    if (!res.headersSent) sendError(res, err, 'Failed to build the voucher pack', 500);
  }
});

/** How many vouchers a range would produce, before committing to the download. */
router.get('/vouchers/bulk/count', adminAuth, async (req, res) => {
  try {
    const conditions = ["payment_status = 'paid'", "status NOT IN ('cancelled', 'refunded')"];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    const field = req.query.by === 'travel' ? 'COALESCE(check_in_date, travel_date)' : 'created_at';
    if (req.query.from) add(`${field} >= ?`, req.query.from);
    if (req.query.to) add(`${field} <= ?`, `${req.query.to} 23:59:59`);
    if (req.query.type) add('booking_type = ?', req.query.type);

    const { rows } = await pool.query(
      `SELECT COUNT(*) AS total FROM bookings WHERE ${conditions.join(' AND ')}`,
      params
    );

    const total = num(rows[0]?.total);
    sendSuccess(
      res,
      {
        count: Math.min(total, 200),
        total,
        capped: total > 200,
        note: total > 200 ? 'Only the first 200 are included in one pack — narrow the range.' : null,
      },
      'Range counted'
    );
  } catch (err) {
    console.error('bulk count error:', err);
    sendError(res, err, 'Failed to count that range', 500);
  }
});

/** Upload rejections as JSON rather than Express's HTML error page. */
router.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, null, 'The logo must be 2MB or smaller', 413);
  }
  if (/PNG or JPEG/.test(err.message || '')) {
    return sendError(res, null, err.message, 415);
  }
  console.error('documents route error:', err);
  return sendError(res, err, 'Something went wrong handling that request', 500);
});

module.exports = router;
