/**
 * TOTP (RFC 6238) for admin two-factor auth.
 *
 * Written against the spec rather than pulled from a package: it is ~40 lines
 * of `crypto`, it has published test vectors we verify against, and it keeps a
 * security-critical path free of a dependency we would have to keep patched.
 *
 * Compatible with Google Authenticator, Authy, 1Password and anything else that
 * speaks otpauth:// — SHA-1, 6 digits, 30-second period.
 */

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

/** Base32 (RFC 4648, no padding) — what authenticator apps expect. */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const output = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** A fresh 20-byte secret, base32 encoded. */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HOTP: the counter-based primitive TOTP is built on. */
function hotp(secretBuffer, counter, digits = DIGITS, algorithm = 'sha1') {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac(algorithm, secretBuffer).update(counterBuffer).digest();

  // Dynamic truncation (RFC 4226 §5.4)
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code for a moment in time. */
function generate(secret, { at = Date.now(), period = PERIOD, digits = DIGITS, algorithm = 'sha1' } = {}) {
  const counter = Math.floor(at / 1000 / period);
  return hotp(base32Decode(secret), counter, digits, algorithm);
}

/**
 * Check a code, allowing for clock drift.
 *
 * `window: 1` accepts the previous and next step as well as the current one —
 * about 90 seconds of tolerance, which is the usual trade-off between phones
 * with a slightly wrong clock and keeping the window tight.
 *
 * Compared in constant time so a wrong code leaks nothing by how long it took.
 */
function verify(secret, token, { window = 1, at = Date.now(), period = PERIOD, digits = DIGITS } = {}) {
  const candidate = String(token || '').replace(/\s+/g, '');
  if (!/^\d+$/.test(candidate) || candidate.length !== digits) return false;

  const secretBuffer = base32Decode(secret);
  const counter = Math.floor(at / 1000 / period);

  for (let drift = -window; drift <= window; drift += 1) {
    const expected = hotp(secretBuffer, counter + drift, digits);
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans. */
function keyUri({ secret, account, issuer = 'Holiday Seychelles' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Secret shown to a human, in readable blocks. */
function formatSecret(secret) {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/** Seconds until the current code rolls over — drives the UI countdown. */
function secondsRemaining(at = Date.now()) {
  return PERIOD - (Math.floor(at / 1000) % PERIOD);
}

module.exports = {
  generateSecret,
  generate,
  verify,
  keyUri,
  formatSecret,
  secondsRemaining,
  base32Encode,
  base32Decode,
  hotp,
  PERIOD,
  DIGITS,
};
