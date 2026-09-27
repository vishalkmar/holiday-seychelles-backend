-- People who asked not to receive marketing.
--
-- Keyed on the email address, not on users.id, because most bookings are guest
-- checkouts with no account — an unsubscribe that only worked for registered
-- users would be no unsubscribe at all.
--
-- This suppresses MARKETING only. Booking confirmations, vouchers, payment
-- reminders and trip reminders are transactional: the guest asked for them by
-- buying something, and withholding one would leave someone standing at a jetty
-- without a voucher. services/emailTemplates.js enforces that split.
CREATE TABLE IF NOT EXISTS email_unsubscribes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(190) NOT NULL,
    reason VARCHAR(255),
    source VARCHAR(20) NOT NULL DEFAULT 'link',
    unsubscribed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_email_unsubscribe (email)
);
