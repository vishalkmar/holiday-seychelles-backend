-- Link every gateway response back to the order that produced it.
ALTER TABLE payment_attempts
    ADD COLUMN payment_order_id BIGINT,
    ADD COLUMN signature_valid TINYINT(1),
    ADD INDEX idx_payment_attempts_order (payment_order_id);
