const { verifyAdminToken } = require('../utils/jwt');
const { pool } = require('../config/db');

/**
 * Authenticate an admin request.
 *
 * Three things are checked, in one query rather than three:
 *
 *  1. the token verifies and has not been revoked;
 *  2. the account still exists;
 *  3. the account is still active — a suspended operator's existing token must
 *     stop working immediately, not when it happens to expire. Without this,
 *     "suspend" would mean "cannot sign in again", which is not the same thing
 *     as "cannot do anything".
 *
 * `req.admin` carries the account's name, email and role because routes use
 * them for audit summaries and permission checks; it used to hold only an id,
 * so those summaries recorded `undefined`.
 */
async function adminAuth(req, res, next) {
  try {
    // Idempotent: the permission guard runs this at the mount, and each router
    // still lists it per route. Doing the lookup twice would double the
    // database work on every admin request for no benefit.
    if (req.admin?.id) return next();

    const token = req.cookies.adminToken || req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ status: 'error', message: 'Missing authentication token' });
    }

    const decoded = verifyAdminToken(token);
    if (!decoded) {
      return res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
    }

    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.email, a.status, a.role, a.role_key, a.must_change_password,
              t.revoked_at
         FROM admins a
         LEFT JOIN auth_tokens t ON t.jti = $2
        WHERE a.id = $1`,
      [decoded.sub, decoded.jti]
    );

    if (!rows.length) {
      return res.status(401).json({ status: 'error', message: 'This admin account no longer exists' });
    }

    const admin = rows[0];

    // Status is checked BEFORE revocation on purpose. Suspending an account
    // also revokes its tokens, so the other order would always answer "token
    // revoked" — true, but it sends the operator looking for a session problem
    // instead of telling them their access was withdrawn.
    if (admin.status && admin.status !== 'active') {
      return res.status(401).json({
        status: 'error',
        message: 'This admin account has been suspended. Ask an owner to reactivate it.',
      });
    }

    if (admin.revoked_at) {
      return res.status(401).json({ status: 'error', message: 'Token has been revoked' });
    }

    req.admin = {
      id: admin.id,
      jti: decoded.jti,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      // Falls back to 'owner' only for a row that predates roles entirely; the
      // migration backfills every existing account, so this is belt and braces.
      roleKey: admin.role_key || 'owner',
      mustChangePassword: Boolean(admin.must_change_password),
    };
    next();
  } catch (err) {
    console.error('adminAuth error:', err.message);
    res.status(500).json({ status: 'error', message: 'Auth error', error: err.message });
  }
}

module.exports = adminAuth;
