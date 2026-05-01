ALTER TABLE queries
ADD COLUMN IF NOT EXISTS user_last_seen_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS admin_last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_queries_user_last_seen_at ON queries(user_last_seen_at);
CREATE INDEX IF NOT EXISTS idx_queries_admin_last_seen_at ON queries(admin_last_seen_at);
