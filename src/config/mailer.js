const fs = require('fs');

function parseFrom(from) {
  const match = String(from || '').match(/^(.*?)\s*<(.+?)>$/);
  if (match) return { name: match[1].replace(/"/g, '').trim(), email: match[2].trim() };
  return { email: String(from || '').trim() };
}

function createBrevoTransporter(apiKey) {
  return {
    async sendMail(options) {
      const sender = parseFrom(options.from);

      const body = {
        sender,
        to: [{ email: options.to }],
        subject: options.subject,
        htmlContent: options.html,
        textContent: options.text,
      };

      if (options.cc) {
        const ccList = String(options.cc).split(',').map(e => ({ email: e.trim() })).filter(e => e.email.includes('@'));
        if (ccList.length) body.cc = ccList;
      }

      if (options.attachments && options.attachments.length > 0) {
        body.attachment = options.attachments
          .filter(att => att.path)
          .map(att => ({
            name: att.filename,
            content: fs.readFileSync(att.path).toString('base64'),
          }));
      }

      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(`Brevo API error ${response.status}: ${JSON.stringify(data)}`);
      }

      return { messageId: data.messageId || 'brevo-sent' };
    },
  };
}

let cached;

function getTransporter() {
  if (cached) return cached;

  const apiKey = process.env.BREVO_API_KEY;

  if (!apiKey) {
    const nodemailer = require('nodemailer');
    cached = nodemailer.createTransport({ jsonTransport: true });
    cached.__isJson = true;
    return cached;
  }

  cached = createBrevoTransporter(apiKey);
  return cached;
}

module.exports = { getTransporter };
