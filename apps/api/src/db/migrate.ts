import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from './index.js';
import { logger } from '../logger.js';

async function main(): Promise<void> {
  const schemaPath = await findSchemaPath();
  const sql = await readFile(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(sql);
    logger.info({ schemaPath }, 'Database schema applied');
  } finally {
    client.release();
    await pool.end();
  }
}

async function findSchemaPath(): Promise<string> {
  const here = import.meta.dirname ?? '.';
  const candidates = [
    // tsx/dev path
    resolve(here, 'schema.sql'),
    // compiled dist path -> source fallback inside image/workspace
    resolve(here, '../../src/db/schema.sql'),
    // runtime cwd fallbacks
    resolve(process.cwd(), 'apps/api/src/db/schema.sql'),
    resolve(process.cwd(), 'apps/api/dist/db/schema.sql'),
  ];
  for (const path of candidates) {
    try {
      await readFile(path, 'utf8');
      return path;
    } catch {
      // continue
    }
  }
  throw new Error(`Unable to locate schema.sql. Tried: ${candidates.join(', ')}`);
}

main().catch((err) => {
  logger.error(err, 'Migration failed');
  process.exit(1);
});
