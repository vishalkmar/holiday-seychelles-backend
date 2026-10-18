-- Knowledge sources (an FAQ, a destination profile, an uploaded document…)
-- and their searchable chunks. MySQL is the source of truth for chunk text and
-- embeddings; Pinecone, when enabled, is a mirror used for search.
-- See docs/rag-system/DESIGN.md §3.2 and §4.
CREATE TABLE IF NOT EXISTS rag_sources (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  type VARCHAR(20) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  destination VARCHAR(80) NULL,
  category VARCHAR(80) NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  visibility VARCHAR(10) NOT NULL DEFAULT 'public',
  version INT NOT NULL DEFAULT 1,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX rag_sources_type_status (type, status)
);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  source_id BIGINT NOT NULL,
  source_version INT NOT NULL DEFAULT 1,
  chunk_index INT NOT NULL,
  text MEDIUMTEXT NOT NULL,
  tokens INT NOT NULL DEFAULT 0,
  sha256 CHAR(64) NOT NULL,
  metadata_json JSON NULL,
  embedding MEDIUMBLOB NULL,
  embed_model VARCHAR(160) NULL,
  embed_dim INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY rag_chunks_position (source_id, source_version, chunk_index),
  INDEX rag_chunks_source (source_id),
  INDEX rag_chunks_sha (sha256),
  FULLTEXT KEY rag_chunks_text (text)
);
