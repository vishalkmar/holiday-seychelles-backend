-- One row per assistant turn (Phase 10): how the message was understood and
-- answered — route, slots, retrieval ids, tools, models, tokens, grounding —
-- for the playground and debugging. The visitor's message and the reply are
-- kept here too; Phase 13 sets the retention period (D9) and purges old rows.
CREATE TABLE IF NOT EXISTS rag_traces (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id VARCHAR(64) NULL,
  audience VARCHAR(10) NOT NULL DEFAULT 'public',
  route VARCHAR(20) NULL,
  message TEXT NULL,
  reply_json JSON NULL,
  trace_json JSON NULL,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  ms INT NOT NULL DEFAULT 0,
  fallback TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX rag_traces_session (session_id, id),
  INDEX rag_traces_created (created_at)
);
