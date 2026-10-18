-- System Prompt Controller (Phase 11): versions of the L2 business
-- instructions. At most one row is 'draft' (the working copy); published rows
-- are immutable history (v1, v2…); the newest published row is live.
-- Publishing needs step-up verification (Phase 12).
CREATE TABLE IF NOT EXISTS rag_prompt_versions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  version INT NOT NULL DEFAULT 0,
  status VARCHAR(12) NOT NULL DEFAULT 'draft',
  content MEDIUMTEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  note VARCHAR(255) NULL,
  created_by BIGINT NULL,
  published_by BIGINT NULL,
  published_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX rag_prompt_versions_status (status, version)
);
