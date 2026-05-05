import { Pinecone, type Index } from '@pinecone-database/pinecone';
import type { IndexInfo, NamespaceInfo } from '@migrator/shared';
import { RateLimiter, withRetry } from './rate-limit.js';
import type {
  DeleteResult,
  FetchResult,
  ListResult,
  MigratorRecord,
  UpsertResult,
} from './types.js';

/**
 * Pinecone's fetch endpoint uses `GET /vectors/fetch?ids=…&ids=…` — every ID is a separate
 * query parameter, so request URLs grow linearly with the batch size. Pinecone's gateway
 * (and most HTTP infrastructure) rejects URLs longer than ~8 KB with a generic
 * `PineconeUnmappedHttpError`, which the SDK does *not* mark retryable. With ~25-char IDs
 * we'd cross that threshold around ~300 IDs/request, so we cap chunks at 200 and parallelize
 * them inside one `fetch()` call to keep throughput up.
 *
 * Documented logical maximum is 1000 records/fetch, but it's only reachable via POST which
 * the SDK doesn't use today. Don't raise this without verifying the URL stays under 8 KB.
 */
const FETCH_MAX_IDS = 200;
/** Concurrent HTTP chunks issued by a single `fetch()` call. Bounded so we don't trample the rate limiter. */
const FETCH_CHUNK_CONCURRENCY = 4;
const UPSERT_MAX_RECORDS = 1000;
const UPSERT_MAX_BYTES = 2 * 1024 * 1024;

export interface ClientOptions {
  /** Per-namespace QPS for upsert / delete / update / query (default 100). */
  perNamespaceQPS?: number;
  /** Per-index QPS for fetch / list / describe_index_stats (default 100/200). */
  perIndexFetchQPS?: number;
  perIndexListQPS?: number;
  /** Capacity for per-namespace upsert bytes/sec (default 50 MB). */
  perNamespaceBytesPerSec?: number;
}

/**
 * Wrapper around `@pinecone-database/pinecone` that:
 *   1. Auto-paginates listNamespaces and listPaginated.
 *   2. Auto-batches fetch (1000 cap) and upsert (1000 / 2 MB caps).
 *   3. Throttles per-namespace and per-index using token buckets so we never blow past
 *      Pinecone's documented rate limits and trigger a 429 storm.
 *   4. Retries with full-jitter exponential backoff on retryable errors.
 *
 * Construct a single instance per (apiKey, indexName) tuple.
 */
export class MigratorPineconeClient {
  private readonly pc: Pinecone;
  private readonly limiter: RateLimiter;
  private readonly opts: Required<ClientOptions>;
  private indexCache = new Map<string, Index>();

  constructor(apiKey: string, opts: ClientOptions = {}) {
    this.pc = new Pinecone({ apiKey });
    this.opts = {
      perNamespaceQPS: Math.max(1, opts.perNamespaceQPS ?? 100),
      perIndexFetchQPS: Math.max(1, opts.perIndexFetchQPS ?? 100),
      perIndexListQPS: Math.max(1, opts.perIndexListQPS ?? 200),
      perNamespaceBytesPerSec: Math.max(1, opts.perNamespaceBytesPerSec ?? 50 * 1024 * 1024),
    };
    this.limiter = new RateLimiter({ capacity: 50, refillPerSecond: 50 });
  }

  // ---------------- Control plane ----------------

  async listIndexes(): Promise<IndexInfo[]> {
    return withRetry(async () => {
      const res = await this.pc.listIndexes();
      const indexes = res.indexes ?? [];
      return indexes.map((idx): IndexInfo => mapIndexModel(idx));
    });
  }

  async describeIndex(name: string): Promise<IndexInfo> {
    return withRetry(async () => {
      const idx = await this.pc.describeIndex(name);
      return mapIndexModel(idx);
    });
  }

  // ---------------- Namespace enumeration ----------------

