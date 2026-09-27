-- A bulk or scheduled send.
--
-- The recipient list is NOT stored as a list. It is stored as the segment that
-- describes it (`segment` JSON) and resolved at send time, so a campaign
-- scheduled for next Tuesday reaches the people who match next Tuesday rather
-- than a snapshot taken today. The per-recipient outcome lives in
-- email_notifications with this campaign's id.
--
-- Status moves draft -> scheduled -> sending -> sent, or -> failed / cancelled.
-- `sending` is claimed with a conditional UPDATE so two workers (or a scheduler
-- racing a manual "send now") cannot both send the same campaign.
CREATE TABLE IF NOT EXISTS email_campaigns (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(160) NOT NULL,
    template_key VARCHAR(60) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    heading VARCHAR(200),
    message_html MEDIUMTEXT,
    cta_label VARCHAR(80),
    cta_url VARCHAR(400),
    segment JSON,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    scheduled_for DATETIME,
    recipients_total INT NOT NULL DEFAULT 0,
    sent_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    skipped_count INT NOT NULL DEFAULT 0,
    error TEXT,
    created_by BIGINT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME,

    INDEX idx_email_campaigns_status (status),
    INDEX idx_email_campaigns_scheduled (scheduled_for)
);
