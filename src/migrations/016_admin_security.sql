-- Admin two-factor auth, audit trail and login throttling.

-- One row per admin holding their 2FA state.
-- The TOTP secret is stored so codes can be verified; it is only ever returned
-- to the browser during setup, before the factor is confirmed.
CREATE TABLE IF NOT EXISTS admin_security (
    admin_id BIGINT PRIMARY KEY,
    email_otp_enabled TINYINT(1) NOT NULL DEFAULT 0,
    email_otp_address VARCHAR(190),
    totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
    totp_secret VARCHAR(64),
    -- Set at setup, cleared on confirm: an unconfirmed secret must never be
    -- treated as an active factor.
    totp_pending_secret VARCHAR(64),
    recovery_codes_generated_at DATETIME,
    last_verified_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_admin_security_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);

-- Single-use backup codes. Only the hash is kept, so a database read does not
-- hand someone a working set of codes.
CREATE TABLE IF NOT EXISTS admin_recovery_codes (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    admin_id BIGINT NOT NULL,
    code_hash CHAR(64) NOT NULL,
    used_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_admin_recovery_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
    INDEX idx_admin_recovery_admin (admin_id),
    INDEX idx_admin_recovery_hash (code_hash)
);

-- Short-lived challenges issued between password and second factor, so a
-- half-finished login never hands out a real session token.
CREATE TABLE IF NOT EXISTS admin_mfa_challenges (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    challenge_id CHAR(36) NOT NULL UNIQUE,
    admin_id BIGINT NOT NULL,
    method VARCHAR(20) NOT NULL,
    email_code_hash CHAR(64),
    attempts INT NOT NULL DEFAULT 0,
    consumed_at DATETIME,
    expires_at DATETIME NOT NULL,
    ip_address VARCHAR(64),
    user_agent VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_admin_mfa_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
    INDEX idx_admin_mfa_challenge (challenge_id),
    INDEX idx_admin_mfa_expires (expires_at)
);

-- Who did what, from where. Written for anything that changes money, access or
-- customer data.
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    admin_id BIGINT,
    admin_email VARCHAR(190),
    action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(40),
    entity_id VARCHAR(80),
    summary VARCHAR(500),
    metadata JSON,
    ip_address VARCHAR(64),
    user_agent VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'success',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_admin_audit_admin (admin_id),
    INDEX idx_admin_audit_action (action),
    INDEX idx_admin_audit_created (created_at),
    INDEX idx_admin_audit_entity (entity_type, entity_id)
);

-- Every sign-in attempt, successful or not. Drives lockout and the
-- new-device alert.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(190) NOT NULL,
    admin_id BIGINT,
    successful TINYINT(1) NOT NULL DEFAULT 0,
    failure_reason VARCHAR(80),
    ip_address VARCHAR(64),
    user_agent VARCHAR(500),
    device_fingerprint CHAR(64),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_admin_attempts_email (email, created_at),
    INDEX idx_admin_attempts_ip (ip_address, created_at),
    INDEX idx_admin_attempts_device (admin_id, device_fingerprint)
);