  /**
   * Yield namespace objects in batches as the SDK paginates them. Falls back to
   * `describeIndexStats` for SDK versions that don't expose listNamespaces.
   */
  async *listNamespaces(indexName: string): AsyncIterable<NamespaceInfo> {
    const index = this.indexFor(indexName);
    const indexLimiterKey = `idx:${indexName}:list`;
    this.limiter.configure(indexLimiterKey, this.opts.perIndexListQPS, this.opts.perIndexListQPS);

    // Prefer SDK's listNamespacesPaginated if available, otherwise fall back to describeIndexStats.
    const sdkAny = index as unknown as {
      listNamespaces?: () => Promise<{ namespaces?: Array<{ name: string; recordCount?: number }> }>;
      listNamespacesPaginated?: (args: {
        limit?: number;
        paginationToken?: string;
      }) => Promise<{
        namespaces?: Array<{ name: string; recordCount?: number }>;
        pagination?: { next?: string };
      }>;
    };

    if (typeof sdkAny.listNamespacesPaginated === 'function') {
      let token: string | undefined;
      do {
        await this.limiter.acquire(indexLimiterKey);
        const page = await withRetry(() =>
          sdkAny.listNamespacesPaginated!({ limit: 100, paginationToken: token }),
        );
        for (const ns of page.namespaces ?? []) {
          yield { name: ns.name, recordCount: ns.recordCount ?? 0 };
        }
        token = page.pagination?.next;
      } while (token);
      return;
    }

    // Fallback path: describe_index_stats returns all namespaces in one shot.
    await this.limiter.acquire(indexLimiterKey);
    const stats = await withRetry(() => index.describeIndexStats());
    const map = (stats.namespaces ?? {}) as Record<string, { recordCount?: number; vectorCount?: number }>;
    for (const [name, v] of Object.entries(map)) {
      yield { name, recordCount: v.recordCount ?? v.vectorCount ?? 0 };
    }
  }

  /** Convenience: collect all namespaces into an array. */
  async getAllNamespaces(indexName: string): Promise<NamespaceInfo[]> {
    const out: NamespaceInfo[] = [];
    for await (const ns of this.listNamespaces(indexName)) out.push(ns);
    return out;
  }

  async describeIndexStats(indexName: string): Promise<{
    dimension: number | null;
    totalRecordCount: number;
    namespaces: Record<string, number>;
  }> {
    const idx = this.indexFor(indexName);
    await this.limiter.acquire(`idx:${indexName}:stats`);
    const stats = await withRetry(() => idx.describeIndexStats());
    const namespaces: Record<string, number> = {};
    for (const [name, v] of Object.entries((stats.namespaces ?? {}) as Record<string, { recordCount?: number; vectorCount?: number }>)) {
      namespaces[name] = v.recordCount ?? v.vectorCount ?? 0;
    }
    // SDK versions differ: older responses used totalVectorCount; newer use totalRecordCount only.
    const statsAny = stats as {
      dimension?: number | null;
      totalRecordCount?: number;
      totalVectorCount?: number;
    };
    const total =
      typeof statsAny.totalRecordCount === 'number'
        ? statsAny.totalRecordCount
        : typeof statsAny.totalVectorCount === 'number'
          ? statsAny.totalVectorCount
          : 0;
    return {
      dimension: stats.dimension ?? null,
      totalRecordCount: total,
      namespaces,
    };
  }

  // ---------------- Data plane ----------------

