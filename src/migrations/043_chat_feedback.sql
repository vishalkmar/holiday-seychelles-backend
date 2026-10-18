-- Visitor feedback on assistant answers (Phase 14). One row per message per
-- visitor; a second vote replaces the first.
CREATE TABLE IF NOT EXISTS chat_feedback (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  message_id BIGINT NOT NULL,
  session_id CHAR(36) NOT NULL,
  rating VARCHAR(8) NOT NULL,
  comment VARCHAR(1000) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY chat_feedback_message (message_id)
);
