-- API connectors for the assistant (extra track 2.3 / 2.4): our own read-only
-- GET endpoints and outside GET APIs, each usable as a tool when enabled.
-- params_json: [{ name, in: query|path, required, description, value? }]
--   a param with a value is fixed; one without is filled in by the assistant.
-- headers_enc: outside APIs only, JSON headers encrypted with RAG_SECRET_KEY.
CREATE TABLE IF NOT EXISTS rag_api_connectors (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  kind VARCHAR(10) NOT NULL,
  slug VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(600) NOT NULL,
  url VARCHAR(600) NOT NULL,
  params_json JSON NULL,
  headers_enc TEXT NULL,
  response_path VARCHAR(200) NULL,
  max_items INT NOT NULL DEFAULT 10,
  cache_sec INT NOT NULL DEFAULT 300,
  timeout_ms INT NOT NULL DEFAULT 10000,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  last_status VARCHAR(20) NULL,
  last_error VARCHAR(500) NULL,
  last_checked_at DATETIME NULL,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY rag_api_connectors_slug (slug)
);
