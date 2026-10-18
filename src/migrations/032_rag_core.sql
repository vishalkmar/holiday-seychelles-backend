-- AI assistant (RAG) core: admin-editable settings for the module.
-- Secret values (API keys) are stored encrypted (AES-GCM, RAG_SECRET_KEY) and
-- flagged is_secret so the API only ever returns them masked.
-- Audit goes to the existing admin_audit_log (entity_type rag_*).
-- See docs/rag-system/DESIGN.md §4.
CREATE TABLE IF NOT EXISTS rag_settings (
  setting_key VARCHAR(80) PRIMARY KEY,
  value_json JSON NOT NULL,
  is_secret BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
