/**
 * Invoice PDF.
 *
 * A voucher proves the booking to a supplier; an invoice proves the payment to
 * an accountant. They are separate documents because they answer to different
 * people and only one of them belongs in a bookkeeping file.
 *
 * Two deliberate absences:
 *
 *  - **No tax breakdown.** No VAT or GST rate is recorded anywhere in this
 *    system, so any split into net and tax would be invented. The invoice shows
 *    the amount actually charged and carries whatever tax note the business
 *    configures.
 *  - **No invoice sequence table.** The number is derived from the booking
 *    (`INV-<reference>`), so re-issuing an invoice produces the same number
 *    rather than a new one — a regenerated document must not look like a second
 *    sale.
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const INK = '#0F172A';
const MUTED = '#64748B';
const LINE = '#D7E3F4';
const PAGE_MARGIN = 50;
const CONTENT_RIGHT = 545;
const PAGE_BOTTOM = 780;

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function fmtDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function money(amount, currency) {
  return `${currency || 'EUR'} ${Number(amount || 0).toFixed(2)}`;
}

function invoiceNumber(booking, prefix = 'INV') {
  return `${prefix}-${booking.booking_reference}`;
}

/**
 * Draw one invoice.
 *
 * Same contract as the voucher generator: with `options.doc` it draws into a
 * document the caller owns and does not end it.
 */
