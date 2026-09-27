/**
 * Email & communications admin API.
 *
 * Four things live here: the editable templates, the log of everything ever
 * sent, bulk/scheduled campaigns, and the marketing suppression list.
 *
 * The log is the reason the rest exists — when a guest says "I never got it",
 * this is the only place that can answer, so every send in the system writes
 * here through services/emailTemplates.logEmail.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const { runLimited } = require('../../utils/concurrency');
const tpl = require('../../services/emailTemplates');
const campaigns = require('../../services/emailCampaigns');
const segments = require('../../services/emailSegments');

const router = express.Router();
const num = (v) => Number(v || 0);

function invalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, null, errors.array()[0].msg, 400);
  return true;
}

/**
 * Sample values for the preview, per template.
 *
 * Deliberately obvious placeholders rather than a real customer's data — a
 * preview that looks like a real booking invites somebody to believe it is one.
 */
const SAMPLE = {
  guest_name: 'Alex Traveller',
  product_title: 'Villa De Roses — Room STANDARD',
  booking_reference: 'BS-SAMPLE-001',
  order_reference: 'HS-SAMPLE-0001',
  amount: 'EUR 150.00',
  travel_date: 'Fri, 10 Oct 2026',
  check_in: 'Fri, 10 Oct 2026',
  check_out: 'Mon, 13 Oct 2026',
  stayed: 'Fri, 10 Oct 2026 → Mon, 13 Oct 2026',
  travellers: 2,
  subject: 'A note from Holiday Seychelles',
  heading: 'A note from Holiday Seychelles',
  message_html: '<p>This is where your message appears.</p>',
  reference_block: `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px 20px;margin:18px 0;">
      <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#2563EB;font-weight:700;">Reference</p>
      <p style="margin:4px 0 0;font-size:19px;font-weight:700;color:#061B3A;">BS-SAMPLE-001</p>
    </div>`,
  details_table: `
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:8px 0;color:#64748b;width:42%;font-size:14px;">Item</td><td style="padding:8px 0;font-weight:600;color:#061B3A;font-size:14px;">Villa De Roses</td></tr>
      <tr><td style="padding:8px 0;color:#64748b;font-size:14px;">Travellers</td><td style="padding:8px 0;font-weight:600;color:#061B3A;font-size:14px;">2</td></tr>
    </table>`,
};

function sampleVars(extra = {}) {
  const site = tpl.frontendUrl();
  return {
    ...SAMPLE,
    site_url: site,
    dashboard_url: `${site}/dashboard?tab=trips`,
    resume_url: `${site}/dashboard?tab=transactions`,
    feedback_url: `${site}/dashboard?tab=queries`,
    ...extra,
  };
}

// ── Templates ────────────────────────────────────────────────────────────────

router.get('/templates', adminAuth, async (req, res) => {
  try {
    const list = await tpl.listTemplates();

    // How often each template has actually been used, so an operator can tell a
    // live template from one nothing has ever sent.
    const { rows } = await pool.query(
      `SELECT template_key,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
              MAX(sent_at) AS last_used
         FROM email_notifications
        WHERE template_key IS NOT NULL
        GROUP BY template_key`
    );
    const usage = Object.fromEntries(rows.map((r) => [r.template_key, r]));

    sendSuccess(
      res,
      {
        templates: list.map((t) => ({
          ...t,
          usedVariables: tpl.usedVariables(t),
          usage: {
            total: num(usage[t.key]?.total),
            sent: num(usage[t.key]?.sent),
            lastUsed: usage[t.key]?.last_used || null,
          },
        })),
        stats: {
          total: list.length,
          automated: list.filter((t) => t.isAutomated).length,
          disabled: list.filter((t) => !t.enabled).length,
          marketing: list.filter((t) => t.isMarketing).length,
        },
      },
      'Templates retrieved'
    );
  } catch (err) {
    console.error('templates list error:', err);
    sendError(res, err, 'Failed to load the templates', 500);
  }
});

router.get('/templates/:key', adminAuth, async (req, res) => {
  try {
    const template = await tpl.getTemplate(req.params.key);
    if (!template) return sendError(res, null, 'Template not found', 404);

    const preview = tpl.renderTemplate(template, sampleVars());
    sendSuccess(
      res,
      { template: { ...template, usedVariables: tpl.usedVariables(template) }, preview },
      'Template retrieved'
    );
  } catch (err) {
    console.error('template read error:', err);
    sendError(res, err, 'Failed to load this template', 500);
  }
});

