/**
 * Reports & exports.
 *
 * One report definition drives the preview, the CSV, the PDF and the scheduled
 * email. A preview showing 12 rows and a file containing 40 would make every
 * report untrustworthy, so they all call the same `runReport`.
 *
 * Two safeguards worth keeping:
 *
 *  - **Everything is capped.** A preview asks for 25 rows, an export for
 *    REPORT_MAX_ROWS, and there is no way to ask for "all". The response says
 *    when rows were left out rather than letting somebody believe they have the
 *    whole set.
 *
 *  - **Every export is logged.** These files carry names, emails and payment
 *    references, so "who took a copy and when" has to have an answer.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const reports = require('../../services/reportDatasets');
const output = require('../../services/reportOutput');
const docSettings = require('../../services/documentSettings');
const schedules = require('../../services/reportSchedules');

const router = express.Router();
const num = (v) => Number(v || 0);

function invalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, null, errors.array()[0].msg, 400);
  return true;
}

/** Turn a request body into the shape `runReport` expects. */
function specFrom(source, overrides = {}) {
  return {
    dataset: source.dataset,
    columns: source.columns,
    filters: source.filters || {},
    search: source.search || '',
    dateRange: source.dateRange || source.date_range || 'last30',
    dateFrom: source.dateFrom || source.date_from || null,
    dateTo: source.dateTo || source.date_to || null,
    sort: source.sort,
    ...overrides,
  };
}

async function logExport(req, { dataset, format, rowCount, filters, reportId = null, deliveredTo = null }) {
  try {
    await pool.query(
      `INSERT INTO export_log (dataset, report_id, format, row_count, filters, admin_id, delivered_to, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        dataset,
        reportId,
        format,
        rowCount,
        JSON.stringify(filters || {}),
        req.admin?.id || null,
        deliveredTo,
        req.ip || null,
      ]
    );
  } catch (err) {
    console.error('[reports] could not log export:', err.message);
  }
}

// ── Builder options ──────────────────────────────────────────────────────────

router.get('/datasets', adminAuth, (req, res) =>
  sendSuccess(
    res,
    {
      datasets: reports.describeDatasets(),
      ranges: reports.RANGES,
      maxRows: reports.MAX_ROWS,
      previewRows: reports.PREVIEW_ROWS,
      note: `Exports are capped at ${reports.MAX_ROWS.toLocaleString('en-GB')} rows. A report is for reading, not for copying the database.`,
    },
    'Report options retrieved'
  )
);

// ── Preview ──────────────────────────────────────────────────────────────────

router.post('/preview', adminAuth, async (req, res) => {
  try {
    const result = await reports.runReport(specFrom(req.body, { limit: reports.PREVIEW_ROWS }));
    sendSuccess(res, result, 'Preview ready');
  } catch (err) {
    console.error('report preview error:', err);
    sendError(res, err, 'Could not run that report', 500);
  }
});

// ── Export ───────────────────────────────────────────────────────────────────

router.post('/export', adminAuth, async (req, res) => {
  try {
    const spec = specFrom(req.body, { limit: reports.MAX_ROWS });
    const result = await reports.runReport(spec);

    await logExport(req, {
      dataset: result.dataset,
      format: 'csv',
      rowCount: result.returned,
      filters: spec.filters,
      reportId: req.body.reportId || null,
    });
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.report.exported',
      entityType: 'report',
      summary: `Exported ${result.returned} ${result.datasetLabel} row(s) — ${result.period}`,
      metadata: { dataset: result.dataset, rows: result.returned, format: 'csv' },
    });

    const filename = `${result.dataset}-${result.from || 'all'}-to-${result.to || 'now'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Report-Rows', String(result.returned));
    res.setHeader('X-Report-Total', String(result.total));
    res.setHeader('X-Report-Truncated', result.truncated ? 'true' : 'false');
    res.send(output.toCsv(result));
  } catch (err) {
    console.error('report export error:', err);
    if (!res.headersSent) sendError(res, err, 'Could not build that export', 500);
  }
});

router.post('/export/pdf', adminAuth, async (req, res) => {
  try {
    // The PDF is a summary, so it asks for fewer rows than the CSV on purpose.
    const spec = specFrom(req.body, { limit: Math.min(reports.MAX_ROWS, 500) });
    const result = await reports.runReport(spec);
    const settings = await docSettings.getSettings();

    await logExport(req, {
      dataset: result.dataset,
      format: 'pdf',
      rowCount: result.returned,
      filters: spec.filters,
      reportId: req.body.reportId || null,
    });
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.report.exported',
      entityType: 'report',
      summary: `Printed ${result.returned} ${result.datasetLabel} row(s) — ${result.period}`,
      metadata: { dataset: result.dataset, rows: result.returned, format: 'pdf' },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.dataset}-${result.from || 'all'}.pdf"`
    );
    const doc = output.toPdf(result, {
      title: req.body.title || `${result.datasetLabel} report`,
      generatedBy: req.admin?.name || req.admin?.email,
      settings,
    });
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error('report pdf error:', err);
    if (!res.headersSent) sendError(res, err, 'Could not build that PDF', 500);
  }
});

