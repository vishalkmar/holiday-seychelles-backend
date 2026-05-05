-- Refund-window policy + payment-attempt audit.
ALTER TABLE bookings
    ADD COLUMN refund_window_hours INT NOT NULL DEFAULT 24,
    ADD COLUMN cancelled_at DATETIME,
    ADD COLUMN cancelled_by VARCHAR(20),
    ADD COLUMN cancellation_reason TEXT,
    ADD COLUMN supplier_reference VARCHAR(120),
    ADD COLUMN supplier_status VARCHAR(40);

CREATE TABLE IF NOT EXISTS payment_attempts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    booking_id BIGINT,
    transaction_uuid VARCHAR(80),
    decision VARCHAR(20),
    gateway VARCHAR(40),
    gateway_reference VARCHAR(120),
    amount DECIMAL(12, 2),
    currency VARCHAR(10),
    message TEXT,
    raw_payload JSON,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payment_attempts_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL,
    INDEX idx_payment_attempts_booking (booking_id),
    INDEX idx_payment_attempts_uuid (transaction_uuid),
    INDEX idx_payment_attempts_decision (decision)
);
