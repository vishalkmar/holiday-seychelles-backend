/**
 * The shell every Holiday Seychelles email is poured into.
 *
 * This lives apart from the emails themselves because two callers now need it:
 * the lifecycle emails coded in `lifecycleEmails.js`, and the editable
 * templates in `services/emailTemplates.js`. One shell means an admin editing
 * the wording of a reminder cannot accidentally produce an email that looks
 * like it came from somewhere else — and cannot break the layout at all, since
 * the header, card and footer are not editable.
 */

const { getTransporter } = require('../config/mailer');

const BRAND = '#2563EB';
const DARK = '#061B3A';

function fromAddress() {
  return process.env.SMTP_FROM || 'Holiday Seychelles <no-reply@holidayseychelles.com>';
}

function frontendUrl() {
  return (process.env.HS_FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function backendUrl() {
  return (process.env.HS_BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
}

function fmtDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function money(amount, currency) {
  return `${currency || 'EUR'} ${Number(amount || 0).toFixed(2)}`;
}

function guestName(row) {
  return `${row.lead_first_name || ''} ${row.lead_last_name || ''}`.trim() || 'Traveller';
}

/**
 * Escape text that came from a guest, an admin or the database.
 *
 * Everything merged into an email body goes through here unless the variable is
 * one the system composed itself — a name containing `<script>` is a real thing
 * that arrives through a booking form.
 */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The outer card. `footerNote` carries the unsubscribe line on marketing mail. */
function layout({ heading, subheading, body, cta, accent = BRAND, footerNote }) {
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 640px; margin: 0 auto; background: #f8fafc;">
    <div style="background: linear-gradient(135deg, ${accent} 0%, #3b82f6 100%); color: #fff; padding: 28px 32px;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 700;">Holiday Seychelles</h1>
      <p style="margin: 6px 0 0; font-size: 13px; opacity: .9;">${subheading || ''}</p>
    </div>
    <div style="padding: 28px 32px; background: #ffffff;">
      <h2 style="margin: 0 0 14px; font-size: 19px; color: ${DARK};">${heading || ''}</h2>
      ${body}
      ${
        cta && cta.href
          ? `<div style="margin: 26px 0 8px;">
               <a href="${cta.href}" style="display: inline-block; background: ${accent}; color: #fff; text-decoration: none; padding: 13px 26px; border-radius: 10px; font-weight: 700; font-size: 14px;">${cta.label}</a>
             </div>`
          : ''
      }
      <p style="margin: 22px 0 0; font-size: 13px; color: #64748b;">
        Need help? Email <a href="mailto:info@holidayseychelles.com" style="color: ${accent}; text-decoration: none;">info@holidayseychelles.com</a>.
      </p>
    </div>
    <div style="padding: 16px 32px; background: #f1f5f9; text-align: center; font-size: 11px; color: #64748b;">
      © ${new Date().getFullYear()} Holiday Seychelles. All rights reserved.
      ${footerNote ? `<br />${footerNote}` : ''}
    </div>
  </div>`;
}

function detailTable(rows) {
  const cells = rows
    .filter(([, value]) => value)
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding: 8px 0; color: #64748b; width: 42%; font-size: 14px;">${label}</td>
          <td style="padding: 8px 0; font-weight: 600; color: ${DARK}; font-size: 14px;">${value}</td>
        </tr>`
    )
    .join('');
  return `<table style="width:100%; border-collapse: collapse;">${cells}</table>`;
}

function referenceBlock(label, value, accent = BRAND) {
  if (!value) return '';
  return `
    <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 16px 20px; margin: 18px 0;">
      <p style="margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: ${accent}; font-weight: 700;">${label}</p>
      <p style="margin: 4px 0 0; font-size: 19px; font-weight: 700; color: ${DARK};">${value}</p>
    </div>`;
}

/**
 * Hand one message to the provider.
 *
 * Never throws: a send that fails is a result, not an exception, because every
 * caller has to record the failure rather than abandon the sweep it is in.
 */
async function deliver(mailOptions, label, to) {
  const transporter = getTransporter();
  try {
    const info = await transporter.sendMail({ from: fromAddress(), ...mailOptions });
    if (transporter.__isJson) console.log(`📧 ${label} (dev mode):`, { to });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`Failed to send ${label}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  BRAND,
  DARK,
  fromAddress,
  frontendUrl,
  backendUrl,
  fmtDate,
  money,
  guestName,
  escapeHtml,
  layout,
  detailTable,
  referenceBlock,
  deliver,
};
