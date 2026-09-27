-- Small key/value store for admin-configurable values.
--
-- Deliberately generic: the revenue target is the first user, but things like a
-- default currency or a notification preference belong here too rather than
-- earning a column each.
CREATE TABLE IF NOT EXISTS admin_settings (
    setting_key VARCHAR(80) PRIMARY KEY,
    setting_value TEXT,
    updated_by_admin_id BIGINT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
