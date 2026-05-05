-- Refund tracking columns on bookings.
ALTER TABLE bookings
    ADD COLUMN refund_amount DECIMAL(12, 2),
    ADD COLUMN refund_currency VARCHAR(10),
    ADD COLUMN refund_reason TEXT,
    ADD COLUMN refund_reference VARCHAR(120),
    ADD COLUMN refund_initiated_at DATETIME,
    ADD COLUMN refund_completed_at DATETIME,
    ADD COLUMN refunded_by_admin_id BIGINT,
    ADD COLUMN is_refundable BOOLEAN NOT NULL DEFAULT TRUE;

-- Audit trail of refund actions (one row per refund attempt or status change)
CREATE TABLE IF NOT EXISTS refund_events (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    booking_id BIGINT NOT NULL,
    admin_id BIGINT,
    action VARCHAR(40) NOT NULL,
    amount DECIMAL(12, 2),
    currency VARCHAR(10),
    gateway_reference VARCHAR(120),
    notes TEXT,
    payload JSON,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_refund_events_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    INDEX idx_refund_events_booking (booking_id),
    INDEX idx_refund_events_action (action)
);
