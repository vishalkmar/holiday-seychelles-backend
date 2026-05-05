CREATE TABLE IF NOT EXISTS query_messages (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    query_id BIGINT NOT NULL,
    sender_type VARCHAR(20) NOT NULL,
    sender_user_id BIGINT,
    sender_admin_id BIGINT,
    message TEXT NOT NULL,
    email_sent BOOLEAN NOT NULL DEFAULT FALSE,
    email_sent_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_query_messages_sender CHECK (sender_type IN ('user', 'admin', 'system')),
    CONSTRAINT fk_query_messages_query FOREIGN KEY (query_id) REFERENCES queries(id) ON DELETE CASCADE,
    CONSTRAINT fk_query_messages_user FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_query_messages_admin FOREIGN KEY (sender_admin_id) REFERENCES admins(id) ON DELETE SET NULL,
    INDEX idx_query_messages_query_id (query_id, created_at),
    INDEX idx_query_messages_sender_type (sender_type)
);
