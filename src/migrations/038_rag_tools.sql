-- Live API tools (Phase 9): admin overrides for each built-in tool. A tool with
-- no row uses its defaults from code. description NULL = the default text.
-- permission: public | user (signed-in visitor). Code and credentials are not
-- stored here — only on/off, what the model is told, and limits.
CREATE TABLE IF NOT EXISTS rag_tools (
  name VARCHAR(80) PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  permission VARCHAR(10) NOT NULL DEFAULT 'public',
  description TEXT NULL,
  timeout_ms INT NULL,
  cache_sec INT NULL,
  max_results INT NULL,
  updated_by BIGINT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
