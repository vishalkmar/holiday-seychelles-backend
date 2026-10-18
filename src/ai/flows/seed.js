/**
 * Default flows (Phase 18): Hotels, Excursions, Transfers, Explore islands,
 * Talk to us, My bookings — `flows/defaults/*.json`.
 *
 *   install({ force }) — saves and publishes each default. Without `force` a flow
 *   that already exists is left alone (the owner may have edited it); with
 *   `force` the default is published as a new version (old ones stay in History).
 *
 * CLI:  node src/ai/flows/seed.js [--force]
 * Admin: Bot Connection → "Install default flows".
 */

if (require.main === module) require('dotenv').config();

const fs = require('fs');
const path = require('path');
const store = require('./store');

const DIR = path.join(__dirname, 'defaults');

function defaults() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
}

async function install({ force = false, adminId = null } = {}) {
  const results = [];
  for (const g of defaults()) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await store.get(g.key);
    if (existing && !force) {
      results.push({ key: g.key, action: 'kept', version: existing.publishedVersion });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await store.saveDraft(g, adminId);
    // eslint-disable-next-line no-await-in-loop
    const r = await store.publish(g.key, adminId, existing ? 'Default flow (reinstalled)' : 'Default flow');
    results.push({ key: g.key, action: existing ? 'updated' : 'installed', version: r.version, warnings: r.check.warnings });
  }
  return results;
}

module.exports = { install, defaults };

if (require.main === module) {
  install({ force: process.argv.includes('--force') })
    .then((r) => r.forEach((x) => console.log(`${x.key}: ${x.action}${x.version ? ` v${x.version}` : ''}${x.warnings?.length ? ` (${x.warnings.length} warnings)` : ''}`)))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => require('../../config/db').pool.end?.());
}
