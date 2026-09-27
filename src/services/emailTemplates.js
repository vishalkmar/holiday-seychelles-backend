/**
 * Editable email templates: render, send, log.
 *
 * One place writes to `email_notifications`, so the admin email log and the
 * per-customer email history are the same record rather than two lists that
 * drift apart.
 *
 * Two rules here are deliberate and should not be relaxed:
 *
 *  1. **Variables are escaped unless the system composed them.** A guest name,
 *     a product title and an admin-typed message all arrive as text and are
 *     HTML-escaped. Only variables whose name ends in `_block`, `_table` or
 *     `_html` are inserted raw, and those are built by this codebase.
 *
 *  2. **Unsubscribe suppresses marketing only.** A voucher, a booking
 *     confirmation, a payment reminder and a trip reminder are transactional -
 *     the guest asked for them by buying something. Withholding one would leave
 *     somebody at a jetty without a voucher, so `sendTemplate` only consults
 *     the suppression list for templates flagged `is_marketing`.
 */

const crypto = require('crypto');
const { pool } = require('../config/db');
const {
  layout,
  deliver,
  escapeHtml,
  frontendUrl,
  backendUrl,
  BRAND,
} = require('../utils/emailLayout');

/** A variable the system composes, so its value is already safe HTML. */
const RAW_SUFFIX = /_(block|table|html)$/;

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// ── Templates ────────────────────────────────────────────────────────────────

function parseVariables(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.template_key,
    name: row.name,
    description: row.description,
    category: row.category,
    subject: row.subject,
    subheading: row.subheading,
    heading: row.heading,
    bodyHtml: row.body_html,
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_url,
    accent: row.accent || BRAND,
    variables: parseVariables(row.variables),
    isAutomated: !!row.is_automated,
    isMarketing: !!row.is_marketing,
    enabled: !!row.enabled,
    updatedAt: row.updated_at,
  };
}

async function listTemplates() {
  const { rows } = await pool.query(
    'SELECT * FROM email_templates ORDER BY category ASC, name ASC'
  );
  return rows.map(shape);
}

async function getTemplate(key) {
  const { rows } = await pool.query('SELECT * FROM email_templates WHERE template_key = $1', [key]);
  return shape(rows[0]);
}

const EDITABLE = {
  name: 'name',
  description: 'description',
  subject: 'subject',
  subheading: 'subheading',
  heading: 'heading',
  bodyHtml: 'body_html',
  ctaLabel: 'cta_label',
  ctaUrl: 'cta_url',
  accent: 'accent',
  enabled: 'enabled',
};

/**
 * Update a template.
 *
 * `template_key`, `category` and the automated/marketing flags are NOT
 * editable: they are what the sending code keys off, and letting an operator
 * rename a key would silently stop an automated email without any error.
 */
async function saveTemplate(key, patch, adminId) {
  const updates = [];
  const params = [];

  for (const [field, column] of Object.entries(EDITABLE)) {
    if (patch[field] === undefined) continue;
    params.push(field === 'enabled' ? (patch[field] ? 1 : 0) : patch[field]);
    updates.push(`${column} = $${params.length}`);
  }
  if (!updates.length) return { updated: false };

  params.push(adminId || null);
  updates.push(`updated_by = $${params.length}`);

  params.push(key);
  const result = await pool.query(
    `UPDATE email_templates SET ${updates.join(', ')} WHERE template_key = $${params.length}`,
    params
  );
  return { updated: result.rowCount > 0 };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Fill `{{placeholders}}` in one string.
 *
 * Returns the text plus the names that had no value, so the editor can warn
 * about a typo instead of silently sending an email with a hole in it.
 */
function fill(text, vars) {
  const missing = [];
  const filled = String(text || '').replace(PLACEHOLDER, (_match, name) => {
    const value = vars[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }
    return RAW_SUFFIX.test(name) ? String(value) : escapeHtml(value);
  });
  return { text: filled, missing };
}

/** Every `{{name}}` a template actually references. */
function usedVariables(template) {
  const names = new Set();
  const scan = (text) => {
    String(text || '').replace(PLACEHOLDER, (_m, name) => names.add(name));
  };
  scan(template.subject);
  scan(template.subheading);
  scan(template.heading);
  scan(template.bodyHtml);
  scan(template.ctaLabel);
  scan(template.ctaUrl);
  return [...names];
}

/**
 * Render a template to a sendable email.
 *
 * The subject is filled then stripped of HTML entities — an escaped apostrophe
 * belongs in a body, never in a subject line, where it shows up literally as
 * `&#39;` in the inbox.
 */
function renderTemplate(template, vars = {}, { unsubscribeUrl = null } = {}) {
  const missing = new Set();
  const take = (value) => {
    const result = fill(value, vars);
    result.missing.forEach((m) => missing.add(m));
    return result.text;
  };

  const subject = unescapeEntities(take(template.subject)).trim();
  const heading = take(template.heading);
  const subheading = take(template.subheading);
  const body = take(template.bodyHtml);
  const ctaLabel = take(template.ctaLabel);
  const ctaUrl = take(template.ctaUrl);

  const footerNote = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:#64748b;">Unsubscribe from offers</a>`
    : null;

  const html = layout({
    heading,
    subheading,
    body,
    cta: ctaLabel && ctaUrl ? { label: ctaLabel, href: ctaUrl } : null,
    accent: template.accent || BRAND,
    footerNote,
  });

  return {
    subject,
    html,
    text: toPlainText(body, { ctaLabel, ctaUrl, unsubscribeUrl }),
    missing: [...missing],
  };
}

function unescapeEntities(text) {
  return String(text)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A readable plain-text part, because an HTML-only email scores as spam. */
function toPlainText(html, { ctaLabel, ctaUrl, unsubscribeUrl } = {}) {
  let text = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|tr|h\d)\s*>/gi, '\n')
    .replace(/<\/\s*td\s*>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n');
  text = unescapeEntities(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, all) => line || all[i - 1])
    .join('\n')
    .trim();

  if (ctaLabel && ctaUrl) text += `\n\n${ctaLabel}: ${ctaUrl}`;
  text += '\n\nHoliday Seychelles';
  if (unsubscribeUrl) text += `\nUnsubscribe from offers: ${unsubscribeUrl}`;
  return text;
}

