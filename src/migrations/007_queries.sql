-- Customer queries / contact form submissions.
CREATE TABLE IF NOT EXISTS queries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(190) NOT NULL,
    mobile VARCHAR(30),
    subject VARCHAR(255),
    category VARCHAR(60),
    message TEXT NOT NULL,
    source VARCHAR(60),
    status VARCHAR(20) NOT NULL DEFAULT 'new',
    admin_notes TEXT,
    handled_by_admin_id BIGINT,
    handled_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_queries_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_queries_admin FOREIGN KEY (handled_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL,
    INDEX idx_queries_status (status),
    INDEX idx_queries_created (created_at),
    INDEX idx_queries_user (user_id)
);
