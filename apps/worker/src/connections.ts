import { MigratorPineconeClient } from '@migrator/pinecone-client';
import { pool } from './db.js';
import { decryptApiKey } from './crypto.js';

const cache = new Map<string, MigratorPineconeClient>();

export async function clientFor(connectionId: string): Promise<MigratorPineconeClient> {
  const cached = cache.get(connectionId);
  if (cached) return cached;
  const r = await pool.query<{ api_key_ciphertext: string }>(
    'SELECT api_key_ciphertext FROM connections WHERE id = $1',
    [connectionId],
  );
  if (!r.rows[0]) throw new Error(`unknown connection ${connectionId}`);
  const apiKey = decryptApiKey(r.rows[0].api_key_ciphertext);
  const client = new MigratorPineconeClient(apiKey);
  cache.set(connectionId, client);
  return client;
}

export function clearCache(): void {
  cache.clear();
}