  /**
   * Stream IDs from a single namespace. Internally pages 100 IDs at a time and emits a
   * checkpoint token after each page so callers can persist progress.
   */
  async *listIds(
    indexName: string,
    namespace: string,
    opts: { prefix?: string; pageSize?: number; resumeToken?: string | null } = {},
  ): AsyncIterable<{ ids: string[]; nextToken: string | null; readUnits?: number }> {
    const idx = this.indexFor(indexName).namespace(namespace);
    const indexLimiterKey = `idx:${indexName}:list`;
    this.limiter.configure(indexLimiterKey, this.opts.perIndexListQPS, this.opts.perIndexListQPS);
    const limit = Math.min(100, Math.max(1, opts.pageSize ?? 100));

    let token: string | undefined = opts.resumeToken ?? undefined;
    const MAX_LIST_PAGES = 500_000;
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum += 1) {
      const requestToken = token;
      await this.limiter.acquire(indexLimiterKey);
      const page = await withRetry(() =>
        (idx as unknown as {
          listPaginated: (args: {
            prefix?: string;
            limit?: number;
            paginationToken?: string;
          }) => Promise<{
            vectors?: Array<{ id: string }>;
            pagination?: { next?: string };
            usage?: { readUnits?: number };
          }>;
        }).listPaginated({
          prefix: opts.prefix,
          limit,
          paginationToken: token,
        }),
      );

      const ids = (page.vectors ?? []).map((v) => v.id);
      const next = page.pagination?.next ?? null;
      yield { ids, nextToken: next, readUnits: page.usage?.readUnits };
      if (!next) return;
      // Some edge responses can return an empty page with a pagination token identical to
      // the one we just sent, which would spin forever without this guard.
      if (ids.length === 0 && next === (requestToken ?? null)) {
        throw new Error(
          'listIds: empty page with a non-advancing pagination token; refusing infinite loop',
        );
      }
      token = next;
    }
    throw new Error(`listIds: exceeded ${MAX_LIST_PAGES} pages`);
  }

  /**
   * Fetch records by ID. Caller may pass any number of IDs; we batch them into requests
   * of `FETCH_MAX_IDS` and respect the per-index fetch QPS.
   */
  async fetch(indexName: string, namespace: string, ids: string[]): Promise<FetchResult> {
    if (ids.length === 0) return { records: [], usage: {} };
    const idx = this.indexFor(indexName).namespace(namespace);
    const fetchKey = `idx:${indexName}:fetch`;
    this.limiter.configure(fetchKey, this.opts.perIndexFetchQPS, this.opts.perIndexFetchQPS);

    // Slice into URL-safe chunks (see FETCH_MAX_IDS comment for why we keep this small).
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += FETCH_MAX_IDS) {
      chunks.push(ids.slice(i, i + FETCH_MAX_IDS));
    }

    const records: MigratorRecord[] = [];
    let totalReadUnits = 0;

    // Parallelize chunks within one logical fetch so we don't pay N× the latency for what
    // the caller asked for in a single batch. The shared token bucket still gates real QPS.
    const runChunk = async (chunk: string[]): Promise<void> => {
      await this.limiter.acquire(fetchKey);
      const res = (await withRetry(() => idx.fetch(chunk))) as {
        records?: Record<string, RawRecord>;
        vectors?: Record<string, RawRecord>;
        usage?: { readUnits?: number };
      };
      // Pinecone Node SDK has used both `records` (v4+) and `vectors` (older) field names.
      const recordsMap: Record<string, RawRecord> = res.records ?? res.vectors ?? {};
      for (const [id, r] of Object.entries(recordsMap)) {
        records.push({
          id: r.id ?? id,
          values: r.values,
          sparseValues: r.sparseValues,
          metadata: r.metadata,
        });
      }
      totalReadUnits += res.usage?.readUnits ?? 0;
    };

    for (let i = 0; i < chunks.length; i += FETCH_CHUNK_CONCURRENCY) {
      const wave = chunks.slice(i, i + FETCH_CHUNK_CONCURRENCY);
      await Promise.all(wave.map(runChunk));
    }
    return { records, usage: { readUnits: totalReadUnits || undefined } };
  }

  /**
   * Upsert records into the target namespace. Auto-batches by both record count
   * (1000 max) and request size (2 MB max), and respects per-namespace QPS and bandwidth.
   */
  async upsert(
    indexName: string,
    namespace: string,
    records: MigratorRecord[],
    opts: { batchRecords?: number } = {},
  ): Promise<UpsertResult> {
    if (records.length === 0)
      return { upsertedCount: 0, requestBytes: 0, usage: {} };
    const idx = this.indexFor(indexName).namespace(namespace);
    const qpsKey = `ns:${indexName}:${namespace}:upsert:qps`;
    const bytesKey = `ns:${indexName}:${namespace}:upsert:bytes`;
    this.limiter.configure(qpsKey, this.opts.perNamespaceQPS, this.opts.perNamespaceQPS);
    this.limiter.configure(bytesKey, this.opts.perNamespaceBytesPerSec, this.opts.perNamespaceBytesPerSec);

    const desiredBatch = Math.min(opts.batchRecords ?? 500, UPSERT_MAX_RECORDS);

    let upsertedCount = 0;
    let totalBytes = 0;

    let buffer: MigratorRecord[] = [];
    let bufferBytes = 0;
    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      await this.limiter.acquire(qpsKey);
      // Charge bandwidth against the bytes bucket (acquire `bufferBytes` tokens).
      await this.limiter.acquire(bytesKey, Math.max(1, Math.min(bufferBytes, this.opts.perNamespaceBytesPerSec)));
      const batch = buffer;
      const bytes = bufferBytes;
      buffer = [];
      bufferBytes = 0;
      // Pinecone's typed upsert expects dense `values` on every record; sparse-only / hybrid rows
      // are still valid at runtime — narrow at the call boundary.
      await withRetry(() => idx.upsert(batch as never));
      upsertedCount += batch.length;
      totalBytes += bytes;
    };

    for (const r of records) {
      const sz = approximateRecordBytes(r);
      // If adding this record would blow past our caps, flush first.
      if (
        buffer.length + 1 > desiredBatch ||
        bufferBytes + sz > UPSERT_MAX_BYTES
      ) {
        await flush();
      }
      buffer.push(r);
      bufferBytes += sz;
    }
    await flush();

    return { upsertedCount, requestBytes: totalBytes, usage: {} };
  }

  async deleteMany(
    indexName: string,
    namespace: string,
    ids: string[],
  ): Promise<DeleteResult> {
    if (ids.length === 0) return { deletedCount: 0, usage: {} };
    const idx = this.indexFor(indexName).namespace(namespace);
    const qpsKey = `ns:${indexName}:${namespace}:delete:qps`;
    this.limiter.configure(qpsKey, this.opts.perNamespaceQPS, this.opts.perNamespaceQPS);

    let deleted = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      await this.limiter.acquire(qpsKey);
      await withRetry(() => idx.deleteMany(chunk));
      deleted += chunk.length;
    }
    return { deletedCount: deleted, usage: {} };
  }

  // ---------------- Helpers ----------------

  private indexFor(name: string): Index {
    let idx = this.indexCache.get(name);
    if (!idx) {
      idx = this.pc.index(name);
      this.indexCache.set(name, idx);
    }
    return idx;
  }
}

