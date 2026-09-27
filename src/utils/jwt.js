const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

function signUserToken(userId) {
  const jti = uuidv4();
  const payload = {
    jti,
    type: 'user',
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
  };
  const token = jwt.sign(payload, process.env.JWT_USER_SECRET || 'dev_user_secret', {
    expiresIn: process.env.JWT_USER_EXPIRES_IN || '30d',
  });
  return { token, jti, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) };
}

/**
 * Sign an admin session.
 *
 * `remember` is the "keep me signed in" box on the login page. It lengthens the
 * session, but only to a limit the SERVER decides
 * (`JWT_ADMIN_REMEMBER_EXPIRES_IN`, 7 days by default) — the client asks, it
 * does not choose. Set that env to the normal expiry to switch the feature off
 * entirely without touching the UI.
 */
function signAdminToken(adminId, { remember = false } = {}) {
  const jti = uuidv4();
  const payload = {
    jti,
    type: 'admin',
    sub: adminId,
    iat: Math.floor(Date.now() / 1000),
  };

  const normal = process.env.JWT_ADMIN_EXPIRES_IN || '1d';
  const extended = process.env.JWT_ADMIN_REMEMBER_EXPIRES_IN || '7d';
  const expiresIn = remember ? extended : normal;

  const token = jwt.sign(payload, process.env.JWT_ADMIN_SECRET || 'dev_admin_secret', {
    expiresIn,
  });

  // The auth_tokens row has to agree with the JWT, or a revoked-token check
  // reads an expiry the token itself does not have.
  const days = /^(\d+)d$/.exec(expiresIn);
  const hours = /^(\d+)h$/.exec(expiresIn);
  const ms = days
    ? Number(days[1]) * 24 * 60 * 60 * 1000
    : hours
      ? Number(hours[1]) * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;

  return { token, jti, expiresAt: new Date(Date.now() + ms) };
}

function verifyUserToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_USER_SECRET || 'dev_user_secret');
  } catch (err) {
    return null;
  }
}

function verifyAdminToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_ADMIN_SECRET || 'dev_admin_secret');
  } catch (err) {
    return null;
  }
}

module.exports = { signUserToken, signAdminToken, verifyUserToken, verifyAdminToken };
