-- Email OTPs for passwordless login. We store a hash of the OTP, not the OTP.
CREATE TABLE IF NOT EXISTS email_otps (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(190) NOT NULL,
    purpose VARCHAR(30) NOT NULL DEFAULT 'user_login',
    code_hash VARCHAR(255) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    consumed_at DATETIME,
    expires_at DATETIME NOT NULL,
    ip_address VARCHAR(64),
    user_agent VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_email_otps_email (email),
    INDEX idx_email_otps_email_active (email, purpose, consumed_at, expires_at)
);