// ── Unsubscribe ──────────────────────────────────────────────────────────────

/**
 * A signed, stateless unsubscribe link.
 *
 * Signed with the app secret so the link cannot be walked to unsubscribe
 * somebody else, and stateless so generating one costs no database write during
 * a bulk send.
 */
function unsubscribeToken(email) {
  const normalised = String(email || '').trim().toLowerCase();
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'holiday-seychelles';
  const signature = crypto
    .createHmac('sha256', secret)
    .update(normalised)
    .digest('base64url')
    .slice(0, 24);
  return `${Buffer.from(normalised).toString('base64url')}.${signature}`;
}

function verifyUnsubscribeToken(token) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature) return null;
  let email;
  try {
    email = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = unsubscribeToken(email).split('.')[1];
  // Constant-time, and only after a length check - timingSafeEqual throws on
  // mismatched lengths, which would turn a bad link into a 500.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return email;
}

function unsubscribeUrlFor(email) {
  return `${backendUrl()}/api/unsubscribe/${unsubscribeToken(email)}`;
}

async function isUnsubscribed(email) {
  const { rows } = await pool.query(
    'SELECT id FROM email_unsubscribes WHERE email = $1 LIMIT 1',
    [String(email || '').trim().toLowerCase()]
  );
  return rows.length > 0;
}

async function unsubscribe(email, { reason = null, source = 'link' } = {}) {
  await pool.query(
    `INSERT INTO email_unsubscribes (email, reason, source) VALUES ($1, $2, $3)
     ON DUPLICATE KEY UPDATE reason = VALUES(reason), source = VALUES(source)`,
    [String(email).trim().toLowerCase(), reason, source]
  );
}

async function resubscribe(email) {
  const result = await pool.query('DELETE FROM email_unsubscribes WHERE email = $1', [
    String(email).trim().toLowerCase(),
  ]);
  return result.rowCount > 0;
}

// ── Logging ──────────────────────────────────────────────────────────────────

/**
 * Record one attempt. The only writer of `email_notifications`.
 *
 * A duplicate `dedupe_key` means an automated job already sent this exact
 * email; that is the mechanism working, not an error, so it is swallowed.
 */
async function logEmail({
  kind,
  dedupeKey = null,
  bookingId = null,
  orderId = null,
  campaignId = null,
  recipient,
  subject = null,
  templateKey = null,
  bodyHtml = null,
  resentFrom = null,
  result,
}) {
  try {
    const inserted = await pool.query(
      `INSERT INTO email_notifications
         (kind, dedupe_key, booking_id, payment_order_id, campaign_id, recipient,
          subject, template_key, message_id, body_html, resent_from, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        kind,
        dedupeKey,
        bookingId,
        orderId,
        campaignId,
        recipient,
        subject,
        templateKey,
        result.messageId || null,
        bodyHtml,
        resentFrom,
        result.success ? 'sent' : 'failed',
        result.success ? null : result.error || 'unknown error',
      ]
    );
    return inserted.insertId || null;
  } catch (err) {
    if (!/duplicate/i.test(err.message)) {
      console.error('[email] could not log send:', err.message);
    }
    return null;
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────

/**
 * Render a template and send it, logging the outcome either way.
 *
 * Returns `{ success, skipped, reason }`. A marketing email to someone who
 * unsubscribed is `skipped`, not `failed` — nothing went wrong, and counting it
 * as a failure would make every campaign look broken.
 */
async function sendTemplate({
  key,
  to,
  vars = {},
  kind = null,
  dedupeKey = null,
  bookingId = null,
  orderId = null,
  campaignId = null,
  resentFrom = null,
  skipLog = false,
  template: given = null,
}) {
  const template = given || (await getTemplate(key));
  if (!template) return { success: false, skipped: false, reason: `No template "${key}"` };
  if (!to) return { success: false, skipped: true, reason: 'No recipient address' };

  if (template.isMarketing && (await isUnsubscribed(to))) {
    return { success: false, skipped: true, reason: 'Recipient has unsubscribed' };
  }

  const unsubscribeUrl = template.isMarketing ? unsubscribeUrlFor(to) : null;
  const rendered = renderTemplate(template, { site_url: frontendUrl(), ...vars }, { unsubscribeUrl });

  const result = await deliver(
    { to, subject: rendered.subject, html: rendered.html, text: rendered.text },
    template.name,
    to
  );

  let logId = null;
  if (!skipLog) {
    logId = await logEmail({
      kind: kind || template.key,
      dedupeKey,
      bookingId,
      orderId,
      campaignId,
      recipient: to,
      subject: rendered.subject,
      templateKey: template.key,
      bodyHtml: rendered.html,
      resentFrom,
      result,
    });
  }

  return {
    success: result.success,
    skipped: false,
    reason: result.error || null,
    subject: rendered.subject,
    missing: rendered.missing,
    logId,
  };
}

module.exports = {
  listTemplates,
  getTemplate,
  saveTemplate,
  renderTemplate,
  usedVariables,
  fill,
  toPlainText,
  sendTemplate,
  logEmail,
  isUnsubscribed,
  unsubscribe,
  resubscribe,
  unsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrlFor,
  frontendUrl,
};