router.put(
  '/templates/:key',
  adminAuth,
  body('subject').optional().trim().isLength({ min: 3 }).withMessage('The subject is too short'),
  body('bodyHtml').optional().isLength({ min: 10 }).withMessage('The body is too short'),
  body('accent').optional().matches(/^#[0-9a-fA-F]{6}$/).withMessage('Accent must be a hex colour'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const before = await tpl.getTemplate(req.params.key);
      if (!before) return sendError(res, null, 'Template not found', 404);

      const { updated } = await tpl.saveTemplate(req.params.key, req.body, req.admin.id);
      if (!updated) return sendError(res, null, 'Nothing to update', 400);

      const after = await tpl.getTemplate(req.params.key);
      const changed = Object.keys(req.body).filter((k) => before[k] !== after[k]);

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.email.template_updated',
        entityType: 'email_template',
        entityId: after.id,
        summary:
          before.enabled !== after.enabled
            ? `${after.name} ${after.enabled ? 'enabled' : 'disabled'}`
            : `Edited ${after.name} (${changed.join(', ') || 'no visible change'})`,
        metadata: { changed },
      });

      sendSuccess(
        res,
        { template: after, preview: tpl.renderTemplate(after, sampleVars()) },
        after.enabled === false ? 'Template saved and switched off' : 'Template saved'
      );
    } catch (err) {
      console.error('template save error:', err);
      sendError(res, err, 'Failed to save this template', 500);
    }
  }
);

/** Render without saving, so the editor can preview an unsaved draft. */
router.post('/templates/:key/preview', adminAuth, async (req, res) => {
  try {
    const stored = await tpl.getTemplate(req.params.key);
    if (!stored) return sendError(res, null, 'Template not found', 404);

    const draft = { ...stored, ...req.body };
    const rendered = tpl.renderTemplate(draft, sampleVars(req.body.vars || {}));
    sendSuccess(
      res,
      { preview: rendered, usedVariables: tpl.usedVariables(draft) },
      'Preview rendered'
    );
  } catch (err) {
    console.error('template preview error:', err);
    sendError(res, err, 'Failed to render the preview', 500);
  }
});

/** Send the sample to a real inbox, so wording can be checked in a mail client. */
router.post(
  '/templates/:key/test',
  adminAuth,
  body('to').trim().isEmail().withMessage('Give a valid address to test with'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const template = await tpl.getTemplate(req.params.key);
      if (!template) return sendError(res, null, 'Template not found', 404);

      const draft = req.body.draft ? { ...template, ...req.body.draft } : template;
      const outcome = await tpl.sendTemplate({
        template: { ...draft, isMarketing: false },
        key: template.key,
        kind: 'test_send',
        to: req.body.to,
        vars: sampleVars({ subject: `[TEST] ${draft.subject}` }),
      });

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.email.test_sent',
        entityType: 'email_template',
        entityId: template.id,
        summary: `Test of "${template.name}" sent to ${req.body.to}`,
        status: outcome.success ? 'success' : 'failed',
      });

      if (!outcome.success) {
        return sendError(res, null, `Could not send: ${outcome.reason}`, 502);
      }
      sendSuccess(res, { sentTo: req.body.to, subject: outcome.subject }, 'Test email sent');
    } catch (err) {
      console.error('template test error:', err);
      sendError(res, err, 'Failed to send the test', 500);
    }
  }
);

// ── Log ──────────────────────────────────────────────────────────────────────

