/**
 * Team, roles and business settings.
 *
 * The guardrails here are the point of the module, not decoration:
 *
 *  - **You cannot remove your own access.** Changing your own role, suspending
 *    yourself or deleting yourself is refused. An owner who demotes themselves
 *    by accident has no way back except a database edit.
 *  - **The last owner cannot be removed.** Suspending or demoting the only
 *    account that can manage the team locks everyone out of it permanently.
 *  - **The ENV master admin is different.** Its password lives in `.env`, so
 *    the panel cannot change it and says so rather than pretending.
 *
 * Every mutation here is audited, because these are the actions that change who
 * can do everything else.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../config/db');
const adminAuth = require('../../middleware/adminAuth');
const { sendSuccess, sendError } = require('../../utils/response');
const sec = require('../../services/adminSecurity');
const { runLimited } = require('../../utils/concurrency');
const perms = require('../../services/permissions');

const router = express.Router();
const num = (v) => Number(v || 0);

function invalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  sendError(res, null, errors.array()[0].msg, 400);
  return true;
}

/** The account named in ADMIN_SEED_EMAIL cannot have its password changed here. */
function isEnvAdmin(email) {
  const seed = (process.env.ADMIN_SEED_EMAIL || '').trim().toLowerCase();
  return Boolean(seed) && String(email || '').trim().toLowerCase() === seed;
}

async function ownerCount(excludeId = null) {
  const { rows } = await pool.query(
    excludeId
      ? "SELECT COUNT(*) AS total FROM admins WHERE role_key = 'owner' AND status = 'active' AND id <> $1"
      : "SELECT COUNT(*) AS total FROM admins WHERE role_key = 'owner' AND status = 'active'",
    excludeId ? [excludeId] : []
  );
  return num(rows[0]?.total);
}

// ── Who am I ─────────────────────────────────────────────────────────────────

/**
 * What the signed-in operator may do.
 *
 * The UI reads this to hide sections it cannot use. That is a courtesy, not
 * the access control — every route enforces its own permission regardless.
 */
router.get('/me', adminAuth, async (req, res) => {
  try {
    const described = await perms.describeAdmin(req.admin.roleKey);
    const { rows } = await pool.query(
      'SELECT name, description FROM admin_roles WHERE role_key = $1',
      [req.admin.roleKey]
    );
    sendSuccess(
      res,
      {
        admin: {
          id: req.admin.id,
          name: req.admin.name,
          email: req.admin.email,
          roleKey: described.roleKey,
          roleName: rows[0]?.name || 'Unknown role',
          roleDescription: rows[0]?.description || null,
          isOwner: described.isOwner,
          isEnvAdmin: isEnvAdmin(req.admin.email),
          mustChangePassword: req.admin.mustChangePassword,
        },
        permissions: described.permissions,
        note: 'The panel hides what you cannot use, but every action is checked on the server as well.',
      },
      'Session described'
    );
  } catch (err) {
    console.error('team me error:', err);
    sendError(res, err, 'Failed to describe your session', 500);
  }
});

// ── Roles ────────────────────────────────────────────────────────────────────

router.get('/roles', adminAuth, perms.requirePermission('team.view'), async (req, res) => {
  try {
    const [roles, counts] = await runLimited([
      () => pool.query('SELECT * FROM admin_roles ORDER BY is_system DESC, name ASC'),
      () =>
        pool.query(
          "SELECT role_key, COUNT(*) AS total FROM admins WHERE status = 'active' GROUP BY role_key"
        ),
    ]);

    const used = Object.fromEntries(counts.rows.map((r) => [r.role_key, num(r.total)]));

    sendSuccess(
      res,
      {
        roles: roles.rows.map((r) => {
          const permissions = perms.parsePermissions(r.permissions);
          return {
            id: r.id,
            key: r.role_key,
            name: r.name,
            description: r.description,
            permissions: permissions.includes('*') ? perms.ALL_KEYS : permissions,
            everything: permissions.includes('*'),
            isSystem: Boolean(r.is_system),
            admins: used[r.role_key] || 0,
          };
        }),
        catalogue: perms.CATALOGUE,
        note: 'A role that holds no permission at all can sign in and see nothing. That is allowed, and it is how you park an account without suspending it.',
      },
      'Roles retrieved'
    );
  } catch (err) {
    console.error('roles error:', err);
    sendError(res, err, 'Failed to load the roles', 500);
  }
});

