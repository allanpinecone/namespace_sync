import type { NamespaceInfo } from '@migrator/shared';
import { pool } from '../db/index.js';
import { getClient } from './connections.js';

const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Fetch all namespaces for a given (connection, index). Uses a short-lived Postgres cache so
 * repeated UI loads don't re-pay the read cost each time.
 *
 * @returns the namespaces and whether they came from the live API or the cache.
 */
export async function getNamespaces(
  connectionId: string,
  indexName: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ namespaces: NamespaceInfo[]; fromCache: boolean; refreshedAt: string }> {
  if (!opts.forceRefresh) {
    const cached = await pool.query<{ namespaces: NamespaceInfo[]; refreshed_at: string }>(
      'SELECT namespaces, refreshed_at FROM namespace_cache WHERE connection_id = $1 AND index_name = $2',
      [connectionId, indexName],
    );
    const row = cached.rows[0];
    if (row && Date.now() - new Date(row.refreshed_at).getTime() < STALE_AFTER_MS) {
      return { namespaces: row.namespaces, fromCache: true, refreshedAt: row.refreshed_at };
    }
  }

  const client = await getClient(connectionId);
  const namespaces = await client.getAllNamespaces(indexName);
  const refreshedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO namespace_cache (connection_id, index_name, namespaces, refreshed_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (connection_id, index_name)
     DO UPDATE SET namespaces = EXCLUDED.namespaces, refreshed_at = EXCLUDED.refreshed_at`,
    [connectionId, indexName, JSON.stringify(namespaces), refreshedAt],
  );
  return { namespaces, fromCache: false, refreshedAt };
}

/**
 * Stream namespaces incrementally. Invokes `onBatch` as each batch arrives so the API layer
 * can flush SSE chunks while the upstream is still paginating.
 */
export async function streamNamespaces(
  connectionId: string,
  indexName: string,
  onBatch: (batch: NamespaceInfo[]) => void | Promise<void>,
): Promise<NamespaceInfo[]> {
  const client = await getClient(connectionId);
  const collected: NamespaceInfo[] = [];
  let buffer: NamespaceInfo[] = [];
  for await (const ns of client.listNamespaces(indexName)) {
    collected.push(ns);
    buffer.push(ns);
    if (buffer.length >= 200) {
      await onBatch(buffer);
      buffer = [];
    }
  }
  if (buffer.length > 0) await onBatch(buffer);

  await pool.query(
    `INSERT INTO namespace_cache (connection_id, index_name, namespaces, refreshed_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (connection_id, index_name)
     DO UPDATE SET namespaces = EXCLUDED.namespaces, refreshed_at = now()`,
    [connectionId, indexName, JSON.stringify(collected)],
  );
  return collected;
}
