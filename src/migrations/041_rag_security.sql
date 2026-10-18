-- Prompt security (Phase 12). Sensitive AI changes need a step-up:
--   password + a 6-digit email code (D5: email OTP only) → a change token,
--   single-use, 15 minutes, bound to admin + action + target.
-- Codes and tokens are stored only as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS rag_stepup_challenges (
  id CHAR(36) PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  action VARCHAR(40) NOT NULL,
  target VARCHAR(160) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  sends INT NOT NULL DEFAULT 1,
  last_sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  verified_at DATETIME NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX rag_stepup_admin (admin_id, created_at)
);

CREATE TABLE IF NOT EXISTS rag_change_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  action VARCHAR(40) NOT NULL,
  target VARCHAR(160) NOT NULL,
  challenge_id CHAR(36) NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- D6: optional second-admin approval (setting requireSecondApproval, default off).
CREATE TABLE IF NOT EXISTS rag_pending_changes (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  action VARCHAR(40) NOT NULL,
  target VARCHAR(160) NOT NULL,
  payload_json JSON NULL,
  summary VARCHAR(255) NULL,
  requested_by BIGINT NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'pending',
  decided_by BIGINT NULL,
  decided_at DATETIME NULL,
  reason VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX rag_pending_status (status, created_at)
);
