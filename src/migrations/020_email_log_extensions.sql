-- The email log grew a purpose beyond de-duplicating the morning sweep: it is
-- now the record an operator reads when a guest says "I never got it".
--
-- To answer that it has to say what was actually sent (subject), which wording
-- produced it (template_key) and whether it was part of a bulk send
-- (campaign_id). `message_id` is what the provider returned, which is the only
-- thing worth quoting to Brevo support.
ALTER TABLE email_notifications
    ADD COLUMN subject VARCHAR(255) AFTER recipient,
    ADD COLUMN template_key VARCHAR(60) AFTER subject,
    ADD COLUMN campaign_id BIGINT AFTER template_key,
    ADD COLUMN message_id VARCHAR(190) AFTER campaign_id,
    ADD COLUMN body_html MEDIUMTEXT AFTER message_id,
    ADD COLUMN resent_from BIGINT AFTER body_html,
    ADD INDEX idx_email_notifications_campaign (campaign_id),
    ADD INDEX idx_email_notifications_recipient (recipient),
    ADD INDEX idx_email_notifications_status (status);
