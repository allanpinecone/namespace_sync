import { MigratorPineconeClient } from '@migrator/pinecone-client';
import type { ConnectionInput, IndexInfo } from '@migrator/shared';
import { pool } from '../db/index.js';
import { decryptApiKey, encryptApiKey, fingerprintApiKey } from '../security/crypto.js';
import { logger } from '../logger.js';

export interface StoredConnection {
  id: string;
  label: string;
  fingerprint: string;
  ephemeral: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

const clientCache = new Map<string, MigratorPineconeClient>();

/** Validate the API key by hitting Pinecone and persist the (encrypted) credentials. */
export async function createConnection(input: ConnectionInput): Promise<{
  connection: StoredConnection;
  indexes: IndexInfo[];
}> {
  // Probe Pinecone first so we never persist an invalid key.
  const probe = new MigratorPineconeClient(input.apiKey);
  const indexes = await probe.listIndexes();

  const fingerprint = fingerprintApiKey(input.apiKey);
  const ciphertext = encryptApiKey(input.apiKey);

  const result = await pool.query<{
    id: string;
    label: string;
    api_key_fingerprint: string;
    ephemeral: boolean;
    created_at: string;
    last_used_at: string | null;
  }>(
    `INSERT INTO connections (label, api_key_ciphertext, api_key_fingerprint, ephemeral, last_used_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING id, label, api_key_fingerprint, ephemeral, created_at, last_used_at`,
    [input.label, ciphertext, fingerprint, input.ephemeral],
  );
  const row = result.rows[0]!;
  const conn: StoredConnection = {
    id: row.id,
    label: row.label,
    fingerprint: row.api_key_fingerprint,
    ephemeral: row.ephemeral,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
  clientCache.set(conn.id, probe);
  logger.info({ connId: conn.id, indexCount: indexes.length }, 'connection created');
  return { connection: conn, indexes };
}

/** Look up a Pinecone client for a stored connection. Decrypts only in memory. */
export async function getClient(connectionId: string): Promise<MigratorPineconeClient> {
  const cached = clientCache.get(connectionId);
  if (cached) return cached;
  const res = await pool.query<{ api_key_ciphertext: string }>(
    'SELECT api_key_ciphertext FROM connections WHERE id = $1',
    [connectionId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`unknown connection ${connectionId}`);
  const apiKey = decryptApiKey(row.api_key_ciphertext);
  const client = new MigratorPineconeClient(apiKey);
  clientCache.set(connectionId, client);
  await pool.query('UPDATE connections SET last_used_at = now() WHERE id = $1', [connectionId]);
  return client;
}

export async function listConnections(): Promise<StoredConnection[]> {
  const res = await pool.query<{
    id: string;
    label: string;
    api_key_fingerprint: string;
    ephemeral: boolean;
    created_at: string;
    last_used_at: string | null;
  }>('SELECT id, label, api_key_fingerprint, ephemeral, created_at, last_used_at FROM connections ORDER BY created_at DESC');
  return res.rows.map((r) => ({
    id: r.id,
    label: r.label,
    fingerprint: r.api_key_fingerprint,
    ephemeral: r.ephemeral,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** Thrown when jobs in non-terminal states still reference this connection. */
export class ConnectionDeleteBlockedError extends Error {
  override readonly name = 'ConnectionDeleteBlockedError';
  constructor() {
    super('Connection is still referenced by active or paused jobs');
  }
}

const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * Deletes a connection after removing **terminal** jobs (completed / failed / cancelled) that
 * still reference it, so finished migrations do not block key removal. Non-terminal jobs
 * (pending, preflight, running, paused) keep the connection until those jobs are done or cancelled.
 */
export async function deleteConnection(id: string): Promise<void> {
  const result = await removeConnection(id, { ephemeralOnly: false });
  if (result === 'blocked') throw new ConnectionDeleteBlockedError();
  if (result === 'not_found') throw new Error(`unknown connection ${id}`);
  clientCache.delete(id);
}

async function removeConnection(
  id: string,
  opts: { ephemeralOnly: boolean },
): Promise<'deleted' | 'not_found' | 'blocked'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (opts.ephemeralOnly) {
      const exists = await client.query<{ ok: number }>(
        'SELECT 1 AS ok FROM connections WHERE id = $1 AND ephemeral = TRUE',
        [id],
      );
      if ((exists.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return 'not_found';
      }
    } else {
      const exists = await client.query('SELECT 1 FROM connections WHERE id = $1', [id]);
      if ((exists.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return 'not_found';
      }
    }

    const blocking = await client.query(
      `SELECT 1 FROM jobs
       WHERE (source_connection_id = $1 OR target_connection_id = $1)
         AND NOT (status = ANY($2::text[]))`,
      [id, [...TERMINAL_JOB_STATUSES]],
    );
    if ((blocking.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return 'blocked';
    }

    await client.query(
      `DELETE FROM jobs
       WHERE (source_connection_id = $1 OR target_connection_id = $1)
         AND status = ANY($2::text[])`,
      [id, [...TERMINAL_JOB_STATUSES]],
    );

    const del = opts.ephemeralOnly
      ? await client.query('DELETE FROM connections WHERE id = $1 AND ephemeral = TRUE', [id])
      : await client.query('DELETE FROM connections WHERE id = $1', [id]);

    if ((del.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return 'not_found';
    }

    await client.query('COMMIT');
    return 'deleted';
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface PurgeEphemeralResult {
  removed: number;
  /** Rows that could not be deleted because jobs still reference them (FK). */
  skippedInUse: number;
}

/**
 * Remove ephemeral connections one at a time so a single in-use row does not roll back
 * the whole batch (Postgres would otherwise fail the multi-row DELETE on FK violation).
 */
export async function purgeEphemeralConnections(): Promise<PurgeEphemeralResult> {
  const list = await pool.query<{ id: string }>('SELECT id FROM connections WHERE ephemeral = TRUE');
  let removed = 0;
  let skippedInUse = 0;
  for (const row of list.rows) {
    const result = await removeConnection(row.id, { ephemeralOnly: true });
    if (result === 'deleted') {
      clientCache.delete(row.id);
      removed += 1;
    } else if (result === 'blocked') {
      skippedInUse += 1;
    }
  }
  return { removed, skippedInUse };
}

export function isFkViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23503'
  );
}