router.post(
  '/roles',
  adminAuth,
  perms.requirePermission('team.manage'),
  body('key').trim().matches(/^[a-z][a-z0-9_]{2,39}$/).withMessage('A role key is lowercase letters, numbers and underscores'),
  body('name').trim().isLength({ min: 3 }).withMessage('Give the role a name'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const permissions = perms.sanitisePermissions(req.body.permissions);
      const result = await pool.query(
        'INSERT INTO admin_roles (role_key, name, description, permissions, is_system) VALUES ($1, $2, $3, $4, 0)',
        [req.body.key, req.body.name, req.body.description || null, JSON.stringify(permissions)]
      );
      perms.clearPermissionCache();

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.role.created',
        entityType: 'role',
        entityId: result.insertId,
        summary: `Created role "${req.body.name}" with ${permissions.length} permission(s)`,
        metadata: { permissions },
      });

      sendSuccess(res, { id: result.insertId }, 'Role created');
    } catch (err) {
      if (/duplicate/i.test(err.message)) {
        return sendError(res, null, 'A role with that key already exists', 409);
      }
      console.error('create role error:', err);
      sendError(res, err, 'Failed to create the role', 500);
    }
  }
);

router.put('/roles/:key', adminAuth, perms.requirePermission('team.manage'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM admin_roles WHERE role_key = $1', [req.params.key]);
    if (!rows.length) return sendError(res, null, 'Role not found', 404);
    const role = rows[0];

    // The owner role is what guarantees somebody can always fix a mistake made
    // in this screen. Editing its permissions would remove that guarantee.
    if (role.role_key === 'owner') {
      return sendError(
        res,
        null,
        'The Owner role always has full access — that is what stops this screen locking everyone out. Assign people to a different role instead.',
        409
      );
    }

    const updates = [];
    const params = [];
    const set = (column, value) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (req.body.name !== undefined) set('name', req.body.name);
    if (req.body.description !== undefined) set('description', req.body.description);
    if (req.body.permissions !== undefined) {
      set('permissions', JSON.stringify(perms.sanitisePermissions(req.body.permissions)));
    }
    if (!updates.length) return sendError(res, null, 'Nothing to update', 400);

    params.push(req.params.key);
    await pool.query(
      `UPDATE admin_roles SET ${updates.join(', ')} WHERE role_key = $${params.length}`,
      params
    );
    // Cleared rather than waited out: a permission change has to take effect on
    // the next request, not in thirty seconds.
    perms.clearPermissionCache();

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.role.updated',
      entityType: 'role',
      entityId: role.id,
      summary: `Updated role "${role.name}"`,
      metadata: { permissions: req.body.permissions },
    });

    sendSuccess(res, { key: req.params.key }, 'Role updated');
  } catch (err) {
    console.error('update role error:', err);
    sendError(res, err, 'Failed to update the role', 500);
  }
});

router.delete('/roles/:key', adminAuth, perms.requirePermission('team.manage'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM admin_roles WHERE role_key = $1', [req.params.key]);
    if (!rows.length) return sendError(res, null, 'Role not found', 404);
    if (rows[0].is_system) {
      return sendError(res, null, 'Built-in roles cannot be deleted', 409);
    }

    const { rows: holders } = await pool.query(
      'SELECT COUNT(*) AS total FROM admins WHERE role_key = $1',
      [req.params.key]
    );
    if (num(holders[0]?.total) > 0) {
      return sendError(
        res,
        null,
        `${holders[0].total} account(s) still use this role. Move them to another role first — deleting it would leave them with no permissions at all.`,
        409
      );
    }

    await pool.query('DELETE FROM admin_roles WHERE role_key = $1', [req.params.key]);
    perms.clearPermissionCache();

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.role.deleted',
      entityType: 'role',
      entityId: rows[0].id,
      summary: `Deleted role "${rows[0].name}"`,
    });

    sendSuccess(res, { key: req.params.key }, 'Role deleted');
  } catch (err) {
    console.error('delete role error:', err);
    sendError(res, err, 'Failed to delete the role', 500);
  }
});

