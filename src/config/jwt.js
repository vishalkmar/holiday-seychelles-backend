module.exports = {
  userSecret: process.env.JWT_USER_SECRET || 'dev_user_secret',
  adminSecret: process.env.JWT_ADMIN_SECRET || 'dev_admin_secret',
  userExpiresIn: process.env.JWT_USER_EXPIRES_IN || '30d',
  adminExpiresIn: process.env.JWT_ADMIN_EXPIRES_IN || '1d',
};
