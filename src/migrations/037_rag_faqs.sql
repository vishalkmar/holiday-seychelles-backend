-- AI Questions Training: approved question → answer pairs, each with extra
-- phrasings (variations) that point to the same answer.
-- status: draft | review | published | archived. Publishing turns the FAQ into
-- a 'faq' knowledge source (one chunk per phrasing, all carrying the answer).
CREATE TABLE IF NOT EXISTS rag_faqs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  source_id BIGINT NULL,
  question VARCHAR(500) NOT NULL,
  question_norm VARCHAR(500) NOT NULL,
  answer TEXT NOT NULL,
  category VARCHAR(80) NULL,
  tags_json JSON NULL,
  destination VARCHAR(80) NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  visibility VARCHAR(10) NOT NULL DEFAULT 'public',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  version INT NOT NULL DEFAULT 1,
  published_hash CHAR(64) NULL,
  created_by BIGINT NULL,
  updated_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX rag_faqs_status (status, category),
  INDEX rag_faqs_norm (question_norm(191)),
  FULLTEXT KEY rag_faqs_text (question, answer)
);

CREATE TABLE IF NOT EXISTS rag_faq_variations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  faq_id BIGINT NOT NULL,
  question VARCHAR(500) NOT NULL,
  question_norm VARCHAR(500) NOT NULL,
  INDEX rag_faq_variations_faq (faq_id),
  INDEX rag_faq_variations_norm (question_norm(191))
);

-- Every saved version of an FAQ, for history and rollback.
CREATE TABLE IF NOT EXISTS rag_faq_versions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  faq_id BIGINT NOT NULL,
  version INT NOT NULL,
  snapshot_json JSON NOT NULL,
  note VARCHAR(255) NULL,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY rag_faq_versions_pos (faq_id, version)
);

-- A bulk import between upload and commit (preview → check → commit). Kept in
-- the database, not memory, so it works across processes; purged after a day.
CREATE TABLE IF NOT EXISTS rag_faq_imports (
  id CHAR(36) PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  rows_json LONGTEXT NOT NULL,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