router.get('/log', adminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    if (req.query.kind) add('n.kind = ?', req.query.kind);
    if (req.query.status) add('n.status = ?', req.query.status);
    if (req.query.template) add('n.template_key = ?', req.query.template);
    if (req.query.campaign) add('n.campaign_id = ?', req.query.campaign);
    if (req.query.from) add('n.sent_at >= ?', `${req.query.from} 00:00:00`);
    if (req.query.to) add('n.sent_at <= ?', `${req.query.to} 23:59:59`);
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const p = `$${params.length}`;
      conditions.push(`(n.recipient LIKE ${p} OR n.subject LIKE ${p})`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    const source = `
      FROM email_notifications n
      LEFT JOIN bookings b ON b.id = n.booking_id
      LEFT JOIN email_campaigns c ON c.id = n.campaign_id
      ${where}`;

    const [rows, total, stats, kinds] = await runLimited([
      () =>
        pool.query(
          `SELECT n.id, n.kind, n.recipient, n.subject, n.template_key, n.campaign_id,
                  n.status, n.error, n.message_id, n.resent_from, n.sent_at,
                  b.booking_reference, c.name AS campaign_name
           ${source}
           ORDER BY n.sent_at DESC, n.id DESC
           LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
      () => pool.query(`SELECT COUNT(*) AS total ${source}`, params),
      () =>
        pool.query(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN n.status = 'sent' THEN 1 ELSE 0 END) AS sent,
                  SUM(CASE WHEN n.status = 'failed' THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN n.sent_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS last7
           ${source}`,
          params
        ),
      () =>
        pool.query(
          'SELECT kind, COUNT(*) AS total FROM email_notifications GROUP BY kind ORDER BY total DESC'
        ),
    ]);

    const s = stats.rows[0] || {};
    const sent = num(s.sent);
    const failed = num(s.failed);

    sendSuccess(
      res,
      {
        emails: rows.rows,
        total: num(total.rows[0]?.total),
        page,
        limit,
        pages: Math.max(1, Math.ceil(num(total.rows[0]?.total) / limit)),
        stats: {
          total: num(s.total),
          sent,
          failed,
          last7: num(s.last7),
          // Handed over rather than computed in the UI, so the log and any other
          // reader of this endpoint cannot disagree about what it means.
          deliveryRate: sent + failed > 0 ? Number(((sent / (sent + failed)) * 100).toFixed(1)) : null,
        },
        kinds: kinds.rows.map((k) => ({ kind: k.kind, total: num(k.total) })),
        // What the provider reports is acceptance, not arrival in an inbox.
        note: 'Status is what the mail provider accepted. Opens and clicks are not tracked.',
      },
      'Email log retrieved'
    );
  } catch (err) {
    console.error('email log error:', err);
    sendError(res, err, 'Failed to load the email log', 500);
  }
});

router.get('/log/:id', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.*, b.booking_reference, c.name AS campaign_name
         FROM email_notifications n
         LEFT JOIN bookings b ON b.id = n.booking_id
         LEFT JOIN email_campaigns c ON c.id = n.campaign_id
        WHERE n.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return sendError(res, null, 'Email not found', 404);
    sendSuccess(res, { email: rows[0] }, 'Email retrieved');
  } catch (err) {
    console.error('email read error:', err);
    sendError(res, err, 'Failed to load this email', 500);
  }
});

/**
 * Resend one email.
 *
 * The stored HTML is sent again as-is rather than re-rendered, because the
 * point of a resend is to deliver the message the customer was promised, not
 * whatever the template says today. Older rows predate body storage and are
 * re-rendered from their template instead; the response says which happened.
 */
router.post('/log/:id/resend', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM email_notifications WHERE id = $1', [
      req.params.id,
    ]);
    if (!rows.length) return sendError(res, null, 'Email not found', 404);
    const original = rows[0];

    const to = req.body?.to || original.recipient;
    let outcome;
    let mode;

    if (original.body_html) {
      mode = 'original';
      const { deliver } = require('../../utils/emailLayout');
      const result = await deliver(
        {
          to,
          subject: original.subject || 'Holiday Seychelles',
          html: original.body_html,
          text: tpl.toPlainText(original.body_html),
        },
        'resend',
        to
      );
      await tpl.logEmail({
        kind: original.kind,
        bookingId: original.booking_id,
        orderId: original.payment_order_id,
        campaignId: original.campaign_id,
        recipient: to,
        subject: original.subject,
        templateKey: original.template_key,
        bodyHtml: original.body_html,
        resentFrom: original.id,
        result,
      });
      outcome = { success: result.success, reason: result.error };
    } else if (original.template_key) {
      mode = 're-rendered';
      outcome = await tpl.sendTemplate({
        key: original.template_key,
        kind: original.kind,
        to,
        vars: sampleVars(),
        bookingId: original.booking_id,
        orderId: original.payment_order_id,
        resentFrom: original.id,
      });
    } else {
      return sendError(
        res,
        null,
        'This email predates body storage and has no template, so there is nothing to resend. Trigger it from the booking instead.',
        409
      );
    }

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.email.resent',
      entityType: 'email',
      entityId: original.id,
      summary: `Resent "${original.subject || original.kind}" to ${to}`,
      status: outcome.success ? 'success' : 'failed',
      metadata: { mode },
    });

    if (!outcome.success) return sendError(res, null, `Could not send: ${outcome.reason}`, 502);
    sendSuccess(res, { sentTo: to, mode }, `Email resent (${mode} copy)`);
  } catch (err) {
    console.error('email resend error:', err);
    sendError(res, err, 'Failed to resend this email', 500);
  }
});

