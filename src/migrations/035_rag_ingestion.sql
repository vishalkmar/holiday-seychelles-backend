-- Ingestion: the content of each source version, uploaded files, the job
-- queue, and an embedding cache keyed by chunk hash (so unchanged text is
-- never embedded twice — across edits, restores and re-indexes).
-- See docs/rag-system/DESIGN.md §3.3.

-- The text behind each version of a source (pasted text, or what a parser
-- extracted from a file). format: text | markdown | records (one JSON array of rows).
CREATE TABLE IF NOT EXISTS rag_source_content (
  source_id BIGINT NOT NULL,
  version INT NOT NULL,
  format VARCHAR(20) NOT NULL DEFAULT 'text',
  content LONGTEXT NOT NULL,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_id, version)
);

CREATE TABLE IF NOT EXISTS rag_documents (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  source_id BIGINT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  file_name VARCHAR(255) NOT NULL,
  mime VARCHAR(120) NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 CHAR(64) NOT NULL,
  storage_path VARCHAR(500) NOT NULL,
  storage_host VARCHAR(120) NULL,
  pages INT NULL,
  ocr_needed BOOLEAN NOT NULL DEFAULT FALSE,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX rag_documents_source (source_id, version)
);

-- status: queued | processing | indexed | failed | cancelled
CREATE TABLE IF NOT EXISTS rag_ingestion_jobs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  source_id BIGINT NOT NULL,
  source_version INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  error TEXT NULL,
  stats_json JSON NULL,
  -- Files live on one machine's disk; only that host may process the job.
  required_host VARCHAR(120) NULL,
  worker VARCHAR(160) NULL,
  next_run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  heartbeat_at DATETIME NULL,
  finished_at DATETIME NULL,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX rag_jobs_pick (status, next_run_at),
  INDEX rag_jobs_source (source_id, created_at)
);

CREATE TABLE IF NOT EXISTS rag_embed_cache (
  sha256 CHAR(64) NOT NULL,
  embed_model VARCHAR(160) NOT NULL,
  embed_dim INT NOT NULL,
  embedding MEDIUMBLOB NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sha256, embed_model)
);
