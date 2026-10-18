/**
 * TTL for one-time codes and sessions (extra track 2.6).
 *
 * Every code already stops working at its expires_at (OTPs: OTP_TTL_MINUTES,
 * default 10). This job deletes the rows once they are useless, so the tables
 * stay small: every 15 minutes, in batches, each table with its own grace
 * period (an expired login token is kept a week so "signed out" reads right).
 */

const { pool } = require('../config/db');

const RULES = [
  { table: 'email_otps', where: 'expires_at < (NOW() - INTERVAL 1 HOUR)' },
  { table: 'admin_mfa_challenges', where: 'expires_at < (NOW() - INTERVAL 1 HOUR)' },
  { table: 'rag_stepup_challenges', where: 'expires_at < (NOW() - INTERVAL 1 HOUR)' },
  { table: 'rag_change_tokens', where: 'expires_at < (NOW() - INTERVAL 1 HOUR)' },
  { table: 'auth_tokens', where: 'expires_at < (NOW() - INTERVAL 7 DAY)' },
];
const BATCH = 2000;
const EVERY_MS = 15 * 60 * 1000;

async function sweep() {
  const removed = {};
  for (const r of RULES) {
    let n = 0;
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await pool.query(`DELETE FROM ${r.table} WHERE ${r.where} LIMIT ${BATCH}`).catch((err) => {
        if (!/doesn't exist/i.test(err.message)) console.error(`[cleanup] ${r.table}:`, err.message);
        return null;
      });
      const affected = Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? res?.rowCount ?? 0);
      n += affected;
      if (affected < BATCH) break;
    }
    if (n) removed[r.table] = n;
  }
  if (Object.keys(removed).length) console.log('[cleanup] expired rows removed:', JSON.stringify(removed));
  return removed;
}

let timer = null;
function startExpiryCleanup() {
  if (timer || process.env.EXPIRY_CLEANUP_ENABLED === 'false') return;
  setTimeout(() => sweep().catch(() => {}), 60 * 1000).unref?.();
  timer = setInterval(() => sweep().catch(() => {}), EVERY_MS);
  timer.unref?.();
}

module.exports = { sweep, startExpiryCleanup, RULES };
