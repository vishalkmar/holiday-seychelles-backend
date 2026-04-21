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

function signAdminToken(adminId) {
  const jti = uuidv4();
  const payload = {
    jti,
    type: 'admin',
    sub: adminId,
    iat: Math.floor(Date.now() / 1000),
  };
  const token = jwt.sign(payload, process.env.JWT_ADMIN_SECRET || 'dev_admin_secret', {
    expiresIn: process.env.JWT_ADMIN_EXPIRES_IN || '1d',
  });
  return { token, jti, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
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
