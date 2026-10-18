-- Bot Connection (Phase 16): guided conversation flows.
-- A flow has a working draft (draft_json) and immutable published versions.
-- Sessions keep the version they started with until the flow ends.
CREATE TABLE IF NOT EXISTS bot_flows (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  flow_key VARCHAR(48) NOT NULL,
  name VARCHAR(120) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'draft',
  draft_json MEDIUMTEXT NOT NULL,
  published_version INT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  updated_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY bot_flows_key (flow_key)
);

CREATE TABLE IF NOT EXISTS bot_flow_versions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  flow_id BIGINT NOT NULL,
  version INT NOT NULL,
  graph_json MEDIUMTEXT NOT NULL,
  note VARCHAR(255) NULL,
  published_by BIGINT NULL,
  published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY bot_flow_versions_pos (flow_id, version)
);
