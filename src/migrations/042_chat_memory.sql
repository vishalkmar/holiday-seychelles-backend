-- Conversation memory (Phase 13, MEMORY-DESIGN.md).
--
-- Visitors are anonymous: each browser gets a random visitor id, handed to it
-- as a signed token (memory/identity.js) and kept in localStorage. Sessions
-- and messages are only readable with that token — never by IP, which many
-- visitors share (office Wi-Fi, mobile carriers). A logged-in customer's
-- sessions are also linked to their user id. Rows expire after the retention
-- period (D9, setting chatRetentionDays) and are purged daily.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id CHAR(36) PRIMARY KEY,
  visitor_id CHAR(36) NOT NULL,
  user_id BIGINT NULL,
  language VARCHAR(10) NULL,
  slots_json JSON NULL,
  state_json JSON NULL,
  summary TEXT NULL,
  summary_upto BIGINT NOT NULL DEFAULT 0,
  turns INT NOT NULL DEFAULT 0,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  ip_hash CHAR(64) NULL,
  user_agent VARCHAR(300) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  INDEX chat_sessions_visitor (visitor_id, last_active_at),
  INDEX chat_sessions_user (user_id, last_active_at),
  INDEX chat_sessions_expiry (expires_at)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id CHAR(36) NOT NULL,
  role VARCHAR(10) NOT NULL,
  content TEXT NOT NULL,
  reply_json JSON NULL,
  route VARCHAR(20) NULL,
  tokens INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX chat_messages_session (session_id, id)
);

-- Opt-in preferences for logged-in customers only (never travel dates or names).
CREATE TABLE IF NOT EXISTS chat_user_profile (
  user_id BIGINT PRIMARY KEY,
  consent TINYINT(1) NOT NULL DEFAULT 0,
  prefs_json JSON NULL,
  consent_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
