-- Saved report definitions, their schedules, and a log of what was exported.
--
-- A report stores a DEFINITION, never its rows. Re-running "last month's paid
-- bookings" must read the database as it is today; a cached result set would
-- quietly become a lie the moment a booking was refunded.
CREATE TABLE IF NOT EXISTS saved_reports (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(160) NOT NULL,
    description VARCHAR(400),
    dataset VARCHAR(40) NOT NULL,
    -- Filters and the chosen columns, as the builder produced them.
    filters JSON,
    columns JSON,
    -- 'custom' keeps the literal dates; the named ranges are resolved at run
    -- time, so a scheduled "last 30 days" always means the last 30 days.
    date_range VARCHAR(20) NOT NULL DEFAULT 'last30',
    date_from DATE,
    date_to DATE,
    sort VARCHAR(40),
    created_by_admin_id BIGINT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_saved_report_name (name),
    INDEX idx_saved_reports_dataset (dataset)
);

-- A saved report that emails itself on a cadence.
--
-- `next_run_at` is stored rather than recomputed from a cron string on every
-- tick, and is claimed with a conditional UPDATE so two ticks cannot both send
-- the same report.
CREATE TABLE IF NOT EXISTS report_schedules (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    report_id BIGINT NOT NULL,
    cadence VARCHAR(20) NOT NULL DEFAULT 'weekly',
    hour_of_day TINYINT NOT NULL DEFAULT 8,
    day_of_week TINYINT,
    day_of_month TINYINT,
    recipients VARCHAR(500) NOT NULL,
    format VARCHAR(10) NOT NULL DEFAULT 'csv',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    next_run_at DATETIME,
    last_run_at DATETIME,
    last_status VARCHAR(20),
    last_error TEXT,
    created_by_admin_id BIGINT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_report_schedules_report FOREIGN KEY (report_id) REFERENCES saved_reports(id) ON DELETE CASCADE,
    INDEX idx_report_schedules_next (enabled, next_run_at)
);

-- Every export that left the building: who, what, how many rows.
--
-- Exports carry customer names, emails and payment references, so "who took a
-- copy of this and when" is a question that has to have an answer.
CREATE TABLE IF NOT EXISTS export_log (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    dataset VARCHAR(40) NOT NULL,
    report_id BIGINT,
    schedule_id BIGINT,
    format VARCHAR(10) NOT NULL DEFAULT 'csv',
    row_count INT NOT NULL DEFAULT 0,
    filters JSON,
    admin_id BIGINT,
    delivered_to VARCHAR(500),
    ip_address VARCHAR(64),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_export_log_report FOREIGN KEY (report_id) REFERENCES saved_reports(id) ON DELETE SET NULL,
    INDEX idx_export_log_created (created_at),
    INDEX idx_export_log_admin (admin_id),
    INDEX idx_export_log_dataset (dataset)
);

-- The email a scheduled report arrives in.
INSERT IGNORE INTO email_templates
    (template_key, name, description, category, subject, subheading, heading, body_html, cta_label, cta_url, accent, variables, is_automated, is_marketing, enabled)
VALUES
(
    'scheduled_report',
    'Scheduled report',
    'Sent when a saved report runs on its schedule. The data is attached as a file.',
    'transactional',
    '{{report_name}} — {{period}}',
    'Scheduled report',
    '{{report_name}}',
    '<p style="margin:0 0 16px; font-size:15px; color:#061B3A;">Here is your scheduled report.</p>\n{{summary_table}}\n<p style="margin:18px 0 0; font-size:13px; color:#64748b;">The full data is attached. This report was generated from the live database at the time it was sent.</p>',
    NULL,
    NULL,
    '#2563EB',
    '["report_name","period","row_count","summary_table"]',
    1, 0, 1
);
