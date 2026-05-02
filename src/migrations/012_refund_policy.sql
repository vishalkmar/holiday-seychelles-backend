-- Refund-window policy + payment-attempt audit.
-- refund_window_hours: how long after payment a booking is auto-refundable.
--   2  = strict (within 2 hrs anything goes back automatically)
--   24 = standard (24 hr grace)
--   0  = non-refundable
-- payment_attempts: every payment hit (success or failure) so we can audit
-- declines/errors that never become a booking row.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS refund_window_hours INT NOT NULL DEFAULT 24,
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20), -- 'user' | 'admin' | 'system'
    ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
    ADD COLUMN IF NOT EXISTS supplier_reference VARCHAR(120),  -- TourVisio reservation no., EJuniper locator, etc.
    ADD COLUMN IF NOT EXISTS supplier_status VARCHAR(40);

CREATE TABLE IF NOT EXISTS payment_attempts (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT REFERENCES bookings(id) ON DELETE SET NULL,
    transaction_uuid VARCHAR(80),
    decision VARCHAR(20),              -- ACCEPT | DECLINE | ERROR | CANCEL | REVIEW
    gateway VARCHAR(40),               -- 'cybersource'
    gateway_reference VARCHAR(120),    -- transaction_id
    amount NUMERIC(12, 2),
    currency VARCHAR(10),
    message TEXT,
    raw_payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_booking ON payment_attempts(booking_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_uuid ON payment_attempts(transaction_uuid);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_decision ON payment_attempts(decision);
