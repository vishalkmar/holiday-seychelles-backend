-- Bookings created after a successful payment. Booking types:
--   'hotel' | 'package' | 'tour' | 'transfer' | 'flight' | 'excursion' | 'rentcar' | 'attraction'
CREATE TABLE IF NOT EXISTS bookings (
    id BIGSERIAL PRIMARY KEY,
    booking_reference VARCHAR(50) NOT NULL UNIQUE,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    booking_type VARCHAR(30) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled | refunded | pending
    payment_status VARCHAR(30) NOT NULL DEFAULT 'paid', -- paid | refunded | failed
    payment_gateway VARCHAR(40),
    payment_reference VARCHAR(100),
    payment_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',

    -- traveller / lead pax snapshot (captured at booking time, independent of user profile edits)
    lead_first_name VARCHAR(120),
    lead_last_name VARCHAR(120),
    lead_email VARCHAR(190),
    lead_mobile VARCHAR(30),

    -- product snapshot
    product_title VARCHAR(255),
    product_code VARCHAR(100),
    check_in_date DATE,
    check_out_date DATE,
    travel_date DATE,
    total_travellers INT DEFAULT 1,
    total_adults INT DEFAULT 1,
    total_children INT DEFAULT 0,

    -- free-form details captured from the product + guests
    details JSONB NOT NULL DEFAULT '{}'::jsonb,

    voucher_path VARCHAR(500), -- relative path under /uploads once generated
    voucher_generated_at TIMESTAMPTZ,

    admin_notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_type ON bookings(booking_type);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings(created_at DESC);
