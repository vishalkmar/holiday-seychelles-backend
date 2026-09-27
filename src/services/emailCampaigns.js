/**
 * Bulk and scheduled sends.
 *
 * Three things here are deliberate:
 *
 *  1. **A campaign is claimed before it is sent.** The status moves to
 *     `sending` with a conditional UPDATE, and only the caller whose UPDATE
 *     matched a row goes on to send. Otherwise the five-minute scheduler and an
 *     operator pressing "Send now" would both send the same campaign.
 *
 *  2. **Recipients are resolved at send time**, from the stored segment. A
 *     campaign scheduled for Tuesday reaches whoever matches on Tuesday, which
 *     is the only way an occasion campaign ("whose birthday is today") can work.
 *
 *  3. **Sending is paced.** This database is unhappy about bursts and the mail
 *     provider rate-limits, so recipients go out through `runLimited` with a
 *     small concurrency rather than a `Promise.all` over the whole list.
 */

const cron = require('node-cron');
const { pool } = require('../config/db');
const { runLimited } = require('../utils/concurrency');
const { resolveSegment, describe } = require('./emailSegments');
const { getTemplate, sendTemplate } = require('./emailTemplates');

/** Small on purpose — see note 3 above. */
const SEND_CONCURRENCY = Number(process.env.EMAIL_SEND_CONCURRENCY || 3);

function parseSegment(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function shape(row) {
  if (!row) return null;
  const segment = parseSegment(row.segment);
  return {
    id: row.id,
    name: row.name,
    templateKey: row.template_key,
    subject: row.subject,
    heading: row.heading,
    messageHtml: row.message_html,
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_url,
    segment,
    segmentDescription: describe(segment),
    status: row.status,
    scheduledFor: row.scheduled_for,
    recipientsTotal: Number(row.recipients_total || 0),
    sentCount: Number(row.sent_count || 0),
    failedCount: Number(row.failed_count || 0),
    skippedCount: Number(row.skipped_count || 0),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

async function getCampaign(id) {
  const { rows } = await pool.query('SELECT * FROM email_campaigns WHERE id = $1', [id]);
  return shape(rows[0]);
}

/**
 * Take exclusive ownership of a campaign before sending it.
 *
 * Returns the campaign if this caller won, null if somebody else already has
 * it. The WHERE clause is the lock; there is no separate flag to get wrong.
 */
async function claim(id) {
  const result = await pool.query(
    `UPDATE email_campaigns
        SET status = 'sending', started_at = NOW(), error = NULL,
            sent_count = 0, failed_count = 0, skipped_count = 0
      WHERE id = $1 AND status IN ('draft', 'scheduled')`,
    [id]
  );
  if (!result.rowCount) return null;
  return getCampaign(id);
}

/**
 * Send one campaign. Never throws — a campaign that dies mid-flight records the
 * reason on its own row, because the operator's only window into it is that row.
 */
async function runCampaign(id) {
  const campaign = await claim(id);
  if (!campaign) return { claimed: false };

  try {
    const template = await getTemplate(campaign.templateKey);
    if (!template) throw new Error(`Template "${campaign.templateKey}" no longer exists`);

    const recipients = await resolveSegment(campaign.segment);
    await pool.query('UPDATE email_campaigns SET recipients_total = $1 WHERE id = $2', [
      recipients.length,
      id,
    ]);

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    await runLimited(
      recipients.map((person) => async () => {
        const outcome = await sendTemplate({
          template,
          key: template.key,
          kind: 'campaign',
          to: person.email,
          campaignId: id,
          vars: {
            guest_name: person.name || 'there',
            subject: campaign.subject,
            heading: campaign.heading || campaign.subject,
            message_html: campaign.messageHtml || '',
            cta_label: campaign.ctaLabel,
          },
        });
        if (outcome.success) sent += 1;
        else if (outcome.skipped) skipped += 1;
        else failed += 1;
      }),
      SEND_CONCURRENCY
    );

    await pool.query(
      `UPDATE email_campaigns
          SET status = 'sent', sent_count = $1, failed_count = $2, skipped_count = $3,
              finished_at = NOW()
        WHERE id = $4`,
      [sent, failed, skipped, id]
    );

    console.log(
      `[campaigns] "${campaign.name}": ${sent} sent, ${failed} failed, ${skipped} skipped of ${recipients.length}`
    );
    return { claimed: true, sent, failed, skipped, total: recipients.length };
  } catch (err) {
    console.error(`[campaigns] campaign ${id} failed:`, err.message);
    await pool
      .query(
        "UPDATE email_campaigns SET status = 'failed', error = $1, finished_at = NOW() WHERE id = $2",
        [err.message, id]
      )
      .catch(() => {});
    return { claimed: true, error: err.message };
  }
}

/** Anything scheduled for a time that has now passed. */
async function runDueCampaigns() {
  const { rows } = await pool.query(
    `SELECT id FROM email_campaigns
      WHERE status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW()
      ORDER BY scheduled_for ASC LIMIT 5`
  );
  const results = [];
  for (const row of rows) {
    results.push({ id: row.id, ...(await runCampaign(row.id)) });
  }
  return results;
}

/**
 * Check for due campaigns every five minutes.
 *
 * Five minutes rather than every minute because a marketing email is not
 * time-critical to the minute, and each tick is a query against a database that
 * dislikes chatter.
 */
function startCampaignScheduler() {
  if (String(process.env.CAMPAIGNS_ENABLED || 'true').toLowerCase() !== 'true') {
    console.log('[campaigns] scheduler disabled (CAMPAIGNS_ENABLED=false)');
    return null;
  }

  const expression = process.env.CAMPAIGNS_CRON || '*/5 * * * *';
  if (!cron.validate(expression)) {
    console.error(`[campaigns] invalid CAMPAIGNS_CRON "${expression}" - scheduler not started`);
    return null;
  }

  const task = cron.schedule(expression, async () => {
    try {
      await runDueCampaigns();
    } catch (err) {
      console.error('[campaigns] scheduler tick failed:', err.message);
    }
  });
  console.log(`[campaigns] scheduled "${expression}"`);
  return task;
}

module.exports = {
  shape,
  parseSegment,
  getCampaign,
  claim,
  runCampaign,
  runDueCampaigns,
  startCampaignScheduler,
};