// ── Saved reports ────────────────────────────────────────────────────────────

function shapeReport(row) {
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
    id: row.id,
    name: row.name,
    description: row.description,
    dataset: row.dataset,
    filters: parse(row.filters, {}),
    columns: parse(row.columns, []),
    dateRange: row.date_range,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scheduleCount: num(row.schedule_count),
    lastRunAt: row.last_run_at,
  };
}

router.get('/saved', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, COUNT(s.id) AS schedule_count, MAX(s.last_run_at) AS last_run_at
         FROM saved_reports r
         LEFT JOIN report_schedules s ON s.report_id = r.id
        GROUP BY r.id ORDER BY r.updated_at DESC`
    );
    sendSuccess(res, { reports: rows.map(shapeReport) }, 'Saved reports retrieved');
  } catch (err) {
    console.error('saved reports error:', err);
    sendError(res, err, 'Failed to load the saved reports', 500);
  }
});

router.post(
  '/saved',
  adminAuth,
  body('name').trim().isLength({ min: 3 }).withMessage('Give the report a name'),
  body('dataset').trim().notEmpty().withMessage('Pick a dataset'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      if (!reports.DATASETS[req.body.dataset]) {
        return sendError(res, null, 'That dataset does not exist', 400);
      }

      const result = await pool.query(
        `INSERT INTO saved_reports
           (name, description, dataset, filters, columns, date_range, date_from, date_to, sort, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          req.body.name,
          req.body.description || null,
          req.body.dataset,
          JSON.stringify(req.body.filters || {}),
          JSON.stringify(req.body.columns || []),
          req.body.dateRange || 'last30',
          req.body.dateRange === 'custom' ? req.body.dateFrom || null : null,
          req.body.dateRange === 'custom' ? req.body.dateTo || null : null,
          req.body.sort || null,
          req.admin.id,
        ]
      );

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.report.saved',
        entityType: 'report',
        entityId: result.insertId,
        summary: `Saved report "${req.body.name}"`,
      });

      sendSuccess(res, { id: result.insertId }, 'Report saved');
    } catch (err) {
      if (/duplicate/i.test(err.message)) {
        return sendError(res, null, 'A report with that name already exists', 409);
      }
      console.error('save report error:', err);
      sendError(res, err, 'Failed to save the report', 500);
    }
  }
);