// ── Segments ─────────────────────────────────────────────────────────────────

/** Who would receive this, before anything is sent. */
router.post('/segments/preview', adminAuth, async (req, res) => {
  try {
    const segment = req.body?.segment || {};
    const recipients = await segments.resolveSegment(segment);
    sendSuccess(
      res,
      {
        count: recipients.length,
        description: segments.describe(segment),
        sample: recipients.slice(0, 10),
        audiences: segments.AUDIENCES,
        occasions: segments.OCCASIONS,
        note: 'People who unsubscribed from marketing are already excluded from this count.',
      },
      'Segment resolved'
    );
  } catch (err) {
    console.error('segment preview error:', err);
    sendError(res, err, 'Failed to resolve this segment', 500);
  }
});

router.get('/segments', adminAuth, (req, res) =>
  sendSuccess(
    res,
    { audiences: segments.AUDIENCES, occasions: segments.OCCASIONS },
    'Segment options retrieved'
  )
);

// ── Campaigns ────────────────────────────────────────────────────────────────

router.get('/campaigns', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 100');
    const list = rows.map(campaigns.shape);
    sendSuccess(
      res,
      {
        campaigns: list,
        stats: {
          total: list.length,
          scheduled: list.filter((c) => c.status === 'scheduled').length,
          sent: list.filter((c) => c.status === 'sent').length,
          delivered: list.reduce((a, c) => a + c.sentCount, 0),
        },
      },
      'Campaigns retrieved'
    );
  } catch (err) {
    console.error('campaigns list error:', err);
    sendError(res, err, 'Failed to load campaigns', 500);
  }
});

router.get('/campaigns/:id', adminAuth, async (req, res) => {
  try {
    const campaign = await campaigns.getCampaign(req.params.id);
    if (!campaign) return sendError(res, null, 'Campaign not found', 404);

    const { rows } = await pool.query(
      `SELECT id, recipient, status, error, sent_at FROM email_notifications
        WHERE campaign_id = $1 ORDER BY id DESC LIMIT 200`,
      [req.params.id]
    );
    sendSuccess(res, { campaign, recipients: rows }, 'Campaign retrieved');
  } catch (err) {
    console.error('campaign read error:', err);
    sendError(res, err, 'Failed to load this campaign', 500);
  }
});

