-- Turn the blog table into a content studio.
--
-- `views` was a single lifetime counter, which can answer "is this popular?"
-- but not "is this still being read?". A per-day roll-up answers both, and
-- keeping the running total as well means no existing number changes meaning.
ALTER TABLE blogs
    ADD COLUMN category VARCHAR(60) AFTER tags,
    ADD COLUMN meta_title VARCHAR(255) AFTER category,
    ADD COLUMN meta_description VARCHAR(320) AFTER meta_title,
    ADD COLUMN scheduled_for DATETIME AFTER published_at,
    -- An override for the byline. Most posts are written by whoever is signed
    -- in, but a guest piece should not be attributed to an admin account.
    ADD COLUMN author_name VARCHAR(150) AFTER author_admin_id,
    ADD COLUMN reading_minutes INT AFTER author_name,
    ADD COLUMN last_viewed_at DATETIME AFTER views,
    ADD INDEX idx_blogs_scheduled (scheduled_for),
    ADD INDEX idx_blogs_category (category);

-- Meta fields default to the post's own title and excerpt: a search result that
-- repeats the headline is right far more often than an empty one.
UPDATE blogs SET meta_title = title WHERE meta_title IS NULL;
UPDATE blogs SET meta_description = LEFT(COALESCE(excerpt, ''), 320)
 WHERE meta_description IS NULL AND excerpt IS NOT NULL;

-- Daily readership, so a post's trend is visible rather than just its total.
CREATE TABLE IF NOT EXISTS blog_views (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    blog_id BIGINT NOT NULL,
    day DATE NOT NULL,
    views INT NOT NULL DEFAULT 0,

    CONSTRAINT fk_blog_views_blog FOREIGN KEY (blog_id) REFERENCES blogs(id) ON DELETE CASCADE,
    UNIQUE KEY uniq_blog_view_day (blog_id, day),
    INDEX idx_blog_views_day (day)
);