router.put('/saved/:id', adminAuth, async (req, res) => {
  try {
    const updates = [];
    const params = [];
    const set = (column, value) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (req.body.name !== undefined) set('name', req.body.name);
    if (req.body.description !== undefined) set('description', req.body.description);
    if (req.body.filters !== undefined) set('filters', JSON.stringify(req.body.filters));
    if (req.body.columns !== undefined) set('columns', JSON.stringify(req.body.columns));
    if (req.body.dateRange !== undefined) {
      set('date_range', req.body.dateRange);
      set('date_from', req.body.dateRange === 'custom' ? req.body.dateFrom || null : null);
      set('date_to', req.body.dateRange === 'custom' ? req.body.dateTo || null : null);
    }
    if (req.body.sort !== undefined) set('sort', req.body.sort);

    if (!updates.length) return sendError(res, null, 'Nothing to update', 400);

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE saved_reports SET ${updates.join(', ')} WHERE id = $${params.length}`,
      params
    );
    if (!result.rowCount) return sendError(res, null, 'Report not found', 404);

    sendSuccess(res, { id: Number(req.params.id) }, 'Report updated');
  } catch (err) {
    console.error('update report error:', err);
    sendError(res, err, 'Failed to update the report', 500);
  }
});

router.delete('/saved/:id', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM saved_reports WHERE id = $1', [req.params.id]);
    if (!rows.length) return sendError(res, null, 'Report not found', 404);

    await pool.query('DELETE FROM saved_reports WHERE id = $1', [req.params.id]);
    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.report.deleted',
      entityType: 'report',
      entityId: rows[0].id,
      summary: `Deleted report "${rows[0].name}"`,
    });
    sendSuccess(res, { id: rows[0].id }, 'Report deleted');
  } catch (err) {
    console.error('delete report error:', err);
    sendError(res, err, 'Failed to delete the report', 500);
  }
});

/** Run a saved report now. Named ranges resolve against today, not the save date. */
router.post('/saved/:id/run', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM saved_reports WHERE id = $1', [req.params.id]);
    if (!rows.length) return sendError(res, null, 'Report not found', 404);

    const saved = shapeReport(rows[0]);
    const result = await reports.runReport(
      specFrom(saved, { limit: Number(req.body?.limit) || reports.PREVIEW_ROWS })
    );
    sendSuccess(res, { report: saved, result }, 'Report run');
  } catch (err) {
    console.error('run report error:', err);
    sendError(res, err, 'Could not run that report', 500);
  }
});

// ── Schedules ────────────────────────────────────────────────────────────────

router.get('/schedules', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, r.name AS report_name, r.dataset
         FROM report_schedules s JOIN saved_reports r ON r.id = s.report_id
        ORDER BY s.enabled DESC, s.next_run_at ASC`
    );
    sendSuccess(
      res,
      {
        schedules: rows.map((s) => ({
          ...s,
          enabled: Boolean(s.enabled),
          recipients: String(s.recipients || '').split(',').filter(Boolean),
        })),
        cadences: schedules.CADENCES,
      },
      'Schedules retrieved'
    );
  } catch (err) {
    console.error('schedules error:', err);
    sendError(res, err, 'Failed to load the schedules', 500);
  }
});

