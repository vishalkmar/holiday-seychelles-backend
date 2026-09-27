const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

/**
 * Booking voucher PDF.
 *
 * Everything the guest needs to prove the booking and everything finance needs
 * to trace the money: what was booked and in which configuration, who booked
 * it, and the full payment trail (order reference, gateway transaction id,
 * method, status).
 *
 * The booking's `details` JSON carries the parts that don't have their own
 * columns - travellers, the contact who filled the form, the supplier offer and
 * the raw gateway response. MySQL hands JSON back as a string sometimes, so it
 * is parsed defensively.
 */

const BRAND = '#2563EB';
const INK = '#0F172A';
const MUTED = '#64748B';
const LINE = '#D7E3F4';
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');

const PAGE_MARGIN = 50;
const CONTENT_RIGHT = 545;
const PAGE_BOTTOM = 780;

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value) || {};
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

function fmtDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return `${fmtDate(d)} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function money(amount, currency) {
  return `${currency || 'EUR'} ${Number(amount || 0).toFixed(2)}`;
}

/** Human label for how the customer paid, from the gateway's echoed fields. */
function paymentMethod(gatewayResponse, booking) {
  const cardType = {
    '001': 'Visa',
    '002': 'Mastercard',
    '003': 'American Express',
    '004': 'Discover',
    '005': 'Diners Club',
    '007': 'JCB',
  }[gatewayResponse.req_card_type];

  const masked = gatewayResponse.req_card_number || gatewayResponse.card_number;
  if (cardType && masked) return `${cardType} ending ${String(masked).slice(-4)}`;
  if (cardType) return `${cardType} card`;
  if (masked) return `Card ending ${String(masked).slice(-4)}`;
  if (gatewayResponse.payment_method) return String(gatewayResponse.payment_method);
  return booking.payment_gateway ? 'Card' : null;
}

/**
 * Draw one voucher.
 *
 * Two callers, one drawing routine:
 *
 *  - on its own, it creates a document and writes `voucher-REF.pdf`;
 *  - with `options.doc`, it draws into a document the caller owns and neither
 *    creates nor ends it — which is how the bulk pack puts many vouchers in one
 *    printable PDF without needing a PDF-merging dependency.
 *
 * `options.settings` carries the admin-editable bits (brand colour, footer,
 * extra terms). Anything missing falls back to the built-in defaults, so a
 * blank settings row can never produce a blank voucher.
 */
function generateVoucherPDF(booking, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const uploadsDir = path.join(__dirname, '../..', process.env.UPLOAD_DIR || 'uploads');
      const voucherFilename = `voucher-${booking.booking_reference}.pdf`;
      const voucherPath = path.join(uploadsDir, voucherFilename);

      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const details = asObject(booking.details);
      const gatewayResponse = asObject(details.gateway_response);
      const travellers = Array.isArray(details.travellers) ? details.travellers : [];
      const contact = asObject(details.contact);
      const policies = Array.isArray(details.cancellationPolicies) ? details.cancellationPolicies : [];

      const settings = options.settings || {};
      const brand = /^#[0-9a-fA-F]{6}$/.test(settings.brandColor || '') ? settings.brandColor : BRAND;
      const logoPath = settings.logoPath || LOGO_PATH;

      const shared = Boolean(options.doc);
      const doc = options.doc || new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
      let stream = null;
      if (shared) {
        // The caller decides where page breaks go between vouchers.
        if (options.addPage) doc.addPage();
      } else {
        stream = fs.createWriteStream(voucherPath);
        doc.pipe(stream);
      }

      let cursor = 0;

      // ── Header ───────────────────────────────────────────────────────────
      const drawHeader = () => {
        doc.rect(0, 0, doc.page.width, 118).fill(brand);

        // The logo is optional - a missing file must not break the voucher.
        let textLeft = PAGE_MARGIN;
        try {
          if (fs.existsSync(logoPath)) {
            doc.image(logoPath, PAGE_MARGIN, 26, { fit: [66, 66], align: 'left' });
            textLeft = PAGE_MARGIN + 80;
          }
        } catch {
          /* keep going without the logo */
        }

        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(21)
          .text('Holiday Seychelles', textLeft, 32);
        doc.font('Helvetica').fontSize(11)
          .text(options.documentTitle || settings.documentTitle || 'Booking Voucher & Payment Receipt', textLeft, 58);
        doc.font('Helvetica-Bold').fontSize(10)
          .text(`Reference  ${booking.booking_reference}`, textLeft, 78);

        // Status pill, right aligned
        const status = String(booking.status || 'confirmed').replace(/_/g, ' ').toUpperCase();
        const pillW = Math.max(doc.widthOfString(status) + 24, 80);
        doc.roundedRect(CONTENT_RIGHT - pillW, 40, pillW, 22, 11).fill('#FFFFFF');
        doc.fillColor(brand).font('Helvetica-Bold').fontSize(9)
          .text(status, CONTENT_RIGHT - pillW, 47, { width: pillW, align: 'center' });

        cursor = 146;
      };

      const newPage = () => {
        doc.addPage();
        cursor = PAGE_MARGIN;
      };

      const ensure = (needed) => {
        if (cursor + needed > PAGE_BOTTOM) newPage();
      };

      const heading = (label) => {
        ensure(46);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(brand)
          .text(label.toUpperCase(), PAGE_MARGIN, cursor, { characterSpacing: 0.6 });
        cursor += 14;
        doc.moveTo(PAGE_MARGIN, cursor).lineTo(CONTENT_RIGHT, cursor)
          .strokeColor(LINE).lineWidth(1).stroke();
        cursor += 7;
      };

      const row = (label, value) => {
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
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
          .text(text, 215, cursor, { width: valueWidth });
        cursor += height + 3;
      };

      const gap = (n = 7) => { cursor += n; };

      drawHeader();

      // ── What was booked ──────────────────────────────────────────────────
      heading('Booking Details');
      row('Item', booking.product_title);
      row('Type', String(booking.booking_type || '').toUpperCase());
      row('Item Code', booking.product_code);
      row('Check-in', fmtDate(booking.check_in_date));
      row('Check-out', fmtDate(booking.check_out_date));
      if (!booking.check_in_date) row('Travel Date', fmtDate(booking.travel_date));
      if (booking.check_in_date && booking.check_out_date) {
        const nights = Math.round(
          (new Date(booking.check_out_date) - new Date(booking.check_in_date)) / 86400000
        );
        if (nights > 0) row('Duration', `${nights} ${nights === 1 ? 'night' : 'nights'}`);
      }
      row(
        'Guests',
        booking.total_travellers
          ? `${booking.total_travellers} total — ${booking.total_adults || 0} adult(s), ${booking.total_children || 0} child(ren)`
          : null
      );
      row('Supplier Reference', booking.supplier_reference);
      row('Booked On', fmtDateTime(booking.created_at));
      gap();

      // ── Selected configuration ───────────────────────────────────────────
      if (details.offerId || details.supplier?.transactionId) {
        heading('Selected Configuration');
        row('Offer Reference', details.offerId);
        row('Supplier Transaction', details.supplier?.transactionId);
        row(
          'Supplier Status',
          booking.supplier_status ? String(booking.supplier_status).replace(/_/g, ' ') : null
        );
        row('Refundable', booking.is_refundable ? 'Yes' : 'Non-refundable');
        if (booking.is_refundable && booking.refund_window_hours != null) {
          row('Free Cancellation Window', `${booking.refund_window_hours} hours from booking`);
        }
        gap();
      }

      // ── Travellers ───────────────────────────────────────────────────────
      heading('Traveller Details');
      if (travellers.length) {
        travellers.forEach((t, i) => {
          const name = [t.title, t.firstName, t.lastName].filter(Boolean).join(' ');
          row(`Traveller ${i + 1}${t.isLeader ? ' (Lead)' : ''}`, name || '—');
        });
      } else {
        row('Lead Guest', `${booking.lead_first_name || ''} ${booking.lead_last_name || ''}`.trim());
      }
      gap();

      // ── Who booked it ────────────────────────────────────────────────────
      heading('Contact Details');
      row(
        'Name',
        [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
          `${booking.lead_first_name || ''} ${booking.lead_last_name || ''}`.trim()
      );
      row('Email', contact.email || booking.lead_email);
      row('Mobile', contact.phone || booking.lead_mobile);
      gap();

      // ── Money trail ──────────────────────────────────────────────────────
      heading('Payment Details');
      row('Amount Paid', money(booking.payment_amount, booking.currency));
      row('Payment Status', String(booking.payment_status || 'paid').toUpperCase());
      row('Payment Method', paymentMethod(gatewayResponse, booking));
      row(
        'Gateway',
        booking.payment_gateway === 'cybersource' ? 'CyberSource' : booking.payment_gateway
      );
      row('Order ID', details.order_reference);
      row('Transaction ID', booking.payment_reference);
      row('Authorisation Code', gatewayResponse.auth_code);
      row('Paid On', fmtDateTime(gatewayResponse.signed_date_time) || fmtDateTime(booking.created_at));
      gap();

      // ── Refund, when it applies ──────────────────────────────────────────
      if (booking.refund_amount) {
        heading('Refund');
        row('Refund Amount', money(booking.refund_amount, booking.refund_currency || booking.currency));
        row('Refund Reference', booking.refund_reference);
        row('Refunded On', fmtDateTime(booking.refund_completed_at));
        gap();
      }

      // ── Cancellation policy ──────────────────────────────────────────────
      if (policies.length) {
        heading('Cancellation Policy');
        policies.forEach((p) => {
          const from = fmtDate(p.dueDate);
          if (!from) return;
          row(`From ${from}`, `Cancellation charge ${money(p.price?.amount, p.price?.currency)}`);
        });
        gap();
      }

      // ── Terms (admin-editable) ───────────────────────────────────────────
      const terms = Array.isArray(settings.terms) ? settings.terms.filter(Boolean) : [];
      if (terms.length) {
        heading(settings.termsTitle || 'Terms & Conditions');
        terms.forEach((term) => {
          const text = String(term);
          const height = Math.max(
            doc.font('Helvetica').fontSize(8.5).heightOfString(text, { width: CONTENT_RIGHT - PAGE_MARGIN - 12 }),
            11
          );
          ensure(height + 5);
          doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
            .text('•', PAGE_MARGIN, cursor, { width: 10 });
          doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
            .text(text, PAGE_MARGIN + 12, cursor, { width: CONTENT_RIGHT - PAGE_MARGIN - 12 });
          cursor += height + 3;
        });
        gap();
      }

      // ── Footer ───────────────────────────────────────────────────────────
      ensure(46);
      doc.moveTo(PAGE_MARGIN, cursor).lineTo(CONTENT_RIGHT, cursor)
        .strokeColor(LINE).lineWidth(1).stroke();
      cursor += 12;
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text(
          settings.footerNote ||
            'Please carry this voucher with you. For any assistance contact info@holidayseychelles.com. ' +
              'Payments are processed securely by CyberSource; Holiday Seychelles never stores your full card number.',
          PAGE_MARGIN,
          cursor,
          { width: CONTENT_RIGHT - PAGE_MARGIN, align: 'left' }
        );

      // Drawing into somebody else's document: they own ending and saving it.
      if (shared) {
        resolve({ absolutePath: null, relativePath: null, drawnInto: true });
        return;
      }

      doc.end();

      stream.on('finish', () =>
        resolve({ absolutePath: voucherPath, relativePath: voucherFilename })
      );
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateVoucherPDF };
