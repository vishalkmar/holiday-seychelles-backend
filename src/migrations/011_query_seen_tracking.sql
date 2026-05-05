ALTER TABLE queries
ADD COLUMN user_last_seen_at DATETIME,
ADD COLUMN admin_last_seen_at DATETIME;

CREATE INDEX idx_queries_user_last_seen_at ON queries(user_last_seen_at);
CREATE INDEX idx_queries_admin_last_seen_at ON queries(admin_last_seen_at);
