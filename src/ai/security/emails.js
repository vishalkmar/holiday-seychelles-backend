/**
 * Emails for sensitive AI changes (Phase 12): the step-up code, the change
 * notice to owners and the actor, approval requests, and security alerts.
 * Same plain "security notice" look as the admin sign-in emails.
 */

const { mail, db } = require('../ports');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const site = () => (process.env.HS_FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminLink = (section) => `${site()}/admin/dashboard/${encodeURIComponent(section)}`;
const from = () => process.env.SMTP_FROM || 'Holiday Seychelles <no-reply@holidayseychelles.com>';

function shell(heading, body) {
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; background: #F7F6F3;">
    <div style="background: #0B0B0A; color: #fff; padding: 22px 28px;">
      <p style="margin:0; font-size:17px; font-weight:700;">Holiday Seychelles</p>
      <p style="margin:4px 0 0; font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:#E0A82E;">AI assistant security</p>
    </div>
    <div style="padding: 26px 28px; background:#fff;">
      <h2 style="margin:0 0 14px; font-size:18px; color:#12120F;">${heading}</h2>
      ${body}
    </div>
    <div style="padding:14px 28px; background:#F1F1EE; text-align:center; font-size:11px; color:#8A8A82;">
      This is an automated security message. You cannot reply to it.
    </div>
  </div>`;
}

async function send(options, label) {
  try {
    const transporter = mail.transporter();
    const info = await transporter.sendMail({ from: from(), ...options });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[ai] ${label} email failed:`, err.message);
    return { success: false, error: err.message };
  }
}

const when = () => new Date().toLocaleString('en-GB', { timeZone: 'Indian/Mahe', dateStyle: 'medium', timeStyle: 'short' }) + ' (Seychelles)';

async function sendStepUpCode({ to, name, code, what, ttlMinutes, ip }) {
  const body = `
    <p style="margin:0 0 14px; font-size:14px; color:#4B4B45;">Hi ${esc(name || 'there')}, use this code to confirm:</p>
    <p style="margin:0 0 14px; font-size:15px; font-weight:700; color:#12120F;">${esc(what)}</p>
    <div style="margin:18px 0; padding:18px; background:#FEF6E6; border:1px solid #F5DFA8; border-radius:12px; text-align:center;">
      <p style="margin:0; font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:#8A6410; font-weight:700;">Your code</p>
      <p style="margin:6px 0 0; font-size:34px; font-weight:700; letter-spacing:10px; color:#12120F;">${esc(code)}</p>
    </div>
    <p style="margin:0 0 6px; font-size:13px; color:#8A8A82;">It expires in ${ttlMinutes} minutes and can be used once.${ip ? ` Requested from ${esc(ip)}.` : ''}</p>
    <p style="margin:14px 0 0; font-size:13px; color:#A12C2C;">If this wasn't you, someone may have your admin password — change it now.</p>`;
  return send({ to, subject: `${code} is your code to confirm an AI change`, html: shell('Confirm a sensitive change', body), text: `Your code: ${code}. It confirms: ${what}. Expires in ${ttlMinutes} minutes.` }, 'step-up code');
}

/** Owners (role with '*') who are active, plus the actor — de-duplicated. */
async function recipients(actorEmail) {
  const { rows } = await db.query(
    `SELECT a.email FROM admins a JOIN admin_roles r ON r.role_key = a.role_key
      WHERE a.status = 'active' AND r.permissions LIKE '%"*"%'`
  ).catch(() => ({ rows: [] }));
  return [...new Set([...rows.map((r) => r.email), actorEmail].filter(Boolean).map((e) => e.toLowerCase()))];
}

