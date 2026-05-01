const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

/**
 * Generate a voucher PDF for a booking and write it to disk.
 * Returns { absolutePath, relativePath } once the file is fully written.
 */
function generateVoucherPDF(booking) {
  return new Promise((resolve, reject) => {
    try {
      const uploadsDir = path.join(__dirname, '../..', process.env.UPLOAD_DIR || 'uploads');
      const voucherFilename = `voucher-${booking.booking_reference}.pdf`;
      const voucherPath = path.join(uploadsDir, voucherFilename);

      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const stream = fs.createWriteStream(voucherPath);
      doc.pipe(stream);

      // ── Header band ────────────────────────────────────────────────────
      doc.rect(0, 0, doc.page.width, 110).fill('#1d4ed8');
      doc.fillColor('#ffffff')
        .fontSize(24).font('Helvetica-Bold')
        .text('Holiday Seychelles', 50, 35);
      doc.fontSize(12).font('Helvetica')
        .text('Booking Voucher / Confirmation', 50, 68);
      doc.fontSize(10)
        .text(`Reference: ${booking.booking_reference}`, 50, 86);
      doc.moveDown(4);

      doc.fillColor('#0f172a');
      let cursor = 140;

      // ── Section helper ─────────────────────────────────────────────────
      const heading = (label) => {
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#1d4ed8')
          .text(label.toUpperCase(), 50, cursor);
        cursor += 16;
        doc.moveTo(50, cursor).lineTo(545, cursor).strokeColor('#dbeafe').lineWidth(1).stroke();
        cursor += 8;
      };
      const row = (label, value) => {
        doc.fontSize(10).font('Helvetica').fillColor('#64748b')
          .text(label, 50, cursor, { width: 160 });
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#0f172a')
          .text(value || '—', 220, cursor, { width: 325 });
        cursor += 18;
      };

      // ── Lead Guest ─────────────────────────────────────────────────────
      heading('Lead Guest');
      row('Name', `${booking.lead_first_name || ''} ${booking.lead_last_name || ''}`.trim());
      row('Email', booking.lead_email);
      row('Mobile', booking.lead_mobile);
      cursor += 8;

      // ── Booking Details ────────────────────────────────────────────────
      heading('Booking Details');
      row('Product', booking.product_title);
      row('Type', String(booking.booking_type || '').toUpperCase());
      if (booking.product_code) row('Product Code', booking.product_code);
      if (booking.travel_date) row('Travel Date', new Date(booking.travel_date).toLocaleDateString());
      if (booking.check_in_date) row('Check-in', new Date(booking.check_in_date).toLocaleDateString());
      if (booking.check_out_date) row('Check-out', new Date(booking.check_out_date).toLocaleDateString());
      if (booking.total_travellers) row('Travellers', `${booking.total_travellers} (${booking.total_adults || 0} adults · ${booking.total_children || 0} children)`);
      cursor += 8;

      // ── Payment ────────────────────────────────────────────────────────
      heading('Payment');
      row('Total Paid', `${booking.currency || 'INR'} ${Number(booking.payment_amount || 0).toFixed(2)}`);
      row('Status', String(booking.payment_status || 'paid').toUpperCase());
      if (booking.payment_gateway) row('Gateway', booking.payment_gateway);
      if (booking.payment_reference) row('Reference', booking.payment_reference);
      cursor += 16;

      // ── Footer ─────────────────────────────────────────────────────────
      doc.fontSize(9).font('Helvetica-Oblique').fillColor('#64748b')
        .text(
          'This is a system-generated voucher. Please keep it safe and present it at check-in. ' +
          'For assistance, contact info@holidayseychelles.com.',
          50, cursor, { width: 495, align: 'center' }
        );

      doc.end();

      stream.on('finish', () => {
        resolve({
          absolutePath: voucherPath,
          relativePath: voucherFilename,
        });
      });
      stream.on('error', (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateVoucherPDF };
