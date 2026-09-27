/**
 * Scheduled customer emails.
 *
 * Runs once every morning and sweeps the database for anything that should be
 * emailed today. The jobs are deliberately written as "what is true today?"
 * queries rather than "what changed since last run?", so a missed run (server
 * restart, deploy, outage) simply catches up on the next one.
 *
 * Every send is recorded in `email_notifications` BEFORE the guest is emailed
 * again on a later sweep - the unique key on (kind, booking_id) /
 * (kind, payment_order_id) is what stops a daily job turning into daily spam.
 */

const cron = require('node-cron');
const { pool } = require('../config/db');
const {
  sendPendingPaymentEmail,
  sendTripReminderEmail,
  sendPostStayEmail,
} = require('../utils/lifecycleEmails');
const { getTemplate, sendTemplate, logEmail } = require('./emailTemplates');
const {
  fmtDate,
  money,
  guestName,
  frontendUrl,
  detailTable,
  referenceBlock,
} = require('../utils/emailLayout');

const KIND = {
  PENDING: 'payment_pending',
  REMIND_2D: 'trip_reminder_2d',
  TODAY: 'trip_today',
  POST_STAY: 'post_stay',
};

/** Leave an abandoned checkout alone for a bit - they may still be paying. */
const PENDING_AFTER_HOURS = Number(process.env.PENDING_REMINDER_AFTER_HOURS || 2);
/** ...and stop chasing after this long. */
const PENDING_UNTIL_DAYS = Number(process.env.PENDING_REMINDER_UNTIL_DAYS || 7);

/**
 * The key that makes a sweep idempotent.
 *
 * It is a column with a unique index rather than a SELECT-then-INSERT, so two
 * runs starting at the same moment cannot both decide the email has not been
 * sent. Manual sends leave it NULL and are never de-duplicated.
 */
function dedupeKeyFor(kind, { bookingId = null, orderId = null }) {
  return bookingId ? `${kind}:b${bookingId}` : `${kind}:o${orderId}`;
}

async function alreadySent(kind, key) {
  const { rows } = await pool.query(
    'SELECT id FROM email_notifications WHERE dedupe_key = $1 LIMIT 1',
    [dedupeKeyFor(kind, key)]
  );
  return rows.length > 0;
}

async function record(kind, { bookingId = null, orderId = null, recipient, result }) {
  await logEmail({
    kind,
    dedupeKey: dedupeKeyFor(kind, { bookingId, orderId }),
    bookingId,
    orderId,
    recipient,
    result,
  });
}

/**
 * The variables an editable template can use, per kind.
 *
 * `_block` and `_table` values are composed HTML - the renderer inserts them
 * raw. Everything else is plain text and gets escaped on the way in.
 */
function varsFor(kind, row) {
  if (kind === KIND.PENDING) {
    const resumeUrl = `${frontendUrl()}/dashboard?tab=transactions&resume=${encodeURIComponent(
      row.order_reference
    )}`;
    return {
      guest_name: guestName(row),
      product_title: row.product_title || 'your trip',
      order_reference: row.order_reference,
      amount: money(row.amount, row.currency),
      travel_date: fmtDate(row.check_in_date || row.travel_date),
      resume_url: resumeUrl,
      reference_block: referenceBlock('Order reference', row.order_reference, '#D97706'),
      details_table: detailTable([
        ['Item', row.product_title],
        ['Travel date', fmtDate(row.check_in_date || row.travel_date)],
        ['Amount', money(row.amount, row.currency)],
      ]),
    };
  }

  const isToday = kind === KIND.TODAY;
  const when = fmtDate(row.check_in_date || row.travel_date);

  if (kind === KIND.POST_STAY) {
    return {
      guest_name: guestName(row),
      product_title: row.product_title || 'your stay',
      booking_reference: row.booking_reference,
      stayed: `${fmtDate(row.check_in_date) || ''}${
        row.check_out_date ? ' → ' + fmtDate(row.check_out_date) : ''
      }`.trim(),
      feedback_url: `${frontendUrl()}/dashboard?tab=queries`,
      reference_block: referenceBlock('Booking reference', row.booking_reference, '#059669'),
      details_table: detailTable([
        ['Item', row.product_title],
        [
          'Stayed',
          `${fmtDate(row.check_in_date) || ''}${
            row.check_out_date ? ' → ' + fmtDate(row.check_out_date) : ''
          }`,
        ],
      ]),
    };
  }

  return {
    guest_name: guestName(row),
    product_title: row.product_title || 'your trip',
    booking_reference: row.booking_reference,
    check_in: when,
    check_out: fmtDate(row.check_out_date),
    travellers: row.total_travellers,
    dashboard_url: `${frontendUrl()}/dashboard?tab=trips`,
    reference_block: referenceBlock('Booking reference', row.booking_reference),
    details_table: detailTable([
      ['Item', row.product_title],
      [isToday ? 'Starts' : 'Check-in', when],
      ['Check-out', fmtDate(row.check_out_date)],
      ['Travellers', row.total_travellers],
      ['Supplier reference', row.supplier_reference],
    ]),
  };
}

/**
 * Run one job: fetch candidates, skip anything already emailed, send, log.
 * Returns a small summary so the caller (and tests) can see what happened.
 *
 * Wording comes from `email_templates` when a row for this kind exists. A row
 * that is switched off stops the whole kind - that is the admin panel's
 * "automated emails" toggle, and it has to be checked before any candidate is
 * sent, not per guest. No row at all falls back to the version coded in
 * lifecycleEmails.js, so a template that was never seeded is not an outage.
 */