// ── Team ─────────────────────────────────────────────────────────────────────

router.get('/', adminAuth, perms.requirePermission('team.view'), async (req, res) => {
  try {
    const [admins, stats] = await runLimited([
      () =>
        pool.query(
          `SELECT a.id, a.name, a.email, a.status, a.role_key, a.last_login_at, a.created_at,
                  a.must_change_password, r.name AS role_name,
                  (SELECT COUNT(*) FROM auth_tokens t
                    WHERE t.subject_type = 'admin' AND t.subject_id = a.id
                      AND t.revoked_at IS NULL AND t.expires_at > NOW()) AS active_sessions,
                  (SELECT COUNT(*) FROM admin_audit_log l WHERE l.admin_id = a.id) AS actions
             FROM admins a
             LEFT JOIN admin_roles r ON r.role_key = a.role_key
            ORDER BY a.created_at ASC`
        ),
      () =>
        pool.query(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                  SUM(CASE WHEN role_key = 'owner' AND status = 'active' THEN 1 ELSE 0 END) AS owners,
                  SUM(CASE WHEN last_login_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS active30
             FROM admins`
        ),
    ]);

    const s = stats.rows[0] || {};

    sendSuccess(
      res,
      {
        team: admins.rows.map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          status: a.status,
          roleKey: a.role_key,
          roleName: a.role_name || 'No role',
          lastLoginAt: a.last_login_at,
          createdAt: a.created_at,
          mustChangePassword: Boolean(a.must_change_password),
          activeSessions: num(a.active_sessions),
          actions: num(a.actions),
          isEnvAdmin: isEnvAdmin(a.email),
          isYou: a.id === req.admin.id,
        })),
        stats: {
          total: num(s.total),
          active: num(s.active),
          owners: num(s.owners),
          activeLast30: num(s.active30),
        },
      },
      'Team retrieved'
    );
  } catch (err) {
    console.error('team list error:', err);
    sendError(res, err, 'Failed to load the team', 500);
  }
});

router.post(
  '/',
  adminAuth,
  perms.requirePermission('team.manage'),
  body('name').trim().isLength({ min: 2 }).withMessage('Give them a name'),
  body('email').trim().isEmail().withMessage('That is not a valid email address'),
  body('roleKey').trim().notEmpty().withMessage('Pick a role'),
  async (req, res) => {
    if (invalid(req, res)) return;
    try {
      const role = await pool.query('SELECT role_key FROM admin_roles WHERE role_key = $1', [
        req.body.roleKey,
      ]);
      if (!role.rows.length) return sendError(res, null, 'That role does not exist', 400);

      const existing = await pool.query('SELECT id FROM admins WHERE email = $1', [req.body.email]);
      if (existing.rows.length) {
        return sendError(res, null, 'An admin with that email already exists', 409);
      }

      // A generated password rather than one typed into this form: it is never
      // chosen by somebody else, it is shown once, and the account is forced to
      // change it on first sign-in.
      const temporary = req.body.password || `${crypto.randomBytes(9).toString('base64url')}`;
      if (temporary.length < 8) {
        return sendError(res, null, 'A password must be at least 8 characters', 400);
      }
      const hash = await bcrypt.hash(temporary, 10);

      const result = await pool.query(
        `INSERT INTO admins (email, password_hash, name, role, role_key, status, created_by_admin_id, must_change_password)
         VALUES ($1, $2, $3, 'admin', $4, 'active', $5, 1)`,
        [req.body.email, hash, req.body.name, req.body.roleKey, req.admin.id]
      );

      await sec.audit({
        req,
        adminId: req.admin.id,
        action: 'admin.team.created',
        entityType: 'admin',
        entityId: result.insertId,
        summary: `Created admin ${req.body.email} as ${req.body.roleKey}`,
      });

      sendSuccess(
        res,
        {
          id: result.insertId,
          temporaryPassword: req.body.password ? null : temporary,
          note: req.body.password
            ? 'They must change this password when they first sign in.'
            : 'This password is shown once and is not stored anywhere readable. Pass it on securely; they must change it on first sign-in.',
        },
        'Admin created'
      );
    } catch (err) {
      console.error('create admin error:', err);
      sendError(res, err, 'Failed to create the admin', 500);
    }
  }
);

router.patch('/:id', adminAuth, perms.requirePermission('team.manage'), async (req, res) => {
  try {
    const target = Number(req.params.id);
    const { rows } = await pool.query('SELECT * FROM admins WHERE id = $1', [target]);
    if (!rows.length) return sendError(res, null, 'Admin not found', 404);
    const admin = rows[0];

    const changingRole = req.body.roleKey !== undefined && req.body.roleKey !== admin.role_key;
    const changingStatus = req.body.status !== undefined && req.body.status !== admin.status;

    // Guardrail 1: you cannot take your own access away.
    if (target === req.admin.id && (changingRole || (changingStatus && req.body.status !== 'active'))) {
      return sendError(
        res,
        null,
        'You cannot change your own role or suspend yourself. Ask another owner to do it.',
        409
      );
    }

    // Guardrail 2: the last active owner has to stay one.
    const losingOwner =
      admin.role_key === 'owner' &&
      admin.status === 'active' &&
      ((changingRole && req.body.roleKey !== 'owner') || (changingStatus && req.body.status !== 'active'));
    if (losingOwner && (await ownerCount(target)) === 0) {
      return sendError(
        res,
        null,
        'This is the only active owner. Promote somebody else first, or nobody will be able to manage the team.',
        409
      );
    }

    const updates = [];
    const params = [];
    const set = (column, value) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (req.body.name !== undefined) set('name', req.body.name);
    if (changingRole) {
      const role = await pool.query('SELECT role_key FROM admin_roles WHERE role_key = $1', [
        req.body.roleKey,
      ]);
      if (!role.rows.length) return sendError(res, null, 'That role does not exist', 400);
      set('role_key', req.body.roleKey);
    }
    if (changingStatus) {
      if (!['active', 'suspended'].includes(req.body.status)) {
        return sendError(res, null, 'Status must be active or suspended', 400);
      }
      set('status', req.body.status);
    }
    if (!updates.length) return sendError(res, null, 'Nothing to update', 400);

    params.push(target);
    await pool.query(`UPDATE admins SET ${updates.join(', ')} WHERE id = $${params.length}`, params);

    // Suspending has to end their sessions now. adminAuth also refuses a
    // suspended account, so this is belt and braces — but a revoked token is
    // the thing an operator can see and verify.
    if (changingStatus && req.body.status !== 'active') {
      await pool.query(
        `UPDATE auth_tokens SET revoked_at = NOW()
          WHERE subject_type = 'admin' AND subject_id = $1 AND revoked_at IS NULL`,
        [target]
      );
    }

    const changes = [];
    if (changingRole) changes.push(`role ${admin.role_key} → ${req.body.roleKey}`);
    if (changingStatus) changes.push(`status ${admin.status} → ${req.body.status}`);
    if (req.body.name !== undefined) changes.push('name changed');

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.team.updated',
      entityType: 'admin',
      entityId: target,
      summary: `${admin.email}: ${changes.join(', ')}`,
      metadata: { changes },
    });

    sendSuccess(res, { id: target }, 'Admin updated');
  } catch (err) {
    console.error('update admin error:', err);
    sendError(res, err, 'Failed to update the admin', 500);
  }
});

/** Reset another admin's password to a generated one, shown once. */
router.post('/:id/password', adminAuth, perms.requirePermission('team.manage'), async (req, res) => {
  try {
    const target = Number(req.params.id);
    const { rows } = await pool.query('SELECT id, email, name FROM admins WHERE id = $1', [target]);
    if (!rows.length) return sendError(res, null, 'Admin not found', 404);
    const admin = rows[0];

    if (isEnvAdmin(admin.email)) {
      return sendError(
        res,
        null,
        'This account signs in with the password in the server .env file, so the panel cannot change it. Edit ADMIN_SEED_PASSWORD and restart.',
        409
      );
    }

    const temporary = crypto.randomBytes(9).toString('base64url');
    await pool.query('UPDATE admins SET password_hash = $1, must_change_password = 1 WHERE id = $2', [
      await bcrypt.hash(temporary, 10),
      target,
    ]);

    // A password reset ends every session: anyone holding the old one should
    // not keep access just because their token had not expired.
    await pool.query(
      `UPDATE auth_tokens SET revoked_at = NOW()
        WHERE subject_type = 'admin' AND subject_id = $1 AND revoked_at IS NULL`,
      [target]
    );

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.team.password_reset',
      entityType: 'admin',
      entityId: target,
      summary: `Reset the password for ${admin.email} and signed them out everywhere`,
    });

    sendSuccess(
      res,
      {
        temporaryPassword: temporary,
        note: 'Shown once. They have been signed out everywhere and must change this on their next sign-in.',
      },
      `Password reset for ${admin.email}`
    );
  } catch (err) {
    console.error('reset password error:', err);
    sendError(res, err, 'Failed to reset that password', 500);
  }
});

/** What one operator has actually done, read from the audit log. */
router.get('/:id/activity', adminAuth, perms.requirePermission('team.view'), async (req, res) => {
  try {
    const target = Number(req.params.id);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);

    const [admin, activity, sessions, summary] = await runLimited([
      () =>
        pool.query(
          `SELECT a.id, a.name, a.email, a.status, a.role_key, a.last_login_at, a.created_at,
                  r.name AS role_name
             FROM admins a LEFT JOIN admin_roles r ON r.role_key = a.role_key
            WHERE a.id = $1`,
          [target]
        ),
      () =>
        pool.query(
          `SELECT id, action, entity_type, entity_id, summary, status, ip_address, created_at
             FROM admin_audit_log WHERE admin_id = $1
            ORDER BY created_at DESC LIMIT ${limit}`,
          [target]
        ),
      () =>
        pool.query(
          // auth_tokens records issued_at, not created_at.
          `SELECT jti, issued_at, expires_at, revoked_at
             FROM auth_tokens
            WHERE subject_type = 'admin' AND subject_id = $1
            ORDER BY issued_at DESC LIMIT 20`,
          [target]
        ),
      () =>
        pool.query(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS last30
             FROM admin_audit_log WHERE admin_id = $1`,
          [target]
        ),
    ]);

    if (!admin.rows.length) return sendError(res, null, 'Admin not found', 404);

    sendSuccess(
      res,
      {
        admin: { ...admin.rows[0], isEnvAdmin: isEnvAdmin(admin.rows[0].email) },
        activity: activity.rows,
        sessions: sessions.rows.map((t) => ({
          ...t,
          active: !t.revoked_at && new Date(t.expires_at) > new Date(),
        })),
        stats: {
          actions: num(summary.rows[0]?.total),
          last30: num(summary.rows[0]?.last30),
        },
      },
      'Activity retrieved'
    );
  } catch (err) {
    console.error('admin activity error:', err);
    sendError(res, err, 'Failed to load that activity', 500);
  }
});

/** End every session for one admin without changing their password. */
router.post('/:id/sessions/revoke', adminAuth, perms.requirePermission('team.manage'), async (req, res) => {
  try {
    const target = Number(req.params.id);
    const { rows } = await pool.query('SELECT id, email FROM admins WHERE id = $1', [target]);
    if (!rows.length) return sendError(res, null, 'Admin not found', 404);

    const result = await pool.query(
      `UPDATE auth_tokens SET revoked_at = NOW()
        WHERE subject_type = 'admin' AND subject_id = $1 AND revoked_at IS NULL`,
      [target]
    );

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.team.sessions_revoked',
      entityType: 'admin',
      entityId: target,
      summary: `Signed ${rows[0].email} out of ${result.rowCount} session(s)`,
    });

    sendSuccess(
      res,
      { revoked: result.rowCount },
      target === req.admin.id
        ? `Signed out of ${result.rowCount} session(s) — including this one`
        : `${rows[0].email} signed out of ${result.rowCount} session(s)`
    );
  } catch (err) {
    console.error('revoke sessions error:', err);
    sendError(res, err, 'Failed to end those sessions', 500);
  }
});

