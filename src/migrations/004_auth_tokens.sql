-- Server-side token tracking so that logout truly invalidates tokens.
CREATE TABLE IF NOT EXISTS auth_tokens (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    jti CHAR(36) NOT NULL UNIQUE,
    subject_type VARCHAR(10) NOT NULL,
    subject_id BIGINT NOT NULL,
    issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME,
    ip_address VARCHAR(64),
    user_agent VARCHAR(500),
    INDEX idx_auth_tokens_subject (subject_type, subject_id),
    INDEX idx_auth_tokens_jti (jti)
);
