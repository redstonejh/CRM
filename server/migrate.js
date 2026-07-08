const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/crm';

async function migrate() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('CRM database schema is up to date.');
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});