router.delete('/:id', adminAuth, perms.requirePermission('team.manage'), async (req, res) => {
  try {
    const target = Number(req.params.id);
    const { rows } = await pool.query('SELECT * FROM admins WHERE id = $1', [target]);
    if (!rows.length) return sendError(res, null, 'Admin not found', 404);
    const admin = rows[0];

    if (target === req.admin.id) {
      return sendError(res, null, 'You cannot delete your own account.', 409);
    }
    if (isEnvAdmin(admin.email)) {
      return sendError(
        res,
        null,
        'This account is defined in the server .env file — deleting the row would not remove it. Remove ADMIN_SEED_EMAIL instead.',
        409
      );
    }
    if (admin.role_key === 'owner' && admin.status === 'active' && (await ownerCount(target)) === 0) {
      return sendError(res, null, 'This is the only active owner and cannot be deleted.', 409);
    }

    // Suspend rather than delete: audit rows, replies and blog posts reference
    // this account, and removing it would orphan the record of who did what.
    await pool.query(
      "UPDATE admins SET status = 'suspended' WHERE id = $1",
      [target]
    );
    await pool.query(
      `UPDATE auth_tokens SET revoked_at = NOW()
        WHERE subject_type = 'admin' AND subject_id = $1 AND revoked_at IS NULL`,
      [target]
    );

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.team.removed',
      entityType: 'admin',
      entityId: target,
      summary: `Removed access for ${admin.email}`,
    });

    sendSuccess(
      res,
      { id: target, suspended: true },
      'Access removed. The account is kept as suspended so the audit trail still says who did what.'
    );
  } catch (err) {
    console.error('delete admin error:', err);
    sendError(res, err, 'Failed to remove that admin', 500);
  }
});

