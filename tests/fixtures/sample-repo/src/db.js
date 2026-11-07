import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function runQuery(sql) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql);
    return result.rows;
  } finally {
    client.release();
  }
}

export async function findUser(email) {
  const rows = await runQuery(`SELECT * FROM users WHERE email = '${email}'`);
  return rows[0];
}
