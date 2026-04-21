const nodemailer = require('nodemailer');

let cached;

function getTransporter() {
  if (cached) return cached;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    // No SMTP configured: fall back to JSON transport so OTPs print to console in dev.
    cached = nodemailer.createTransport({ jsonTransport: true });
    cached.__isJson = true;
    return cached;
  }

  cached = nodemailer.createTransport({
    host,
    port,
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user, pass },
  });
  return cached;
}

module.exports = { getTransporter };