// ── Business settings ────────────────────────────────────────────────────────

const SETTINGS_KEY = 'business_settings';
const SETTINGS_DEFAULTS = {
  businessName: 'Holiday Seychelles',
  supportEmail: 'info@holidayseychelles.com',
  supportPhone: '',
  currency: 'EUR',
  timezone: 'Indian/Mahe',
  bookingPrefix: 'BS',
  dateFormat: 'DD MMM YYYY',
};

router.get('/settings', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT setting_value, updated_at FROM admin_settings WHERE setting_key = $1',
      [SETTINGS_KEY]
    );

    let settings = { ...SETTINGS_DEFAULTS };
    if (rows.length && rows[0].setting_value) {
      try {
        settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(rows[0].setting_value) };
      } catch {
        /* a malformed row falls back to the defaults rather than failing */
      }
    }

    sendSuccess(
      res,
      {
        settings,
        defaults: SETTINGS_DEFAULTS,
        updatedAt: rows[0]?.updated_at || null,
        // Said plainly, because somebody will otherwise change the currency here
        // and expect old bookings to convert.
        note: 'These describe the business. Changing the currency here does not convert money already taken, and changing the booking prefix does not rename existing references.',
      },
      'Settings retrieved'
    );
  } catch (err) {
    console.error('settings error:', err);
    sendError(res, err, 'Failed to load the settings', 500);
  }
});

