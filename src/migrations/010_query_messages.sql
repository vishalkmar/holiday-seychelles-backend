CREATE TABLE IF NOT EXISTS query_messages (
    id BIGSERIAL PRIMARY KEY,
    query_id BIGINT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('user', 'admin', 'system')),
    sender_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    sender_admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    email_sent BOOLEAN NOT NULL DEFAULT FALSE,
    email_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_query_messages_query_id ON query_messages(query_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_query_messages_sender_type ON query_messages(sender_type);