interface RawRecord {
  id?: string;
  values?: number[];
  sparseValues?: { indices: number[]; values: number[] };
  metadata?: Record<string, unknown>;
}

function mapIndexModel(idx: unknown): IndexInfo {
  const i = idx as {
    name: string;
    dimension?: number;
    metric?: string;
    host: string;
    spec?: { serverless?: { cloud?: string; region?: string }; pod?: unknown };
    status?: { state?: string; ready?: boolean };
    vectorType?: string;
    embed?: { model?: string };
  };
  const isServerless = !!i.spec?.serverless;
  return {
    name: i.name,
    dimension: i.dimension ?? null,
    metric: i.metric ?? null,
    host: i.host,
    cloud: i.spec?.serverless?.cloud ?? null,
    region: i.spec?.serverless?.region ?? null,
    spec: isServerless ? 'serverless' : i.spec?.pod ? 'pod' : 'unknown',
    status: i.status?.state ?? (i.status?.ready ? 'Ready' : null),
    vectorType: (i.vectorType === 'sparse' ? 'sparse' : 'dense') as 'dense' | 'sparse',
    embeddingModel: i.embed?.model ?? null,
  };
}

/**
 * Approximate JSON byte size of a record. Used for upsert request-size budgeting.
 * Cheaper than JSON.stringify for hot-loop batching and over-counts slightly so we never
 * exceed Pinecone's 2 MB request limit.
 */
export function approximateRecordBytes(r: MigratorRecord): number {
  let bytes = 32 + r.id.length;
  if (r.values) bytes += r.values.length * 8 + 16;
  if (r.sparseValues) {
    bytes += r.sparseValues.indices.length * 8 + r.sparseValues.values.length * 8 + 32;
  }
  if (r.metadata) {
    for (const [k, v] of Object.entries(r.metadata)) {
      bytes += k.length + 4;
      bytes += approximateValueBytes(v);
    }
  }
  return bytes;
}

function approximateValueBytes(v: unknown): number {
  if (v == null) return 4;
  if (typeof v === 'string') return v.length + 2;
  if (typeof v === 'number' || typeof v === 'boolean') return 8;
  if (Array.isArray(v)) {
    let n = 4;
    for (const item of v) n += approximateValueBytes(item);
    return n;
  }
  if (typeof v === 'object') {
    let n = 4;
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      n += k.length + 4;
      n += approximateValueBytes(vv);
    }
    return n;
  }
  return 16;
}
