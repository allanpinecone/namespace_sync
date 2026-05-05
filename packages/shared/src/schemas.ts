import { z } from 'zod';

export const pineconeApiKeySchema = z
  .string()
  .min(20, 'Pinecone API key looks too short')
  .max(200, 'Pinecone API key looks too long');

export const connectionInputSchema = z.object({
  label: z.string().min(1).max(64).default('default'),
  apiKey: pineconeApiKeySchema,
  /** When true, key is wiped from storage when the session ends. */
  ephemeral: z.boolean().default(true),
});
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

export const indexInfoSchema = z.object({
  name: z.string(),
  dimension: z.number().int().nullable(),
  metric: z.string().nullable(),
  host: z.string(),
  cloud: z.string().nullable(),
  region: z.string().nullable(),
  spec: z.enum(['serverless', 'pod', 'unknown']),
  status: z.string().nullable(),
  vectorType: z.enum(['dense', 'sparse', 'unknown']).default('dense'),
  embeddingModel: z.string().nullable().optional(),
});
export type IndexInfo = z.infer<typeof indexInfoSchema>;

export const namespaceInfoSchema = z.object({
  name: z.string(),
  recordCount: z.number().int().nonnegative(),
});
export type NamespaceInfo = z.infer<typeof namespaceInfoSchema>;

export const namespaceMappingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('same') }),
  z.object({ kind: z.literal('prefix'), value: z.string() }),
  z.object({ kind: z.literal('suffix'), value: z.string() }),
  z.object({ kind: z.literal('regex'), pattern: z.string(), replacement: z.string() }),
  z.object({ kind: z.literal('single'), target: z.string() }),
]);
export type NamespaceMapping = z.infer<typeof namespaceMappingSchema>;

export const concurrencyConfigSchema = z.object({
  maxNamespacesInFlight: z.number().int().min(1).max(64).default(8),
  /**
   * Concurrent in-flight fetch+upsert batches per namespace. Used by the copy worker pipeline.
   * 8 is conservative — Pinecone's per-index limits are around 100 RPS for fetch and 100 RPS
   * for upsert, and each batch issues 1–3 of those, so 8 leaves comfortable headroom against
   * 429 storms. The worker also enforces an env-level cap (`WORKER_MAX_INFLIGHT_PER_NS`).
   */
  maxRequestsPerNamespace: z.number().int().min(1).max(200).default(8),
  /** Records per upsert request. Pinecone caps at 1000; we default to the cap to minimize round-trips. */
  upsertBatchSize: z.number().int().min(1).max(1000).default(1000),
  /** IDs per fetch request. Pinecone caps at 1000. */
  fetchBatchSize: z.number().int().min(1).max(1000).default(1000),
  listPageSize: z.number().int().min(1).max(100).default(100),
});
export type ConcurrencyConfig = z.infer<typeof concurrencyConfigSchema>;

export const tombstoneGuardSchema = z.object({
  /** If proportion of source IDs disappearing in one pass exceeds this, pause and require confirmation. */
  maxDeletePctPerPass: z.number().min(0).max(1).default(0.1),
});
export type TombstoneGuard = z.infer<typeof tombstoneGuardSchema>;

export const versionFieldConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Metadata field whose monotonic increase implies the record changed (e.g. "_v" or "updated_at"). */
  field: z.string().default('_v'),
  /** Sample size per pass (capped at 10k matching Pinecone's fetch_by_metadata page size). */
  samplePerPass: z.number().int().min(1).max(10000).default(2000),
});
export type VersionFieldConfig = z.infer<typeof versionFieldConfigSchema>;

/**
 * Per-batch "skip already-present" mode for copy jobs (and the bootstrap phase of sync jobs).
 *
 *   - `never`: classic behavior — list, fetch source, upsert. May overwrite identical rows.
 *   - `id`:    fetch the target by ID first; skip any ID that already exists. Cheapest skip
 *             (one extra fetch on target, but you avoid the source fetch + upsert WU for
 *             every pre-existing record). Best for resumes after a crash/cancel.
 *   - `hash`:  fetch from both sides and only upsert when values/metadata differ. Safest;
 *             also lets you re-run a job to repair drift without paying WU on identical rows.
 */
export const copyOptionsSchema = z.object({
  skipExisting: z.enum(['never', 'id', 'hash']).default('never'),
});
export type CopyOptions = z.infer<typeof copyOptionsSchema>;

export const createCopyJobSchema = z.object({
  name: z.string().min(1).max(120),
  sourceConnectionId: z.string().uuid(),
  sourceIndex: z.string(),
  targetConnectionId: z.string().uuid(),
  targetIndex: z.string(),
  namespaces: z.array(z.string()).min(1),
  mapping: namespaceMappingSchema.default({ kind: 'same' }),
  concurrency: concurrencyConfigSchema.default({}),
  copyOptions: copyOptionsSchema.default({}),
  metadataFilter: z.record(z.unknown()).optional(),
  dryRun: z.boolean().default(false),
});
export type CreateCopyJobInput = z.infer<typeof createCopyJobSchema>;

export const createSyncJobSchema = createCopyJobSchema.extend({
  pollIntervalMs: z.number().int().min(5_000).max(3_600_000).default(30_000),
  tombstoneGuard: tombstoneGuardSchema.default({}),
  versionField: versionFieldConfigSchema.default({}),
});
export type CreateSyncJobInput = z.infer<typeof createSyncJobSchema>;

export const jobStatusSchema = z.enum([
  'pending',
  'preflight',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobKindSchema = z.enum(['copy', 'sync']);
export type JobKind = z.infer<typeof jobKindSchema>;
