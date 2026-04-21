const { verifyUserToken } = require('../utils/jwt');
const { pool } = require('../config/db');

async function userAuth(req, res, next) {
  try {
    const token = req.cookies.userToken || req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ status: 'error', message: 'Missing authentication token' });
    }

    const decoded = verifyUserToken(token);
    if (!decoded) {
      return res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
    }

    // Check if token is revoked in auth_tokens table
    const { rows } = await pool.query(
      'SELECT revoked_at FROM auth_tokens WHERE jti = $1',
      [decoded.jti]
    );
    if (rows.length > 0 && rows[0].revoked_at) {
      return res.status(401).json({ status: 'error', message: 'Token has been revoked' });
    }

    req.user = { id: decoded.sub, jti: decoded.jti };
    next();
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Auth error', error: err.message });
  }
}

module.exports = userAuth;
