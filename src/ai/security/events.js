/**
 * Security events for sensitive AI changes (DESIGN.md §3.8 point 6): written
 * to admin_audit_log with status 'warning', and emailed to owners and the
 * admin concerned when `alert` is set.
 *
 *   otp_failures      — 3 (and 5) wrong codes on one verification
 *   off_hours         — a sensitive change between 22:00 and 06:00 Seychelles time
 *   new_device        — a sensitive change from a browser/network this admin never signed in from
 *   stepup_bad_password
 */

const { audit, security, db } = require('../ports');

/** Pure: is this moment outside 06:00–22:00 in Seychelles (UTC+4)? */
function offHours(date = new Date()) {
  const hour = (date.getUTCHours() + 4) % 24;
  return hour >= 22 || hour < 6;
}

async function record({ req, adminId, kind, summary, alert = false }) {
  let adminEmail = null;
  try {
    const { rows } = await db.query('SELECT email FROM admins WHERE id = $1', [adminId]);
    adminEmail = rows[0]?.email || null;
  } catch { /* the event is still written */ }
  await audit({ req, adminId, adminEmail, action: `rag.security.${kind}`, entityType: 'rag_security', summary, status: 'warning' }).catch(() => {});
  if (alert) {
    const emails = require('./emails');
    const to = await emails.recipients(adminEmail);
    await emails.sendSecurityAlert({ to, summary: `${summary}${adminEmail ? ` (${adminEmail})` : ''}`, ip: security.clientIp(req), userAgent: req?.get?.('user-agent') }).catch(() => {});
  }
}

/** Checks to run when a sensitive change is applied. */
async function onSensitiveChange({ req, adminId, what }) {
  if (offHours()) await record({ req, adminId, kind: 'off_hours', summary: `Sensitive change outside business hours: ${what}`, alert: true });
  try {
    const known = await security.isKnownDevice(adminId, security.deviceFingerprint(req));
    if (!known) await record({ req, adminId, kind: 'new_device', summary: `Sensitive change from a new device: ${what}`, alert: true });
  } catch { /* fingerprint unavailable: skip */ }
}

module.exports = { record, onSensitiveChange, offHours };