function generateInvoicePDF(booking, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const settings = options.settings || {};
      const brand = /^#[0-9a-fA-F]{6}$/.test(settings.brandColor || '')
        ? settings.brandColor
        : '#2563EB';
      const logoPath = settings.logoPath;

      const uploadsDir = path.join(__dirname, '../..', process.env.UPLOAD_DIR || 'uploads');
      const filename = `invoice-${booking.booking_reference}.pdf`;
      const filePath = path.join(uploadsDir, filename);
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const details = asObject(booking.details);
      const gateway = asObject(details.gateway_response);
      const contact = asObject(details.contact);

      const shared = Boolean(options.doc);
      const doc = options.doc || new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
      let stream = null;
      if (shared) {
        if (options.addPage) doc.addPage();
      } else {
        stream = fs.createWriteStream(filePath);
        doc.pipe(stream);
      }

      let cursor = PAGE_MARGIN;

      const ensure = (needed) => {
        if (cursor + needed > PAGE_BOTTOM) {
          doc.addPage();
          cursor = PAGE_MARGIN;
        }
      };

      const heading = (label) => {
        ensure(40);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(brand)
          .text(label.toUpperCase(), PAGE_MARGIN, cursor, { characterSpacing: 0.6 });
        cursor += 13;
        doc.moveTo(PAGE_MARGIN, cursor).lineTo(CONTENT_RIGHT, cursor)
          .strokeColor(LINE).lineWidth(1).stroke();
        cursor += 7;
      };

      const row = (label, value, bold = false) => {
        if (value === null || value === undefined || value === '') return;
        const text = String(value);
        const valueWidth = CONTENT_RIGHT - 215;
        const height = Math.max(
          doc.font('Helvetica-Bold').fontSize(9.5).heightOfString(text, { width: valueWidth }),
          13
        );
        ensure(height + 6);
        doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
          .text(label, PAGE_MARGIN, cursor, { width: 155 });
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica-Bold').fontSize(bold ? 11 : 9.5)
          .fillColor(bold ? brand : INK)
          .text(text, 215, cursor, { width: valueWidth });
        cursor += height + 3;
      };

      // ── Header ──────────────────────────────────────────────────────────
      let textLeft = PAGE_MARGIN;
      try {
        if (logoPath && fs.existsSync(logoPath)) {
          doc.image(logoPath, PAGE_MARGIN, cursor, { fit: [60, 60] });
          textLeft = PAGE_MARGIN + 74;
        }
      } catch {
        /* an invoice without a logo is still a valid invoice */
      }

      doc.font('Helvetica-Bold').fontSize(19).fillColor(INK)
        .text(settings.companyName || 'Holiday Seychelles', textLeft, cursor + 2);
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      let sub = cursor + 26;
      for (const line of [settings.companyAddress, settings.companyEmail, settings.companyPhone]) {
        if (!line) continue;
        doc.text(String(line), textLeft, sub, { width: 300 });
        sub += 12;
      }

      doc.font('Helvetica-Bold').fontSize(22).fillColor(brand)
        .text('INVOICE', CONTENT_RIGHT - 200, cursor + 2, { width: 200, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor(MUTED)
        .text(invoiceNumber(booking, settings.invoicePrefix), CONTENT_RIGHT - 200, cursor + 30, {
          width: 200,
          align: 'right',
        })
        .text(
          `Issued ${fmtDate(booking.payment_date || booking.created_at) || fmtDate(new Date())}`,
          CONTENT_RIGHT - 200,
          cursor + 43,
          { width: 200, align: 'right' }
        );

      cursor = Math.max(sub, cursor + 70) + 14;
      doc.moveTo(PAGE_MARGIN, cursor).lineTo(CONTENT_RIGHT, cursor)
        .strokeColor(LINE).lineWidth(1).stroke();
      cursor += 16;

      // ── Billed to ───────────────────────────────────────────────────────
      heading('Billed To');
      row(
        'Name',
        [booking.lead_first_name, booking.lead_last_name].filter(Boolean).join(' ') || contact.name
      );
      row('Email', booking.lead_email || contact.email);
      row('Phone', booking.lead_mobile || contact.phone);
      cursor += 7;

      // ── What was bought ─────────────────────────────────────────────────
      heading('Description');
      row('Item', booking.product_title);
      row('Type', String(booking.booking_type || '').toUpperCase());
      row('Booking Reference', booking.booking_reference);
      row('Check-in', fmtDate(booking.check_in_date));
      row('Check-out', fmtDate(booking.check_out_date));
      if (!booking.check_in_date) row('Travel Date', fmtDate(booking.travel_date));
      row('Guests', booking.total_travellers);
      cursor += 7;

      // ── Money ───────────────────────────────────────────────────────────
      heading('Payment');
      row('Amount charged', money(booking.payment_amount, booking.currency), true);
      if (Number(booking.refund_amount) > 0) {
        row('Refunded', `- ${money(booking.refund_amount, booking.currency)}`);
        row(
          'Net',
          money(Number(booking.payment_amount || 0) - Number(booking.refund_amount || 0), booking.currency),
          true
        );
      }
      row('Status', String(booking.payment_status || '').toUpperCase());
      row('Paid on', fmtDate(booking.payment_date || booking.created_at));
      row('Method', gateway.card_type_name || gateway.payment_method || booking.payment_gateway || 'Card');
      row('Gateway reference', booking.payment_reference || gateway.transaction_id);
      cursor += 10;

      if (settings.taxNote) {
        ensure(30);
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
          .text(settings.taxNote, PAGE_MARGIN, cursor, { width: CONTENT_RIGHT - PAGE_MARGIN });
        cursor += 24;
      }

      // ── Footer ──────────────────────────────────────────────────────────
      ensure(44);
      doc.moveTo(PAGE_MARGIN, cursor).lineTo(CONTENT_RIGHT, cursor)
        .strokeColor(LINE).lineWidth(1).stroke();
      cursor += 12;
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text(
          'This invoice records a payment already taken. It is not a request for payment.',
          PAGE_MARGIN,
          cursor,
          { width: CONTENT_RIGHT - PAGE_MARGIN }
        );

      if (shared) {
        resolve({ absolutePath: null, relativePath: null, drawnInto: true });
        return;
      }

      doc.end();
      stream.on('finish', () => resolve({ absolutePath: filePath, relativePath: filename }));
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateInvoicePDF, invoiceNumber };
