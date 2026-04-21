require('dotenv').config();

const { pool } = require('../config/db');
const { hashPassword } = require('./password');

const parseArgs = () => {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    email: getArg('--email') || 'admin@holidayseychelles.com',
    password: getArg('--password') || 'ChangeMe@123',
    name: getArg('--name') || 'Super Admin',
    role: getArg('--role') || 'admin',
  };
};

async function seedAdmin() {
  const client = await pool.connect();

  try {
    const { email, password, name, role } = parseArgs();

    if (!email || !password || !name) {
      throw new Error('Email, password, and name are required.');
    }

    const passwordHash = await hashPassword(password);

    const result = await client.query(
      `INSERT INTO admins (email, password_hash, name, role, status, updated_at)
       VALUES ($1, $2, $3, $4, 'active', NOW())
       ON CONFLICT (email)
       DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         status = 'active',
         updated_at = NOW()
       RETURNING id, email, name, role, status`,
      [email, passwordHash, name, role]
    );

    console.log('Admin upserted successfully:', result.rows[0]);
  } catch (err) {
    console.error('Failed to upsert admin:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seedAdmin().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
