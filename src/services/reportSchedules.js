/**
 * Reports that email themselves.
 *
 * `next_run_at` is stored on the row and claimed with a conditional UPDATE, so
 * a tick that overlaps another cannot send the same report twice. The next time
 * is computed forward from now rather than by adding an interval to the last
 * run — a schedule that was switched off for a month must not fire thirty times
 * when it comes back.
 */

const cron = require('node-cron');
const { pool } = require('../config/db');
const reports = require('./reportDatasets');
const output = require('./reportOutput');
const { getTransporter } = require('../config/mailer');
const { getTemplate, renderTemplate, logEmail } = require('./emailTemplates');
const { fromAddress, detailTable } = require('../utils/emailLayout');

const CADENCES = ['daily', 'weekly', 'monthly'];

/** The next time this schedule should fire, always in the future. */
function nextRunAt(schedule, after = new Date()) {
  const hour = Math.min(Math.max(Number(schedule.hour_of_day ?? 8), 0), 23);
  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setHours(hour, 0);

  if (schedule.cadence === 'daily') {
    if (next <= after) next.setDate(next.getDate() + 1);
    return next;
  }

  if (schedule.cadence === 'monthly') {
    const day = Math.min(Math.max(Number(schedule.day_of_month ?? 1), 1), 28);
    next.setDate(day);
    if (next <= after) next.setMonth(next.getMonth() + 1);
    return next;
  }

  // weekly
  const target = Math.min(Math.max(Number(schedule.day_of_week ?? 1), 0), 6);
  const delta = (target - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + delta);
  if (next <= after) next.setDate(next.getDate() + 7);
  return next;
}

function shapeSaved(row) {
  const parse = (v, fallback) => {
    if (!v) return fallback;
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  };
  return {
    dataset: row.dataset,
    filters: parse(row.filters, {}),
    columns: parse(row.columns, []),
    dateRange: row.date_range,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    sort: row.sort,
  };
}

/**
 * Run one schedule and email it.
 *
 * `force` is for the "send now" button and skips the claim, because an operator
 * pressing it has already decided. The scheduled path always claims first.
 */
async function runSchedule(id, { force = false } = {}) {
  const { rows } = await pool.query(
    `SELECT s.*, r.name AS report_name, r.dataset, r.filters, r.columns,
            r.date_range, r.date_from, r.date_to, r.sort
       FROM report_schedules s JOIN saved_reports r ON r.id = s.report_id
      WHERE s.id = $1`,
    [id]
  );
  if (!rows.length) return { error: 'That schedule no longer exists' };
  const schedule = rows[0];

  if (!force) {
    // The claim: only the caller whose UPDATE matched a row goes on to send.
    const claimed = await pool.query(
      `UPDATE report_schedules SET next_run_at = $1
        WHERE id = $2 AND next_run_at IS NOT NULL AND next_run_at <= NOW()`,
      [nextRunAt(schedule), id]
    );
    if (!claimed.rowCount) return { claimed: false };
  }

  const recipients = String(schedule.recipients || '').split(',').filter(Boolean);
  if (!recipients.length) return { error: 'This schedule has no recipients' };

  try {
    const result = await reports.runReport({
      ...shapeSaved(schedule),
      limit: schedule.format === 'pdf' ? Math.min(reports.MAX_ROWS, 500) : reports.MAX_ROWS,
    });

    const attachment =
      schedule.format === 'pdf'
        ? {
            filename: `${result.dataset}-${result.from || 'all'}.pdf`,
            content: await pdfBuffer(result, schedule.report_name),
            contentType: 'application/pdf',
          }
        : {
            filename: `${result.dataset}-${result.from || 'all'}.csv`,
            content: Buffer.from(output.toCsv(result), 'utf8'),
            contentType: 'text/csv',
          };

    const summaryRows = [
      ['Rows', `${result.returned}${result.truncated ? ` of ${result.total}` : ''}`],
      ...result.totals.map((t) => [
        t.label,
        t.money ? `EUR ${Number(t.value).toFixed(2)}` : Number(t.value).toLocaleString('en-GB'),
      ]),
    ];

    const template = await getTemplate('scheduled_report');
    const vars = {
      report_name: schedule.report_name,
      period: result.period,
      row_count: result.returned,
      summary_table: detailTable(summaryRows),
    };

    const rendered = template
      ? renderTemplate(template, vars)
      : {
          subject: `${schedule.report_name} — ${result.period}`,
          html: `<p>${schedule.report_name}: ${result.returned} rows.</p>`,
          text: `${schedule.report_name}: ${result.returned} rows.`,
        };

    const transporter = getTransporter();
    let sendResult;
    try {
      const info = await transporter.sendMail({
        from: fromAddress(),
        to: recipients.join(','),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: [
          {
            filename: attachment.filename,
            content: attachment.content,
            contentType: attachment.contentType,
          },
        ],
      });
      sendResult = { success: true, messageId: info.messageId };
    } catch (err) {
      sendResult = { success: false, error: err.message };
    }

    for (const recipient of recipients) {
      await logEmail({
        kind: 'scheduled_report',
        recipient,
        subject: rendered.subject,
        templateKey: 'scheduled_report',
        result: sendResult,
      });
    }

    await pool.query(
      `INSERT INTO export_log (dataset, report_id, schedule_id, format, row_count, filters, delivered_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        result.dataset,
        schedule.report_id,
        schedule.id,
        schedule.format,
        result.returned,
        JSON.stringify(shapeSaved(schedule).filters),
        recipients.join(','),
      ]
    );

    await pool.query(
      `UPDATE report_schedules
          SET last_run_at = NOW(), last_status = $1, last_error = $2
        WHERE id = $3`,
      [sendResult.success ? 'sent' : 'failed', sendResult.success ? null : sendResult.error, id]
    );

    return {
      claimed: true,
      success: sendResult.success,
      reason: sendResult.error || null,
      reportName: schedule.report_name,
      recipients,
      rows: result.returned,
    };
  } catch (err) {
    console.error(`[reports] schedule ${id} failed:`, err.message);
    await pool
      .query(
        `UPDATE report_schedules SET last_run_at = NOW(), last_status = 'failed', last_error = $1 WHERE id = $2`,
        [err.message, id]
      )
      .catch(() => {});
    return { claimed: true, success: false, reason: err.message, reportName: schedule.report_name, recipients };
  }
}

function pdfBuffer(result, title) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = output.toPdf(result, { title });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function runDueSchedules() {
  const { rows } = await pool.query(
    `SELECT id FROM report_schedules
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= NOW()
      ORDER BY next_run_at ASC LIMIT 10`
  );
  const results = [];
  for (const row of rows) {
    results.push({ id: row.id, ...(await runSchedule(row.id)) });
  }
  return results;
}

function startReportScheduler() {
  if (String(process.env.REPORT_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'true') {
    console.log('[reports] scheduler disabled (REPORT_SCHEDULER_ENABLED=false)');
    return null;
  }

  const expression = process.env.REPORT_SCHEDULER_CRON || '*/10 * * * *';
  if (!cron.validate(expression)) {
    console.error(`[reports] invalid REPORT_SCHEDULER_CRON "${expression}" - scheduler not started`);
    return null;
  }

  const task = cron.schedule(expression, async () => {
    try {
      await runDueSchedules();
    } catch (err) {
      console.error('[reports] scheduler tick failed:', err.message);
    }
  });
  console.log(`[reports] scheduler running "${expression}"`);
  return task;
}

module.exports = { CADENCES, nextRunAt, runSchedule, runDueSchedules, startReportScheduler };
