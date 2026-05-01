-- Refund tracking columns on bookings.
-- We keep refund metadata on the booking row itself so the existing flows
-- (status='refunded', payment_status='refunded') continue to work and the new
-- columns just enrich the picture.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS refund_currency VARCHAR(10),
    ADD COLUMN IF NOT EXISTS refund_reason TEXT,
    ADD COLUMN IF NOT EXISTS refund_reference VARCHAR(120),
    ADD COLUMN IF NOT EXISTS refund_initiated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refund_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refunded_by_admin_id BIGINT,
    ADD COLUMN IF NOT EXISTS is_refundable BOOLEAN NOT NULL DEFAULT TRUE;

-- Audit trail of refund actions (one row per refund attempt or status change)
CREATE TABLE IF NOT EXISTS refund_events (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    admin_id BIGINT,
    action VARCHAR(40) NOT NULL,            -- 'requested' | 'gateway_initiated' | 'gateway_failed' | 'completed' | 'note'
    amount NUMERIC(12, 2),
    currency VARCHAR(10),
    gateway_reference VARCHAR(120),
    notes TEXT,
    payload JSONB DEFAULT '{}'::jsonb,       -- raw gateway response / extra context
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_events_booking ON refund_events(booking_id);
CREATE INDEX IF NOT EXISTS idx_refund_events_action ON refund_events(action);
