/**
 * Emails that protect the admin account.
 *
 * Deliberately plain and unbranded-looking compared to the customer emails —
 * these are security notices, and they should read like one.
 */

const { getTransporter } = require('../config/mailer');

const INK = '#12120F';
const ACCENT = '#8A6410';

function fromAddress() {
  return process.env.SMTP_FROM || 'Holiday Seychelles <no-reply@holidayseychelles.com>';
}

function shell({ heading, body, accent = ACCENT }) {
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; background: #F7F6F3;">
    <div style="background: #0B0B0A; color: #fff; padding: 22px 28px;">
      <p style="margin:0; font-size:17px; font-weight:700;">Holiday Seychelles</p>
      <p style="margin:4px 0 0; font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:#E0A82E;">Admin security</p>
    </div>
    <div style="padding: 26px 28px; background:#fff;">
      <h2 style="margin:0 0 14px; font-size:18px; color:${INK};">${heading}</h2>
      ${body}
    </div>
    <div style="padding:14px 28px; background:#F1F1EE; text-align:center; font-size:11px; color:#8A8A82;">
      This is an automated security message. You cannot reply to it.
    </div>
  </div>`;
}

async function deliver(options, label) {
  const transporter = getTransporter();
  try {
    const info = await transporter.sendMail({ from: fromAddress(), ...options });
    if (transporter.__isJson) console.log(`📧 ${label} (dev mode):`, { to: options.to });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`Failed to send ${label}:`, err.message);
    return { success: false, error: err.message };
  }
}

/** The six-digit code for the email second factor. */
async function sendAdminOtpEmail({ to, code, name, ttlMinutes, ip }) {
  const body = `
    <p style="margin:0 0 14px; font-size:14px; color:#4B4B45;">
      Hi ${name || 'there'}, use this code to finish signing in to the admin panel.
    </p>
    <div style="margin:18px 0; padding:18px; background:#FEF6E6; border:1px solid #F5DFA8; border-radius:12px; text-align:center;">
      <p style="margin:0; font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:${ACCENT}; font-weight:700;">Your code</p>
      <p style="margin:6px 0 0; font-size:34px; font-weight:700; letter-spacing:10px; color:${INK};">${code}</p>
    </div>
    <p style="margin:0 0 6px; font-size:13px; color:#8A8A82;">
      It expires in ${ttlMinutes} minutes and can be used once.
    </p>
    <p style="margin:14px 0 0; font-size:13px; color:#A12C2C;">
      If this wasn't you, someone may have your password — change it immediately.
      ${ip ? `<br>Requested from ${ip}.` : ''}
    </p>`;

  return deliver(
    {
      to,
      subject: `${code} is your admin sign-in code`,
      html: shell({ heading: 'Finish signing in', body }),
      text: `Your admin sign-in code is ${code}. It expires in ${ttlMinutes} minutes.`,
    },
    'admin OTP'
  );
}

/** Heads-up when an admin signs in from somewhere new. */
async function sendNewDeviceAlert({ to, name, ip, userAgent, when }) {
  const body = `
    <p style="margin:0 0 14px; font-size:14px; color:#4B4B45;">
      Hi ${name || 'there'}, your admin account was just signed in to from a device we haven't
      seen before.
    </p>
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <tr><td style="padding:6px 0; color:#8A8A82;">When</td><td style="padding:6px 0; font-weight:600; color:${INK};">${when}</td></tr>
      <tr><td style="padding:6px 0; color:#8A8A82;">IP address</td><td style="padding:6px 0; font-weight:600; color:${INK};">${ip || 'unknown'}</td></tr>
      <tr><td style="padding:6px 0; color:#8A8A82;">Browser</td><td style="padding:6px 0; font-weight:600; color:${INK};">${(userAgent || 'unknown').slice(0, 120)}</td></tr>
    </table>
    <p style="margin:18px 0 0; font-size:13px; color:#A12C2C;">
      Wasn't you? Change your password now and turn on two-factor authentication in
      Security settings.
    </p>`;

  return deliver(
    {
      to,
      subject: 'New sign-in to your admin account',
      html: shell({ heading: 'New sign-in detected', body }),
      text: `A new sign-in to your Holiday Seychelles admin account. ${when}, IP ${ip || 'unknown'}.`,
    },
    'new device alert'
  );
}

/** Confirmation that a security setting changed. */
async function sendSecurityChangeAlert({ to, name, change, ip, when }) {
  const body = `
    <p style="margin:0 0 14px; font-size:14px; color:#4B4B45;">
      Hi ${name || 'there'}, a security setting on your admin account was changed.
    </p>
    <div style="margin:16px 0; padding:14px 16px; background:#F7F6F3; border-radius:10px;">
      <p style="margin:0; font-size:15px; font-weight:700; color:${INK};">${change}</p>
      <p style="margin:6px 0 0; font-size:12px; color:#8A8A82;">${when}${ip ? ` · ${ip}` : ''}</p>
    </div>
    <p style="margin:14px 0 0; font-size:13px; color:#A12C2C;">
      If you didn't make this change, contact your administrator immediately.
    </p>`;

  return deliver(
    {
      to,
      subject: `Security change: ${change}`,
      html: shell({ heading: 'Security setting changed', body }),
      text: `Security change on your admin account: ${change}. ${when}.`,
    },
    'security change alert'
  );
}

module.exports = { sendAdminOtpEmail, sendNewDeviceAlert, sendSecurityChangeAlert };
