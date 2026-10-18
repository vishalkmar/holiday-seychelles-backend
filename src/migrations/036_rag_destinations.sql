-- Destination Knowledge: one profile per island or place, edited in sections
-- (overview, best time, things to do…). The working copy lives here; Publish
-- turns it into a 'destination' knowledge source and indexes it.
-- island = the island a place belongs to (anse-lazio → praslin), used as the
-- chunks' destination so "things to do on Praslin" finds its beaches too.
CREATE TABLE IF NOT EXISTS rag_destinations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  slug VARCHAR(160) NOT NULL,
  name VARCHAR(160) NOT NULL,
  island VARCHAR(80) NOT NULL,
  website_slug VARCHAR(160) NULL,
  source_id BIGINT NULL,
  sections_json JSON NOT NULL,
  published_hash CHAR(64) NULL,
  visibility VARCHAR(10) NOT NULL DEFAULT 'public',
  synced_at DATETIME NULL,
  updated_by BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY rag_destinations_slug (slug),
  INDEX rag_destinations_island (island)
);
