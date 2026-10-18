-- Playground, feedback & analytics (Phase 19).

-- Saved test questions for the assistant and what a good answer must do.
-- expect_json: { route?, product?, minCards?, include?: [..], exclude?: [..], noPrice? }
CREATE TABLE IF NOT EXISTS rag_test_cases (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  message VARCHAR(2000) NOT NULL,
  expect_json JSON NOT NULL,
  tags VARCHAR(255) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- One suite run against a prompt: the draft, the published one or a version.
CREATE TABLE IF NOT EXISTS rag_test_runs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  prompt_ref VARCHAR(20) NOT NULL,
  prompt_version INT NULL,
  total INT NOT NULL DEFAULT 0,
  passed INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  status VARCHAR(12) NOT NULL DEFAULT 'running',
  results_json JSON NULL,
  ms INT NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  INDEX rag_test_runs_created (created_at)
);

-- What the team did about a 👎: fixed with an FAQ, or dismissed.
CREATE TABLE IF NOT EXISTS rag_feedback_review (
  feedback_id BIGINT PRIMARY KEY,
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  faq_id BIGINT NULL,
  note VARCHAR(500) NULL,
  resolved_by BIGINT NULL,
  resolved_at DATETIME NULL
);

-- Questions the assistant could not answer, grouped by meaning. A suggestion
-- becomes a draft FAQ only when an admin writes the answer.
CREATE TABLE IF NOT EXISTS rag_faq_suggestions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  cluster_key CHAR(64) NOT NULL,
  question VARCHAR(500) NOT NULL,
  samples_json JSON NOT NULL,
  hits INT NOT NULL DEFAULT 1,
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  faq_id BIGINT NULL,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY rag_faq_suggestions_key (cluster_key),
  INDEX rag_faq_suggestions_status (status, hits)
);

-- Knowledge chunks that say nearly the same thing with different numbers or dates.
CREATE TABLE IF NOT EXISTS rag_conflicts (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  pair_key CHAR(64) NOT NULL,
  chunk_a BIGINT NOT NULL,
  chunk_b BIGINT NOT NULL,
  score DECIMAL(5,3) NOT NULL,
  detail_json JSON NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY rag_conflicts_pair (pair_key)
);

-- A visitor stopped by a chat limit (daily token budget, rate limit, too long).
CREATE TABLE IF NOT EXISTS rag_limit_hits (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(30) NOT NULL,
  session_id CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX rag_limit_hits_created (created_at)
);