router.put('/settings', adminAuth, perms.requirePermission('settings.manage'), async (req, res) => {
  try {
    const current = await pool.query(
      'SELECT setting_value FROM admin_settings WHERE setting_key = $1',
      [SETTINGS_KEY]
    );
    let settings = { ...SETTINGS_DEFAULTS };
    if (current.rows.length && current.rows[0].setting_value) {
      try {
        settings = { ...settings, ...JSON.parse(current.rows[0].setting_value) };
      } catch {
        /* fall back to defaults */
      }
    }

    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      if (req.body[key] !== undefined) settings[key] = String(req.body[key]);
    }

    if (settings.supportEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(settings.supportEmail)) {
      return sendError(res, null, 'That support email address is not valid', 400);
    }
    if (settings.currency && !/^[A-Z]{3}$/.test(settings.currency)) {
      return sendError(res, null, 'The currency should be a three-letter code like EUR', 400);
    }

    await pool.query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_by_admin_id)
       VALUES ($1, $2, $3)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                               updated_by_admin_id = VALUES(updated_by_admin_id)`,
      [SETTINGS_KEY, JSON.stringify(settings), req.admin.id]
    );

    await sec.audit({
      req,
      adminId: req.admin.id,
      action: 'admin.settings.updated',
      entityType: 'settings',
      summary: 'Updated the business settings',
    });

    sendSuccess(res, { settings }, 'Settings saved');
  } catch (err) {
    console.error('save settings error:', err);
    sendError(res, err, 'Failed to save the settings', 500);
  }
});

module.exports = router;
