-- Make "sent once automatically" and "sent again on purpose" two different things.
--
-- The old unique keys were (kind, booking_id) and (kind, payment_order_id).
-- They did their job - the morning sweep cannot spam a guest - but they also
-- made it impossible to log a deliberate resend of the same email, because the
-- second row collided with the first. An operator resending a failed reminder
-- would either get a duplicate-key error or an unlogged send.
--
-- The constraint now lives in one nullable column. Automated sends set
-- `dedupe_key` ('trip_today:b34') and stay protected against a double run;
-- manual sends, resends and campaign mail leave it NULL, and MySQL treats each
-- NULL as distinct, so any number of them can be logged.
ALTER TABLE email_notifications
    ADD COLUMN dedupe_key VARCHAR(80) AFTER kind;

UPDATE email_notifications
   SET dedupe_key = CONCAT(kind, ':b', booking_id)
 WHERE booking_id IS NOT NULL AND dedupe_key IS NULL;

UPDATE email_notifications
   SET dedupe_key = CONCAT(kind, ':o', payment_order_id)
 WHERE payment_order_id IS NOT NULL AND dedupe_key IS NULL;

ALTER TABLE email_notifications
    DROP INDEX uniq_email_booking_kind,
    DROP INDEX uniq_email_order_kind,
    ADD UNIQUE KEY uniq_email_dedupe (dedupe_key);