async function runJob({ kind, rows, idOf, send, isOrder = false }) {
  const summary = { kind, candidates: rows.length, sent: 0, skipped: 0, failed: 0 };

  const template = await getTemplate(kind).catch(() => null);
  if (template && !template.enabled) {
    summary.skipped = rows.length;
    summary.disabled = true;
    return summary;
  }

  for (const row of rows) {
    const id = idOf(row);
    const key = isOrder ? { orderId: id } : { bookingId: id };

    if (!row.lead_email) {
      summary.skipped += 1;
      continue;
    }
    if (await alreadySent(kind, key)) {
      summary.skipped += 1;
      continue;
    }

    if (template) {
      const outcome = await sendTemplate({
        template,
        key: kind,
        kind,
        to: row.lead_email,
        vars: varsFor(kind, row),
        dedupeKey: dedupeKeyFor(kind, key),
        bookingId: key.bookingId || null,
        orderId: key.orderId || null,
      });
      if (outcome.success) summary.sent += 1;
      else if (outcome.skipped) summary.skipped += 1;
      else summary.failed += 1;
      continue;
    }

    const result = await send(row);
    await record(kind, { ...key, recipient: row.lead_email, result });
    if (result.success) summary.sent += 1;
    else summary.failed += 1;
  }

  return summary;
}

// ── The four sweeps ──────────────────────────────────────────────────────────

/** Checkouts that were started but never paid. */
async function pendingPaymentReminders() {
  const { rows } = await pool.query(
    `SELECT id, order_reference, amount, currency, lead_first_name, lead_last_name,
            lead_email, product_title, check_in_date, travel_date
       FROM payment_orders
      WHERE status IN ('created', 'redirected')
        AND created_at <= DATE_SUB(NOW(), INTERVAL ${PENDING_AFTER_HOURS} HOUR)
        AND created_at >= DATE_SUB(NOW(), INTERVAL ${PENDING_UNTIL_DAYS} DAY)`
  );

  return runJob({
    kind: KIND.PENDING,
    rows,
    isOrder: true,
    idOf: (r) => r.id,
    send: (r) => sendPendingPaymentEmail(r),
  });
}

/** Paid bookings whose start date is `offsetDays` away. */
async function tripReminders(offsetDays, kind) {
  const { rows } = await pool.query(
    `SELECT id, booking_reference, lead_first_name, lead_last_name, lead_email,
            product_title, check_in_date, check_out_date, travel_date,
            total_travellers, supplier_reference
       FROM bookings
      WHERE payment_status = 'paid'
        AND status NOT IN ('cancelled', 'refunded')
        AND DATE(COALESCE(check_in_date, travel_date)) = DATE(DATE_ADD(CURDATE(), INTERVAL ${offsetDays} DAY))`
  );

  return runJob({
    kind,
    rows,
    idOf: (r) => r.id,
    send: (r) => sendTripReminderEmail(r, { daysToGo: offsetDays }),
  });
}

/** The day after the stay ends. */
async function postStayThankYous() {
  const { rows } = await pool.query(
    `SELECT id, booking_reference, lead_first_name, lead_last_name, lead_email,
            product_title, check_in_date, check_out_date, travel_date
       FROM bookings
      WHERE payment_status = 'paid'
        AND status NOT IN ('cancelled', 'refunded')
        AND DATE(COALESCE(check_out_date, check_in_date, travel_date)) = DATE(DATE_SUB(CURDATE(), INTERVAL 1 DAY))`
  );

  return runJob({
    kind: KIND.POST_STAY,
    rows,
    idOf: (r) => r.id,
    send: (r) => sendPostStayEmail(r),
  });
}

/** One morning sweep. Exported so it can be triggered manually. */
async function runDailySweep() {
  const started = Date.now();
  const results = [];

  for (const [label, job] of [
    ['pending payments', pendingPaymentReminders],
    ['trip in 2 days', () => tripReminders(2, KIND.REMIND_2D)],
    ['trip today', () => tripReminders(0, KIND.TODAY)],
    ['post stay', postStayThankYous],
  ]) {
    try {
      const summary = await job();
      results.push(summary);
      console.log(
        `[notifications] ${label}: ${summary.sent} sent, ${summary.skipped} skipped, ${summary.failed} failed (of ${summary.candidates})`
      );
    } catch (err) {
      console.error(`[notifications] ${label} job failed:`, err.message);
      results.push({ kind: label, error: err.message });
    }
  }

  console.log(`[notifications] sweep finished in ${Date.now() - started}ms`);
  return results;
}

/**
 * Register the morning schedule.
 *
 * Default 08:00 in Seychelles time, since that is the guest's local morning for
 * a trip reminder. Override with NOTIFICATIONS_CRON / NOTIFICATIONS_TZ.
 */
function startScheduler() {
  if (String(process.env.NOTIFICATIONS_ENABLED || 'true').toLowerCase() !== 'true') {
    console.log('[notifications] scheduler disabled (NOTIFICATIONS_ENABLED=false)');
    return null;
  }

  const expression = process.env.NOTIFICATIONS_CRON || '0 8 * * *';
  const timezone = process.env.NOTIFICATIONS_TZ || 'Indian/Mahe';

  if (!cron.validate(expression)) {
    console.error(`[notifications] invalid NOTIFICATIONS_CRON "${expression}" - scheduler not started`);
    return null;
  }

  const task = cron.schedule(expression, runDailySweep, { timezone });
  console.log(`[notifications] scheduled "${expression}" (${timezone})`);
  return task;
}

module.exports = {
  startScheduler,
  runDailySweep,
  pendingPaymentReminders,
  tripReminders,
  postStayThankYous,
  dedupeKeyFor,
  varsFor,
  KIND,
};