router.post(
  '/schedules',
  adminAuth,
  body('reportId').isInt({ min: 1 }).withMessage('Pick a saved report'),
  body('recipients').isArray({ min: 1 }).withMessage('Add at least one recipient'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const { rows } = await pool.query('SELECT id, name FROM saved_reports WHERE id = $1', [
        req.body.reportId,
      ]);
      if (!rows.length) return sendError(res, null, 'That saved report does not exist', 400);

      const recipients = req.body.recipients
        .map((r) => String(r).trim())
        .filter((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r));
      if (!recipients.length) {
        return sendError(res, null, 'None of those look like email addresses', 400);
      }

      const cadence = schedules.CADENCES.includes(req.body.cadence) ? req.body.cadence : 'weekly';
      const hour = Math.min(Math.max(parseInt(req.body.hourOfDay ?? 8, 10) || 8, 0), 23);
      const nextRun = schedules.nextRunAt({
        cadence,
        hour_of_day: hour,
        day_of_week: req.body.dayOfWeek,
        day_of_month: req.body.dayOfMonth,
      });

      const result = await pool.query(
        `INSERT INTO report_schedules
           (report_id, cadence, hour_of_day, day_of_week, day_of_month, recipients, format, enabled, next_run_at, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
        [
          req.body.reportId,
          cadence,
          hour,
          req.body.dayOfWeek ?? null,
          req.body.dayOfMonth ?? null,
          recipients.join(','),
          req.body.format === 'pdf' ? 'pdf' : 'csv',
          nextRun,
          req.admin.id,
        ]
      );

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.report.scheduled',
        entityType: 'report',
        entityId: req.body.reportId,
        summary: `Scheduled "${rows[0].name}" ${cadence} to ${recipients.join(', ')}`,
      });

      sendSuccess(res, { id: result.insertId, nextRunAt: nextRun }, 'Schedule created');
    } catch (err) {
      console.error('create schedule error:', err);
      sendError(res, err, 'Failed to create the schedule', 500);
    }
  }
);

router.patch('/schedules/:id', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM report_schedules WHERE id = $1', [req.params.id]);
    if (!rows.length) return sendError(res, null, 'Schedule not found', 404);

    if (req.body.enabled === undefined) return sendError(res, null, 'Nothing to update', 400);

    const enabled = req.body.enabled ? 1 : 0;
    // Re-arming a disabled schedule needs a fresh next_run_at, or it would fire
    // immediately for every run it "missed" while switched off.
    const nextRun = enabled ? schedules.nextRunAt(rows[0]) : null;
    await pool.query('UPDATE report_schedules SET enabled = $1, next_run_at = $2 WHERE id = $3', [
      enabled,
      nextRun,
      req.params.id,
    ]);

    sendSuccess(
      res,
      { id: Number(req.params.id), enabled: Boolean(enabled), nextRunAt: nextRun },
      enabled ? 'Schedule switched on' : 'Schedule switched off'
    );
  } catch (err) {
    console.error('update schedule error:', err);
    sendError(res, err, 'Failed to update the schedule', 500);
  }
});

router.delete('/schedules/:id', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM report_schedules WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return sendError(res, null, 'Schedule not found', 404);
    sendSuccess(res, { id: Number(req.params.id) }, 'Schedule deleted');
  } catch (err) {
    console.error('delete schedule error:', err);
    sendError(res, err, 'Failed to delete the schedule', 500);
  }
});

/** Send one now, so a schedule can be proved before anybody waits a week for it. */
router.post('/schedules/:id/run', adminAuth, async (req, res) => {
  try {
    const result = await schedules.runSchedule(req.params.id, { force: true });
    if (result.error) return sendError(res, null, result.error, 400);

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.report.schedule_test',
      entityType: 'report',
      entityId: Number(req.params.id),
      summary: `Sent scheduled report "${result.reportName}" on demand`,
      status: result.success ? 'success' : 'failed',
    });

    if (!result.success) return sendError(res, null, `Could not send: ${result.reason}`, 502);
    sendSuccess(res, result, `Sent to ${result.recipients.join(', ')}`);
  } catch (err) {
    console.error('run schedule error:', err);
    sendError(res, err, 'Failed to send that report', 500);
  }
});

// ── Export history ───────────────────────────────────────────────────────────

router.get('/history', adminAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const { rows } = await pool.query(
      `SELECT e.id, e.dataset, e.format, e.row_count, e.delivered_to, e.created_at,
              a.name AS admin_name, a.email AS admin_email, r.name AS report_name
         FROM export_log e
         LEFT JOIN admins a ON a.id = e.admin_id
         LEFT JOIN saved_reports r ON r.id = e.report_id
        ORDER BY e.created_at DESC LIMIT ${limit}`
    );

    const { rows: stats } = await pool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(row_count), 0) AS rows_exported,
              SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS last30
         FROM export_log`
    );

    sendSuccess(
      res,
      {
        exports: rows.map((e) => ({ ...e, row_count: num(e.row_count) })),
        stats: {
          total: num(stats[0]?.total),
          rowsExported: num(stats[0]?.rows_exported),
          last30: num(stats[0]?.last30),
        },
        note: 'Exports carry names, email addresses and payment references. This is the record of who took a copy.',
      },
      'Export history retrieved'
    );
  } catch (err) {
    console.error('export history error:', err);
    sendError(res, err, 'Failed to load the export history', 500);
  }
});

module.exports = router;
