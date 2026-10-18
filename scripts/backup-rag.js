/**
 * Back up the AI assistant: every AI table (rag_*, chat_*, bot_*) as JSON lines,
 * plus the private document folder (storage/rag). Read-only on the database.
 *
 *   node scripts/backup-rag.js [outDir]        default: backups/rag-YYYY-MM-DD-HHMM
 *
 * Restore (or just verify a backup) with scripts/restore-rag.js.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../src/ai/ports');
const { AI_MIGRATIONS } = require('../src/ai/db');
const config = require('../src/ai/config');

const MIGRATIONS = path.join(__dirname, '..', 'src', 'migrations');
const PAGE = 500;

/** Table names created by the AI migrations, in creation order. */
function aiTables() {
  const names = [];
  for (const f of AI_MIGRATIONS) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?/gi)) if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** Buffers (embeddings) → { $b64 } so JSON keeps them byte for byte. */
const encode = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v instanceof Date ? { $date: v.toISOString() } : v]));

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyDir(a, b);
    else { fs.copyFileSync(a, b); n += 1; }
  }
  return n;
}

async function main() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backups', `rag-${stamp}`));
  fs.mkdirSync(path.join(out, 'tables'), { recursive: true });
  const manifest = { createdAt: new Date().toISOString(), migrations: AI_MIGRATIONS, tables: {}, files: 0 };
  for (const table of aiTables()) {
    const file = fs.createWriteStream(path.join(out, 'tables', `${table}.jsonl`));
    let rows = 0;
    let lastId = null;
    const { rows: cols } = await db.query(`SHOW COLUMNS FROM ${table}`).catch(() => ({ rows: [] }));
    if (!cols.length) { manifest.tables[table] = { rows: 0, missing: true }; file.end(); continue; }
    const key = cols.find((c) => c.Key === 'PRI')?.Field;
    // Page by primary key when there is a single one; otherwise one query.
    for (;;) {
      const sql = key
        ? `SELECT * FROM ${table} ${lastId !== null ? `WHERE \`${key}\` > $1` : ''} ORDER BY \`${key}\` LIMIT ${PAGE}`
        : `SELECT * FROM ${table}`;
      // eslint-disable-next-line no-await-in-loop
      const { rows: page } = await db.query(sql, lastId !== null ? [lastId] : []);
      for (const r of page) file.write(`${JSON.stringify(encode(r))}\n`);
      rows += page.length;
      if (!key || page.length < PAGE) break;
      lastId = page[page.length - 1][key];
    }
    await new Promise((r) => file.end(r));
    manifest.tables[table] = { rows, key: key || null };
    console.log(`${table}: ${rows}`);
  }
  manifest.files = copyDir(config.storageDir, path.join(out, 'storage-rag'));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nBackup written to ${out} (${Object.keys(manifest.tables).length} tables, ${manifest.files} stored files)`);
}

main()
  .catch((err) => { console.error('Backup failed:', err.message); process.exitCode = 1; })
  .finally(() => require('../src/config/db').pool.end().catch(() => {}));