/** "Who, what, when, version, diff summary, rollback link" to owners and the actor. */
async function sendChangeNotice({ actor, what, details = [], diff, section = 'rag-prompt' }) {
  const to = await recipients(actor?.email);
  if (!to.length) return { success: false, error: 'no recipients' };
  const rows = [['Who', `${actor?.name || ''} <${actor?.email || 'unknown'}>`], ['When', when()], ...details];
  const diffHtml = diff
    ? `<pre style="margin:14px 0 0; padding:12px; background:#F7F6F3; border-radius:10px; font-size:12px; white-space:pre-wrap; line-height:1.5;">${diff.lines
        .filter((l) => l.op !== ' ')
        .slice(0, 40)
        .map((l) => `<span style="color:${l.op === '+' ? '#047857' : '#BE123C'}">${l.op} ${esc(l.text)}</span>`)
        .join('\n')}${diff.added + diff.removed > 40 ? '\n…' : ''}</pre><p style="margin:6px 0 0; font-size:12px; color:#8A8A82;">+${diff.added} / −${diff.removed} lines</p>`
    : '';
  const body = `
    <p style="margin:0 0 14px; font-size:15px; font-weight:700; color:#12120F;">${esc(what)}</p>
    <table style="font-size:13px; color:#4B4B45; border-collapse:collapse;">${rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0; color:#8A8A82;">${esc(k)}</td><td style="padding:3px 0;">${esc(v)}</td></tr>`).join('')}</table>
    ${diffHtml}
    <p style="margin:18px 0 0;"><a href="${adminLink(section)}" style="display:inline-block; padding:10px 16px; background:#12120F; color:#fff; border-radius:8px; text-decoration:none; font-size:13px;">Review or roll back</a></p>
    <p style="margin:14px 0 0; font-size:13px; color:#A12C2C;">If nobody on your team made this change, roll it back and change the admin passwords.</p>`;
  return send({ to, subject: `AI assistant changed: ${what}`, html: shell('A change was made to the AI assistant', body), text: `${what} by ${actor?.email} at ${when()}. Review: ${adminLink(section)}` }, 'change notice');
}

async function sendApprovalRequest({ approvers, actor, summary, pendingId }) {
  if (!approvers.length) return { success: false, error: 'no approvers' };
  const body = `
    <p style="margin:0 0 14px; font-size:14px; color:#4B4B45;">${esc(actor?.name || actor?.email)} asked to make this change, and a second admin must approve it:</p>
    <p style="margin:0 0 14px; font-size:15px; font-weight:700; color:#12120F;">${esc(summary)}</p>
    <p style="margin:18px 0 0;"><a href="${adminLink('rag-audit')}" style="display:inline-block; padding:10px 16px; background:#12120F; color:#fff; border-radius:8px; text-decoration:none; font-size:13px;">Review request #${pendingId}</a></p>`;
  return send({ to: approvers, subject: `Approval needed: ${summary}`, html: shell('A change needs your approval', body), text: `${actor?.email} requested: ${summary}. Review: ${adminLink('rag-audit')}` }, 'approval request');
}

async function sendSecurityAlert({ to, summary, ip, userAgent }) {
  const list = Array.isArray(to) ? to : [to];
  const body = `
    <div style="margin:0 0 14px; padding:14px 16px; background:#FFF1F3; border:1px solid #FECDD3; border-radius:10px;">
      <p style="margin:0; font-size:15px; font-weight:700; color:#BE123C;">${esc(summary)}</p>
      <p style="margin:6px 0 0; font-size:12px; color:#8A8A82;">${when()}${ip ? ` · ${esc(ip)}` : ''}${userAgent ? ` · ${esc(String(userAgent).slice(0, 80))}` : ''}</p>
    </div>
    <p style="margin:0; font-size:13px; color:#4B4B45;">If this was you, nothing needs doing. If not, change the admin password and review the AI audit log.</p>
    <p style="margin:18px 0 0;"><a href="${adminLink('rag-audit')}" style="color:#12120F;">Open Audit &amp; Security</a></p>`;
  return send({ to: list, subject: `Security alert: ${summary}`, html: shell('Unusual activity on the AI assistant', body), text: `${summary} — ${when()}` }, 'security alert');
}

/** The assistant is failing (Phase 20 monitoring): what, and where to look. */
async function sendHealthAlert({ to, problems }) {
  const list = Array.isArray(to) ? to : [to];
  const items = problems.map((p) => `<li style="margin:0 0 6px;">${esc(p.summary)}</li>`).join('');
  const body = `
    <div style="margin:0 0 14px; padding:14px 16px; background:#FFF7E6; border:1px solid #FDE68A; border-radius:10px;">
      <ul style="margin:0; padding-left:18px; font-size:14px; color:#92400E;">${items}</ul>
      <p style="margin:8px 0 0; font-size:12px; color:#8A8A82;">${when()}</p>
    </div>
    <p style="margin:0; font-size:13px; color:#4B4B45;">Visitors still get a polite reply and the team's contact details. Check AI Settings → Test connection and Live API Integration → Test; the runbook lists the usual causes.</p>
    <p style="margin:18px 0 0;"><a href="${adminLink('rag-analytics')}" style="color:#12120F;">Open Analytics</a> · <a href="${adminLink('rag-overview')}" style="color:#12120F;">Overview</a></p>`;
  return send({ to: list, subject: `AI assistant alert: ${problems[0].summary}`, html: shell('The AI assistant is having trouble', body), text: problems.map((p) => p.summary).join('\n') }, 'health alert');
}

module.exports = { sendStepUpCode, sendChangeNotice, sendApprovalRequest, sendSecurityAlert, sendHealthAlert, recipients };
