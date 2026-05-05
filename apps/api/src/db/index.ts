import pg from 'pg';
import { env } from '../config.js';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

export type DbClient = pg.PoolClient;

export async function withTx<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
