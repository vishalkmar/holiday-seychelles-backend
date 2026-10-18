-- Every AI model call: what it was for, which model, tokens, latency and an
-- estimated cost. No message text is stored here (see MEMORY-DESIGN.md §5).
CREATE TABLE IF NOT EXISTS rag_usage (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id VARCHAR(64) NULL,
  purpose VARCHAR(20) NOT NULL,
  model VARCHAR(160) NOT NULL,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  latency_ms INT NOT NULL DEFAULT 0,
  cost_est DECIMAL(12,6) NOT NULL DEFAULT 0,
  ok BOOLEAN NOT NULL DEFAULT TRUE,
  error_code VARCHAR(40) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX rag_usage_when (created_at),
  INDEX rag_usage_purpose (purpose, created_at)
);
