/**
 * Verify, or restore, an AI assistant backup made by scripts/backup-rag.js.
 *
 *   node scripts/restore-rag.js <backupDir>            verify only (default): every
 *       file parses, row counts match the manifest, embeddings decode to vectors
 *   node scripts/restore-rag.js <backupDir> --apply    restore into EMPTY tables only
 *       (a table that already has rows is skipped and reported), then copy the
 *       stored documents back to RAG_STORAGE_DIR without overwriting anything.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const decode = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v && typeof v === 'object' && '$b64' in v ? Buffer.from(v.$b64, 'base64') : v && typeof v === 'object' && '$date' in v ? new Date(v.$date) : v && typeof v === 'object' ? JSON.stringify(v) : v]));

async function* rowsOf(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield decode(JSON.parse(line));
}

async function verify(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const problems = [];
  let vectors = 0;
  for (const [table, info] of Object.entries(manifest.tables)) {
    if (info.missing) continue;
    let n = 0;
    for await (const r of rowsOf(path.join(dir, 'tables', `${table}.jsonl`))) {
      n += 1;
      if (table === 'rag_chunks' && r.embedding) {
        if (r.embedding.length % 4 !== 0) problems.push(`rag_chunks ${r.id}: embedding is not whole floats`);
        else vectors += 1;
      }
    }
    if (n !== info.rows) problems.push(`${table}: ${n} rows in the file, ${info.rows} in the manifest`);
  }
  const countFiles = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? countFiles(path.join(d, e.name)) : 1), 0) : 0);
  const files = countFiles(path.join(dir, 'storage-rag'));
  if (files !== manifest.files) problems.push(`stored files: ${files}, manifest says ${manifest.files}`);
  return { manifest, problems, vectors, files };
}

async function apply(dir, manifest) {
  const { db } = require('../src/ai/ports');
  const { ensureAiTables } = require('../src/ai/db');
  const config = require('../src/ai/config');
  await ensureAiTables();
  for (const [table, info] of Object.entries(manifest.tables)) {
    if (info.missing || !info.rows) continue;
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
    if (Number(rows[0].n) > 0) { console.log(`${table}: skipped (already has ${rows[0].n} rows)`); continue; }
    let n = 0;
    for await (const r of rowsOf(path.join(dir, 'tables', `${table}.jsonl`))) {
      const cols = Object.keys(r);
      // eslint-disable-next-line no-await-in-loop
      await db.query(`INSERT INTO ${table} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => r[c]));
      n += 1;
    }
    console.log(`${table}: restored ${n}`);
  }
  const copy = (from, to) => {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) copy(a, b);
      else if (!fs.existsSync(b)) fs.copyFileSync(a, b);
    }
  };
  copy(path.join(dir, 'storage-rag'), config.storageDir);
  await require('../src/config/db').pool.end().catch(() => {});
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: node scripts/restore-rag.js <backupDir> [--apply]');
  const v = await verify(path.resolve(dir));
  const tables = Object.keys(v.manifest.tables).length;
  console.log(`Backup from ${v.manifest.createdAt}: ${tables} tables, ${v.vectors} embeddings, ${v.files} stored files.`);
  if (v.problems.length) {
    console.log(`NOT OK:\n- ${v.problems.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('Verified: every file reads back and matches the manifest.');
  if (process.argv.includes('--apply')) await apply(path.resolve(dir), v.manifest);
}

main().catch((err) => { console.error('Restore failed:', err.message); process.exitCode = 1; });
