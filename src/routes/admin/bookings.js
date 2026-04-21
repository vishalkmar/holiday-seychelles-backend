const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Get all bookings with filters
router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const requestedLimit = parseInt(req.query.limit || '50', 10);
    const limit = Math.min(Math.max(requestedLimit, 1), 100);
    const status = req.query.status || '';
    const booking_type = req.query.booking_type || '';
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    let query = `SELECT b.id, b.booking_reference, b.booking_type, b.status, b.payment_status,
                        b.payment_gateway, b.payment_reference, b.voucher_path, b.voucher_generated_at,
                        b.lead_first_name, b.lead_last_name, b.lead_email, b.lead_mobile,
                        b.product_title, b.product_code, b.payment_amount, b.currency, b.travel_date,
                        b.check_in_date, b.check_out_date, b.total_travellers, b.total_adults, b.total_children,
                        b.admin_notes, b.details,
                        b.user_id, u.email as user_email,
                        b.created_at, b.updated_at
                 FROM bookings b
                 LEFT JOIN users u ON b.user_id = u.id`;
    let countQuery = `SELECT COUNT(*) as total FROM bookings b
                      LEFT JOIN users u ON b.user_id = u.id`;
    const params = [];
    const conditions = [];

    if (status) {
      conditions.push(`b.status = $${params.length + 1}`);
      params.push(status);
    }

    if (booking_type) {
      conditions.push(`b.booking_type = $${params.length + 1}`);
      params.push(booking_type);
    }

    if (search) {
      conditions.push(`(b.booking_reference ILIKE $${params.length + 1} OR b.lead_email ILIKE $${params.length + 1} OR b.lead_first_name ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }

    if (conditions.length > 0) {
      const whereClause = ' WHERE ' + conditions.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    query += ` ORDER BY b.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const { rows } = await pool.query(query, [...params, limit, offset]);

    const { rows: countRows } = await pool.query(countQuery, params);

    sendSuccess(
      res,
      { bookings: rows, total: parseInt(countRows[0].total), page, limit },
      'Bookings retrieved successfully'
    );
  } catch (err) {
    console.error('get bookings error:', err);
    sendError(res, err, 'Failed to get bookings', 500);
  }
});

// Get booking detail with user info
router.get('/:bookingId', adminAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;

    const { rows: bookingRows } = await pool.query(
      `SELECT b.*, u.email as user_email, u.first_middle_name, u.last_name, u.mobile_number, u.nationality
       FROM bookings b
       LEFT JOIN users u ON b.user_id = u.id
       WHERE b.id = $1`,
      [bookingId]
    );

    if (bookingRows.length === 0) {
      return sendError(res, null, 'Booking not found', 404);
    }

    const booking = bookingRows[0];

    // Get all user bookings for context
    const { rows: userBookings } = booking.user_id
      ? await pool.query(
          'SELECT id, booking_reference, status, created_at FROM bookings WHERE user_id = $1 ORDER BY created_at DESC',
          [booking.user_id]
        )
      : { rows: [] };

    sendSuccess(
      res,
      { booking, userBookings },
      'Booking retrieved successfully'
    );
  } catch (err) {
    console.error('get booking detail error:', err);
    sendError(res, err, 'Failed to get booking details', 500);
  }
});

// Update booking status and admin notes
router.patch('/:bookingId', adminAuth, 
  body('status').optional().isIn(['confirmed', 'cancelled', 'refunded', 'pending']),
  body('admin_notes').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', errors: errors.array() });
    }

    try {
      const { bookingId } = req.params;
      const { status, admin_notes } = req.body;

      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (status) {
        updates.push(`status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }

      if (admin_notes !== undefined) {
        updates.push(`admin_notes = $${paramIndex}`);
        params.push(admin_notes);
        paramIndex++;
      }

      if (updates.length === 0) {
        return sendError(res, null, 'No fields to update', 400);
      }

      updates.push(`updated_at = NOW()`);
      params.push(bookingId);

      const { rows } = await pool.query(
        `UPDATE bookings SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        params
      );

      if (rows.length === 0) {
        return sendError(res, null, 'Booking not found', 404);
      }

      sendSuccess(res, rows[0], 'Booking updated successfully');
    } catch (err) {
      console.error('update booking error:', err);
      sendError(res, err, 'Failed to update booking', 500);
    }
  }
);

// Generate voucher PDF
router.post('/:bookingId/voucher', adminAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;

    const { rows } = await pool.query(
      'SELECT * FROM bookings WHERE id = $1',
      [bookingId]
    );

    if (rows.length === 0) {
      return sendError(res, null, 'Booking not found', 404);
    }

    const booking = rows[0];

    // Create voucher PDF
    const doc = new PDFDocument();
    const uploadsDir = path.join(__dirname, '../../..', process.env.UPLOAD_DIR || 'uploads');
    const voucherFilename = `voucher-${booking.booking_reference}.pdf`;
    const voucherPath = path.join(uploadsDir, voucherFilename);

    // Create uploads dir if not exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const stream = fs.createWriteStream(voucherPath);
    doc.pipe(stream);

    // Add content
    doc.fontSize(20).text('Holiday Seychelles', { align: 'center' });
    doc.fontSize(16).text('Booking Voucher', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12);
    doc.text(`Booking Reference: ${booking.booking_reference}`, { underline: true });
    doc.text(`Name: ${booking.lead_first_name} ${booking.lead_last_name}`);
    doc.text(`Email: ${booking.lead_email}`);
    doc.text(`Mobile: ${booking.lead_mobile}`);
    doc.moveDown();

    doc.text(`Product: ${booking.product_title}`);
    doc.text(`Type: ${booking.booking_type}`);
    doc.text(`Total Amount: ${booking.currency} ${booking.payment_amount}`);
    doc.text(`Status: ${booking.status}`);

    if (booking.travel_date) {
      doc.text(`Travel Date: ${new Date(booking.travel_date).toLocaleDateString()}`);
    }

    doc.moveDown();
    doc.fontSize(10).text('This is an automatically generated voucher. Please keep it safe.', {
      align: 'center',
      italics: true,
    });

    doc.end();

    stream.on('finish', async () => {
      // Update booking with voucher path
      const relativePath = `voucher-${booking.booking_reference}.pdf`;
      await pool.query(
        'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
        [relativePath, bookingId]
      );

      sendSuccess(res, { voucherPath: relativePath }, 'Voucher generated successfully');
    });

    stream.on('error', (err) => {
      console.error('Voucher generation error:', err);
      sendError(res, err, 'Failed to generate voucher', 500);
    });
  } catch (err) {
    console.error('voucher endpoint error:', err);
    sendError(res, err, 'Failed to generate voucher', 500);
  }
});

module.exports = router;
