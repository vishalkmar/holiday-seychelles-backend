-- Customer queries / contact form submissions.
CREATE TABLE IF NOT EXISTS queries (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(190) NOT NULL,
    mobile VARCHAR(30),
    subject VARCHAR(255),
    category VARCHAR(60), -- e.g. 'hotel' | 'package' | 'general'
    message TEXT NOT NULL,
    source VARCHAR(60), -- where the query came from (contact_form, hotel_page, etc.)
    status VARCHAR(20) NOT NULL DEFAULT 'new', -- new | in_progress | resolved | closed
    admin_notes TEXT,
    handled_by_admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    handled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_queries_status ON queries(status);
CREATE INDEX IF NOT EXISTS idx_queries_created ON queries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_queries_user ON queries(user_id);
