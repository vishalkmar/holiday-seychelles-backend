-- Roles and permissions.
--
-- This reverses the "single-operator, anyone who can sign in can do anything"
-- decision. Permissions are stored per role and enforced on the SERVER for
-- every admin route — hiding a menu item is not access control.
--
-- Existing accounts keep full access: adding permissions must not lock the
-- people already using the panel out of it, so every current admin becomes an
-- owner and the migration backfills them.
CREATE TABLE IF NOT EXISTS admin_roles (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    role_key VARCHAR(40) NOT NULL,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(300),
    -- A JSON array of permission keys. '*' means everything, and only the
    -- owner role has it.
    permissions JSON NOT NULL,
    -- A built-in role cannot be deleted or have its key changed; the panel
    -- would have nothing to fall back to.
    is_system TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_admin_role_key (role_key)
);

INSERT IGNORE INTO admin_roles (role_key, name, description, permissions, is_system) VALUES
(
    'owner',
    'Owner',
    'Full access, including team, roles and settings. There is always at least one.',
    '["*"]',
    1
),
(
    'manager',
    'Manager',
    'Runs the business day to day. Everything except the team, roles and security settings.',
    '["dashboard.view","bookings.view","bookings.manage","bookings.refund","transactions.view","transactions.refund","revenue.view","customers.view","customers.manage","emails.view","emails.send","emails.manage","support.view","support.reply","support.manage","content.view","content.manage","documents.view","documents.manage","reports.view","reports.export","reports.manage","audit.view"]',
    1
),
(
    'support',
    'Support agent',
    'Answers customers. Can read bookings and payments but cannot move money or change content.',
    '["dashboard.view","bookings.view","transactions.view","customers.view","emails.view","support.view","support.reply","documents.view","documents.manage"]',
    1
),
(
    'editor',
    'Content editor',
    'Writes and publishes blog posts. No access to customers, money or support.',
    '["dashboard.view","content.view","content.manage"]',
    1
),
(
    'analyst',
    'Analyst',
    'Reads everything and exports it. Changes nothing.',
    '["dashboard.view","bookings.view","transactions.view","revenue.view","customers.view","emails.view","support.view","content.view","documents.view","reports.view","reports.export","audit.view"]',
    1
);

-- Link admins to a role, and give them the fields a team screen needs.
ALTER TABLE admins
    ADD COLUMN role_key VARCHAR(40) AFTER role,
    ADD COLUMN created_by_admin_id BIGINT AFTER role_key,
    ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER created_by_admin_id,
    ADD INDEX idx_admins_role_key (role_key);

-- Everyone who already had access keeps it. Anything else would lock the
-- current operators out of their own panel the moment this migration ran.
UPDATE admins SET role_key = 'owner' WHERE role_key IS NULL;

-- Business settings live in the existing key/value store, seeded here so the
-- screen has something to show on first open.
INSERT IGNORE INTO admin_settings (setting_key, setting_value) VALUES
('business_settings', '{"businessName":"Holiday Seychelles","supportEmail":"info@holidayseychelles.com","supportPhone":"","currency":"EUR","timezone":"Indian/Mahe","bookingPrefix":"BS","dateFormat":"DD MMM YYYY"}');
