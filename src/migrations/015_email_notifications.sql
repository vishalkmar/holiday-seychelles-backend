-- Outbound customer emails, one row per email we have actually sent.
--
-- The scheduled jobs run every morning and re-scan the same bookings, so the
-- only thing stopping a guest getting the same reminder every day is this log.
-- The unique keys are what make the jobs idempotent - MySQL treats NULLs as
-- distinct, and each kind keys off exactly one of booking_id / payment_order_id,
-- so the two indexes never fight each other.
CREATE TABLE IF NOT EXISTS email_notifications (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    kind VARCHAR(40) NOT NULL,
    booking_id BIGINT,
    payment_order_id BIGINT,
    recipient VARCHAR(190) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'sent',
    error TEXT,
    sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_email_notifications_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    CONSTRAINT fk_email_notifications_order FOREIGN KEY (payment_order_id) REFERENCES payment_orders(id) ON DELETE CASCADE,
    UNIQUE KEY uniq_email_booking_kind (kind, booking_id),
    UNIQUE KEY uniq_email_order_kind (kind, payment_order_id),
    INDEX idx_email_notifications_kind (kind),
    INDEX idx_email_notifications_sent (sent_at)
);
