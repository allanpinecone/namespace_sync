/**
 * Minimal record shape we pass around the migration pipeline. Mirrors Pinecone's
 * vector record but is decoupled from the SDK's exact type so we can serialize cleanly.
 */
export interface MigratorRecord {
  id: string;
  values?: number[];
  sparseValues?: { indices: number[]; values: number[] };
  metadata?: Record<string, unknown>;
}

export interface UsageHint {
  /** Read units consumed by the API call, when reported by Pinecone. */
  readUnits?: number;
  /** Write units consumed (rare; Pinecone usually exposes RU only). */
  writeUnits?: number;
}

export interface ListResult {
  ids: string[];
  paginationToken: string | null;
  usage: UsageHint;
}

export interface FetchResult {
  records: MigratorRecord[];
  usage: UsageHint;
}

export interface UpsertResult {
  upsertedCount: number;
  /** Estimated bytes the request body consumed. */
  requestBytes: number;
  usage: UsageHint;
}

export interface DeleteResult {
  deletedCount: number;
  usage: UsageHint;
}