router.post(
  '/campaigns',
  adminAuth,
  body('name').trim().isLength({ min: 3 }).withMessage('Give the campaign a name'),
  body('templateKey').trim().notEmpty().withMessage('Pick a template'),
  body('subject').trim().isLength({ min: 3 }).withMessage('Give the email a subject'),
  body('messageHtml').trim().isLength({ min: 10 }).withMessage('Write a message'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const template = await tpl.getTemplate(req.body.templateKey);
      if (!template) return sendError(res, null, 'That template does not exist', 400);

      const scheduledFor = req.body.scheduledFor || null;
      if (scheduledFor && Number.isNaN(new Date(scheduledFor).getTime())) {
        return sendError(res, null, 'The scheduled time is not a valid date', 400);
      }
      const status = scheduledFor ? 'scheduled' : 'draft';

      const result = await pool.query(
        `INSERT INTO email_campaigns
           (name, template_key, subject, heading, message_html, cta_label, cta_url,
            segment, status, scheduled_for, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          req.body.name,
          req.body.templateKey,
          req.body.subject,
          req.body.heading || req.body.subject,
          req.body.messageHtml,
          req.body.ctaLabel || null,
          req.body.ctaUrl || null,
          JSON.stringify(req.body.segment || {}),
          status,
          scheduledFor ? new Date(scheduledFor) : null,
          req.admin.id,
        ]
      );

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.email.campaign_created',
        entityType: 'email_campaign',
        entityId: result.insertId,
        summary: `Created campaign "${req.body.name}" (${status})`,
      });

      sendSuccess(
        res,
        { campaign: await campaigns.getCampaign(result.insertId) },
        scheduledFor ? 'Campaign scheduled' : 'Campaign saved as a draft'
      );
    } catch (err) {
      console.error('campaign create error:', err);
      sendError(res, err, 'Failed to create the campaign', 500);
    }
  }
);

/**
 * Start a send now.
 *
 * Returns as soon as the campaign is claimed rather than waiting for the last
 * recipient — a send to a few thousand people would otherwise hold the request
 * open until it timed out, and the operator would have no idea whether it ran.
 * Progress is read back from the campaign row.
 */
router.post('/campaigns/:id/send', adminAuth, async (req, res) => {
  try {
    const campaign = await campaigns.getCampaign(req.params.id);
    if (!campaign) return sendError(res, null, 'Campaign not found', 404);
    if (!['draft', 'scheduled'].includes(campaign.status)) {
      return sendError(res, null, `This campaign is already ${campaign.status}`, 409);
    }

    const recipients = await segments.resolveSegment(campaign.segment);
    if (!recipients.length) {
      return sendError(res, null, 'That segment matches nobody right now', 400);
    }

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.email.campaign_sent',
      entityType: 'email_campaign',
      entityId: campaign.id,
      summary: `Started "${campaign.name}" to ${recipients.length} recipient(s)`,
    });

    const run = campaigns.runCampaign(campaign.id);
    run.catch((err) => console.error('[campaigns] unhandled:', err.message));

    // Small sends finish inside the request, which makes the UI feel immediate.
    // Anything bigger returns and is polled.
    const finished = await Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);

    sendSuccess(
      res,
      {
        started: true,
        recipients: recipients.length,
        finished: Boolean(finished),
        campaign: await campaigns.getCampaign(campaign.id),
      },
      finished ? 'Campaign sent' : 'Campaign is sending — progress will update here'
    );
  } catch (err) {
    console.error('campaign send error:', err);
    sendError(res, err, 'Failed to start this campaign', 500);
  }
});

router.delete('/campaigns/:id', adminAuth, async (req, res) => {
  try {
    const campaign = await campaigns.getCampaign(req.params.id);
    if (!campaign) return sendError(res, null, 'Campaign not found', 404);
    if (campaign.status === 'sending') {
      return sendError(res, null, 'This campaign is sending right now — let it finish', 409);
    }
    // A campaign that has already gone out is a record of what was sent, so it
    // is cancelled rather than removed.
    if (campaign.status === 'sent') {
      return sendError(res, null, 'A campaign that has been sent cannot be deleted', 409);
    }

    await pool.query('DELETE FROM email_campaigns WHERE id = $1', [req.params.id]);
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.email.campaign_deleted',
      entityType: 'email_campaign',
      entityId: campaign.id,
      summary: `Deleted campaign "${campaign.name}" (${campaign.status})`,
    });
    sendSuccess(res, { id: Number(req.params.id) }, 'Campaign deleted');
  } catch (err) {
    console.error('campaign delete error:', err);
    sendError(res, err, 'Failed to delete this campaign', 500);
  }
});

// ── Unsubscribes ─────────────────────────────────────────────────────────────

router.get('/unsubscribes', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, reason, source, unsubscribed_at FROM email_unsubscribes ORDER BY unsubscribed_at DESC LIMIT 500'
    );
    sendSuccess(
      res,
      {
        unsubscribes: rows,
        total: rows.length,
        note: 'Marketing only. Booking confirmations, vouchers and trip reminders are still sent — the guest paid for those.',
      },
      'Unsubscribes retrieved'
    );
  } catch (err) {
    console.error('unsubscribes error:', err);
    sendError(res, err, 'Failed to load the suppression list', 500);
  }
});

router.post(
  '/unsubscribes',
  adminAuth,
  body('email').trim().isEmail().withMessage('Give a valid email address'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      await tpl.unsubscribe(req.body.email, { reason: req.body.reason || 'Added by admin', source: 'admin' });
      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.email.unsubscribed',
        entityType: 'email',
        summary: `${req.body.email} suppressed from marketing`,
      });
      sendSuccess(res, { email: req.body.email }, 'Address suppressed from marketing');
    } catch (err) {
      console.error('unsubscribe add error:', err);
      sendError(res, err, 'Failed to suppress this address', 500);
    }
  }
);

router.delete('/unsubscribes/:email', adminAuth, async (req, res) => {
  try {
    const removed = await tpl.resubscribe(req.params.email);
    if (!removed) return sendError(res, null, 'That address is not on the list', 404);

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.email.resubscribed',
      entityType: 'email',
      summary: `${req.params.email} removed from the suppression list`,
    });
    sendSuccess(res, { email: req.params.email }, 'Address removed from the suppression list');
  } catch (err) {
    console.error('resubscribe error:', err);
    sendError(res, err, 'Failed to update the suppression list', 500);
  }
});

module.exports = router;
