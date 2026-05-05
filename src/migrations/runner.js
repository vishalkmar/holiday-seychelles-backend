require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

async function run() {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    // Ensure migrations_log exists first (it's also a migration, but we need it before we track others).
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations_log (
        filename VARCHAR(200) PRIMARY KEY,
        ran_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM migrations_log WHERE filename = $1',
        [file]
      );
      if (rows.length) {
        console.log(`- skip ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`> applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT IGNORE INTO migrations_log (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('All migrations applied.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
