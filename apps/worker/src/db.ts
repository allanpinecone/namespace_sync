import pg from 'pg';
import { env } from './config.js';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

export type DbClient = pg.PoolClient;
