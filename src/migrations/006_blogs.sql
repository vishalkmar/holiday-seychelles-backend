CREATE TABLE IF NOT EXISTS blogs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    slug VARCHAR(220) NOT NULL UNIQUE,
    title VARCHAR(255) NOT NULL,
    excerpt TEXT,
    content TEXT NOT NULL,
    cover_image VARCHAR(500),
    tags VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    published_at DATETIME,
    author_admin_id BIGINT,
    views INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_blogs_admin FOREIGN KEY (author_admin_id) REFERENCES admins(id) ON DELETE SET NULL,
    INDEX idx_blogs_status (status),
    INDEX idx_blogs_published_at (published_at)
);
