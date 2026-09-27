-- Turn the query list into a support console.
--
-- `handled_by_admin_id` already existed, but it records who last ACTED on a
-- thread, which is not the same question as who OWNS it. Answering "what is
-- mine?" needs its own column, or every reply silently reassigns the thread to
-- whoever typed it.
ALTER TABLE queries
    ADD COLUMN assigned_to_admin_id BIGINT AFTER handled_by_admin_id,
    ADD COLUMN priority VARCHAR(10) NOT NULL DEFAULT 'normal' AFTER status,
    -- Stored rather than derived, because the useful figure is how long the
    -- customer waited at the time, and a thread whose first reply is later
    -- deleted must not silently improve the metric.
    ADD COLUMN first_response_at DATETIME AFTER handled_at,
    ADD COLUMN closed_at DATETIME AFTER first_response_at,
    ADD CONSTRAINT fk_queries_assigned FOREIGN KEY (assigned_to_admin_id) REFERENCES admins(id) ON DELETE SET NULL,
    ADD INDEX idx_queries_assigned (assigned_to_admin_id),
    ADD INDEX idx_queries_priority (priority);

-- An internal note is a message nobody outside this building ever sees. It is a
-- flag on the message rather than a new sender_type, because the existing CHECK
-- constraint pins sender_type to user/admin/system and a note is still written
-- by an admin.
ALTER TABLE query_messages
    ADD COLUMN is_internal TINYINT(1) NOT NULL DEFAULT 0 AFTER message,
    ADD INDEX idx_query_messages_internal (query_id, is_internal);

-- Backfill: the first admin reply on each thread is its first response, and a
-- thread already resolved or closed was closed when it was last handled. Without
-- this every existing thread would report "never answered".
UPDATE queries q
   SET q.first_response_at = (
       SELECT MIN(m.created_at) FROM query_messages m
        WHERE m.query_id = q.id AND m.sender_type = 'admin'
   )
 WHERE q.first_response_at IS NULL;

UPDATE queries q
   SET q.closed_at = q.handled_at
 WHERE q.closed_at IS NULL AND q.status IN ('resolved', 'closed') AND q.handled_at IS NOT NULL;

-- Files attached to a reply or sent by the customer.
CREATE TABLE IF NOT EXISTS query_attachments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    query_id BIGINT NOT NULL,
    message_id BIGINT,
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(120),
    size_bytes BIGINT,
    uploaded_by_admin_id BIGINT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_query_attachments_query FOREIGN KEY (query_id) REFERENCES queries(id) ON DELETE CASCADE,
    CONSTRAINT fk_query_attachments_message FOREIGN KEY (message_id) REFERENCES query_messages(id) ON DELETE CASCADE,
    CONSTRAINT fk_query_attachments_admin FOREIGN KEY (uploaded_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL,
    INDEX idx_query_attachments_query (query_id),
    INDEX idx_query_attachments_message (message_id)
);

-- Saved replies. `{{name}}` placeholders are filled from the thread when one is
-- inserted, using the same rules as the email templates.
CREATE TABLE IF NOT EXISTS canned_replies (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(120) NOT NULL,
    category VARCHAR(60),
    body TEXT NOT NULL,
    shortcut VARCHAR(40),
    use_count INT NOT NULL DEFAULT 0,
    created_by_admin_id BIGINT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_canned_title (title),
    INDEX idx_canned_category (category)
);

INSERT IGNORE INTO canned_replies (title, category, shortcut, body) VALUES
(
    'Acknowledge and hold',
    'general',
    'ack',
    'Hi {{name}},\n\nThank you for getting in touch with Holiday Seychelles. We have your message and are looking into it now.\n\nWe will come back to you within one working day with a proper answer.\n\nBest regards,\nHoliday Seychelles'
),
(
    'Booking confirmed — what happens next',
    'booking',
    'confirmed',
    'Hi {{name}},\n\nYour booking is confirmed and your voucher has been emailed to this address. Please carry it with you — a printed copy or the PDF on your phone both work.\n\nIf anything on the voucher looks wrong, reply here and we will correct it before you travel.\n\nBest regards,\nHoliday Seychelles'
),
(
    'Asking for booking details',
    'booking',
    'ref',
    'Hi {{name}},\n\nSo that we can look this up properly, could you send us your booking reference? It starts with BS- and is on your confirmation email.\n\nIf you cannot find it, the email address used at the time is enough and we will search on that.\n\nBest regards,\nHoliday Seychelles'
),
(
    'Payment did not complete',
    'payment',
    'unpaid',
    'Hi {{name}},\n\nWe can see a checkout was started but the payment did not complete, so nothing has been charged and no booking is held.\n\nYou can finish it from your dashboard under Transactions. Prices and availability can change, so it is worth doing soon.\n\nBest regards,\nHoliday Seychelles'
),
(
    'Refund timeline',
    'payment',
    'refund',
    'Hi {{name}},\n\nYour refund has been approved and sent to your bank. Card refunds usually appear within 5 to 10 working days depending on the bank — we cannot speed that part up, but the money has left us.\n\nIf it has not arrived after 10 working days, reply here with the date and we will chase it.\n\nBest regards,\nHoliday Seychelles'
),
(
    'Closing the conversation',
    'general',
    'close',
    'Hi {{name}},\n\nGlad we could help. We are closing this conversation, but you can reply here any time and it will reopen.\n\nWe hope to see you in the islands soon.\n\nBest regards,\nHoliday Seychelles'
);
