const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('WARNING: DATABASE_URL is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
});

pool.on('error', (err) => {
  console.error('Database pool error:', err.message);
});

module.exports = pool;
