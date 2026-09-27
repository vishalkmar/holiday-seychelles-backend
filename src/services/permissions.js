/**
 * Who can do what.
 *
 * Every permission the panel knows about is declared here, once. A route asks
 * for a key; a role either holds it or does not. Nothing is implicit.
 *
 * Two rules that matter more than the list:
 *
 *  1. **Enforcement is server-side.** The UI hides what an admin cannot use,
 *     but that is a courtesy. The middleware in this file is the access
 *     control, and it runs before any handler.
 *
 *  2. **An unknown role gets nothing.** If a role row is deleted or its key is
 *     mistyped, the admin loses access rather than silently gaining it. Failing
 *     closed is the only safe direction.
 */

const { pool } = require('../config/db');

/**
 * The permission catalogue, grouped for the role editor.
 *
 * `.view` is read access; `.manage` covers create, edit and delete; anything
 * that moves money or touches another operator's access is its own key,
 * because those are the ones somebody will want to withhold separately.
 */
const CATALOGUE = [
  {
    group: 'Overview',
    permissions: [{ key: 'dashboard.view', label: 'See the dashboard' }],
  },
  {
    group: 'Bookings',
    permissions: [
      { key: 'bookings.view', label: 'See bookings' },
      { key: 'bookings.manage', label: 'Change bookings and their status' },
      { key: 'bookings.refund', label: 'Issue refunds', sensitive: true },
    ],
  },
  {
    group: 'Money',
    permissions: [
      { key: 'transactions.view', label: 'See the payment ledger' },
      { key: 'transactions.refund', label: 'Refund from the ledger', sensitive: true },
      { key: 'revenue.view', label: 'See revenue and analysis' },
    ],
  },
  {
    group: 'Customers',
    permissions: [
      { key: 'customers.view', label: 'See customers' },
      { key: 'customers.manage', label: 'Suspend customers and edit their notes' },
    ],
  },
  {
    group: 'Email',
    permissions: [
      { key: 'emails.view', label: 'See templates and the email log' },
      { key: 'emails.send', label: 'Send an email to a customer' },
      { key: 'emails.manage', label: 'Edit templates and run campaigns', sensitive: true },
    ],
  },
  {
    group: 'Support',
    permissions: [
      { key: 'support.view', label: 'Read conversations' },
      { key: 'support.reply', label: 'Reply to customers' },
      { key: 'support.manage', label: 'Assign, close and delete conversations' },
    ],
  },
  {
    group: 'Content',
    permissions: [
      { key: 'content.view', label: 'See posts' },
      { key: 'content.manage', label: 'Write, publish and delete posts' },
    ],
  },
  {
    group: 'Documents',
    permissions: [
      { key: 'documents.view', label: 'See vouchers and invoices' },
      { key: 'documents.manage', label: 'Regenerate, email and change the template' },
    ],
  },
  {
    group: 'Reports',
    permissions: [
      { key: 'reports.view', label: 'Build and preview reports' },
      { key: 'reports.export', label: 'Download exports', sensitive: true },
      { key: 'reports.manage', label: 'Save reports and schedule them' },
    ],
  },
  {
    group: 'Administration',
    permissions: [
      { key: 'audit.view', label: 'Read the audit log' },
      { key: 'security.manage', label: 'Change security settings and 2FA', sensitive: true },
      { key: 'team.view', label: 'See the team' },
      { key: 'team.manage', label: 'Add, suspend and re-role operators', sensitive: true },
      { key: 'settings.manage', label: 'Change business settings', sensitive: true },
    ],
  },
];

const ALL_KEYS = CATALOGUE.flatMap((g) => g.permissions.map((p) => p.key));

function parsePermissions(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The permissions attached to a role key.
 *
 * Cached for a short while because this is read on every admin request and the
 * roles table changes rarely. The cache is cleared whenever a role is written,
 * so a permission change takes effect on the next request rather than in a
 * minute's time.
 */
let cache = new Map();
let cachedAt = 0;
const CACHE_MS = Number(process.env.PERMISSION_CACHE_MS || 30000);

function clearPermissionCache() {
  cache = new Map();
  cachedAt = 0;
}

async function loadRoles() {
  if (cache.size && Date.now() - cachedAt < CACHE_MS) return cache;
  const { rows } = await pool.query('SELECT role_key, permissions FROM admin_roles');
  cache = new Map(rows.map((r) => [r.role_key, parsePermissions(r.permissions)]));
  cachedAt = Date.now();
  return cache;
}

async function permissionsFor(roleKey) {
  if (!roleKey) return [];
  const roles = await loadRoles();
  return roles.get(roleKey) || [];
}

function holds(permissions, key) {
  return permissions.includes('*') || permissions.includes(key);
}

async function can(roleKey, key) {
  return holds(await permissionsFor(roleKey), key);
}

/**
 * Guard a route.
 *
 * Used as `router.get('/', adminAuth, requirePermission('bookings.view'), handler)`.
 * It runs after adminAuth, so `req.admin` is already populated.
 *
 * A failure is 403 with the permission named, because "Forbidden" with no
 * explanation sends an operator to ask a developer rather than an owner.
 */
function requirePermission(key) {
  return async function permissionGuard(req, res, next) {
    try {
      const roleKey = req.admin?.roleKey || req.admin?.role_key;
      const permissions = await permissionsFor(roleKey);

      if (holds(permissions, key)) {
        req.adminPermissions = permissions;
        return next();
      }

      return res.status(403).json({
        status: 'error',
        message: `Your role does not allow this (${key}). Ask an owner to change it.`,
        permission: key,
      });
    } catch (err) {
      console.error('[permissions] guard failed:', err.message);
      // Fail closed. An error reading roles must never become free access.
      return res.status(403).json({
        status: 'error',
        message: 'Could not verify your permissions, so the request was refused.',
      });
    }
  };
}

/** Everything one admin can do, for the UI to hide what it should. */
async function describeAdmin(roleKey) {
  const permissions = await permissionsFor(roleKey);
  const isOwner = permissions.includes('*');
  return {
    roleKey: roleKey || null,
    permissions: isOwner ? ALL_KEYS : permissions,
    isOwner,
  };
}

/** Reject anything not in the catalogue, so a typo cannot become a permission. */
function sanitisePermissions(requested) {
  if (!Array.isArray(requested)) return [];
  if (requested.includes('*')) return ['*'];
  return [...new Set(requested.filter((k) => ALL_KEYS.includes(k)))];
}

module.exports = {
  CATALOGUE,
  ALL_KEYS,
  parsePermissions,
  permissionsFor,
  can,
  holds,
  requirePermission,
  describeAdmin,
  sanitisePermissions,
  clearPermissionCache,
};
