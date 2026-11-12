-- Customer account deletion requests (Google Play account-deletion policy).
-- The customer asks from their dashboard or /delete-account; an admin approves
-- or rejects it in Admin → Account Deletions. Approval deletes the users row
-- (bookings, queries and payment orders keep their records via ON DELETE SET
-- NULL). user_id has no foreign key on purpose: the request outlives the
-- account as the record that the deletion was asked for and carried out.
CREATE TABLE IF NOT EXISTS account_deletion_requests (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NULL,
    email VARCHAR(190) NOT NULL,
    full_name VARCHAR(250),
    reason VARCHAR(1000),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at DATETIME NULL,
    decided_by BIGINT NULL,
    decided_by_email VARCHAR(190) NULL,
    admin_note VARCHAR(1000) NULL,
    INDEX adr_status (status, requested_at),
    INDEX adr_user (user_id),
    INDEX adr_email (email)
);
