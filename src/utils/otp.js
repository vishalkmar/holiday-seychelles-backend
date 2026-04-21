const crypto = require('crypto');

function generateOTP(length = 6) {
  return Math.floor(10 ** (length - 1) + Math.random() * (10 ** length - 10 ** (length - 1)))
    .toString()
    .slice(0, length);
}

function hashOTP(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

function verifyOTP(plainOTP, storedHash) {
  const plainHash = hashOTP(plainOTP);
  return plainHash === storedHash;
}

module.exports = { generateOTP, hashOTP, verifyOTP };
