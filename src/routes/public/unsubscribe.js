/**
 * The unsubscribe link at the bottom of a marketing email.
 *
 * Served as HTML rather than JSON because a mail client opens it in a browser,
 * and it has to work for someone who has no account and is not signed in — the
 * signed token in the URL is the only credential.
 *
 * GET shows a confirmation with a button; it does not unsubscribe on its own.
 * Mail scanners and link-preview bots fetch every URL in an email, and a GET
 * that acted would unsubscribe people who never clicked anything.
 */

const express = require('express');
const {
  verifyUnsubscribeToken,
  unsubscribe,
  resubscribe,
  isUnsubscribed,
} = require('../../services/emailTemplates');

const router = express.Router();

function page({ title, message, action = '', tone = '#2563EB' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${title} · Holiday Seychelles</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #F4F6FA; color: #061B3A; padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    }
    .card {
      background: #fff; border: 1px solid #D7E3F4; border-radius: 18px;
      max-width: 460px; width: 100%; overflow: hidden;
    }
    .head { background: ${tone}; color: #fff; padding: 22px 26px; }
    .head h1 { margin: 0; font-size: 18px; }
    .body { padding: 26px; }
    p { margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155; }
    button {
      background: ${tone}; color: #fff; border: 0; border-radius: 10px;
      padding: 13px 24px; font-size: 14px; font-weight: 700; cursor: pointer;
    }
    button:disabled { opacity: .6; cursor: default; }
    .note { font-size: 13px; color: #94A3B8; margin-top: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="head"><h1>Holiday Seychelles</h1></div>
    <div class="body">
      <p><strong>${title}</strong></p>
      <p>${message}</p>
      ${action}
    </div>
  </div>
</body>
</html>`;
}

router.get('/:token', async (req, res) => {
  const email = verifyUnsubscribeToken(req.params.token);

  if (!email) {
    return res.status(400).send(
      page({
        title: 'This link is not valid',
        message:
          'It may have been cut short by your email client. Copy the whole link from the email, or write to info@holidayseychelles.com and we will take you off the list.',
        tone: '#d03b3b',
      })
    );
  }

  if (await isUnsubscribed(email)) {
    return res.send(
      page({
        title: 'You are already unsubscribed',
        message: `<strong>${email}</strong> does not receive our offers. You will still get booking confirmations, vouchers and trip reminders for anything you book — those are not marketing.`,
        action: `<form method="POST" action="/api/unsubscribe/${req.params.token}/resubscribe">
                   <button type="submit">Start receiving offers again</button>
                 </form>`,
        tone: '#0ca30c',
      })
    );
  }

  res.send(
    page({
      title: 'Unsubscribe from our offers?',
      message: `We will stop sending offers and occasion emails to <strong>${email}</strong>. You will still receive booking confirmations, vouchers and trip reminders for anything you book.`,
      action: `<form method="POST" action="/api/unsubscribe/${req.params.token}">
                 <button type="submit">Yes, unsubscribe me</button>
               </form>
               <p class="note">Changed your mind? Just close this page.</p>`,
    })
  );
});

router.post('/:token', async (req, res) => {
  const email = verifyUnsubscribeToken(req.params.token);
  if (!email) {
    return res.status(400).send(
      page({ title: 'This link is not valid', message: 'Nothing has been changed.', tone: '#d03b3b' })
    );
  }

  try {
    await unsubscribe(email, { reason: 'Unsubscribed from an email link', source: 'link' });
    res.send(
      page({
        title: 'You are unsubscribed',
        message: `<strong>${email}</strong> will no longer receive our offers. Booking confirmations, vouchers and trip reminders still come through, because you need those to travel.`,
        action: `<form method="POST" action="/api/unsubscribe/${req.params.token}/resubscribe">
                   <button type="submit">Undo</button>
                 </form>`,
        tone: '#0ca30c',
      })
    );
  } catch (err) {
    console.error('unsubscribe error:', err.message);
    res
      .status(500)
      .send(
        page({
          title: 'Something went wrong',
          message:
            'We could not update your preferences. Please email info@holidayseychelles.com and we will do it by hand.',
          tone: '#d03b3b',
        })
      );
  }
});

router.post('/:token/resubscribe', async (req, res) => {
  const email = verifyUnsubscribeToken(req.params.token);
  if (!email) {
    return res.status(400).send(
      page({ title: 'This link is not valid', message: 'Nothing has been changed.', tone: '#d03b3b' })
    );
  }

  try {
    await resubscribe(email);
    res.send(
      page({
        title: 'Welcome back',
        message: `<strong>${email}</strong> will receive our offers again. You can unsubscribe any time from the link at the bottom of one.`,
        tone: '#0ca30c',
      })
    );
  } catch (err) {
    console.error('resubscribe error:', err.message);
    res.status(500).send(page({ title: 'Something went wrong', message: 'Please try again.', tone: '#d03b3b' }));
  }
});

module.exports = router;
