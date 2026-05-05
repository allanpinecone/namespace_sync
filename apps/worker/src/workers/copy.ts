import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { COPY_QUEUE, type CopyOptions } from '@migrator/shared';
import { approximateRecordBytes } from '@migrator/pinecone-client';
import { env } from '../config.js';
import { logger } from '../logger.js';
import { pool } from '../db.js';
import { clientFor } from '../connections.js';
import { publishProgress } from '../events.js';
import { pLimit, recordHash } from '../util.js';
import { recordAudit } from '../audit.js';

interface CopyPayload {
  jobId: string;
  isBootstrap?: boolean;
}

interface JobConfigRow {
  id: string;
  source_connection_id: string;
  target_connection_id: string;
  source_index: string;
  target_index: string;
  metadata_filter: Record<string, unknown> | null;
  dry_run: boolean;
  concurrency: {
    maxNamespacesInFlight: number;
    maxRequestsPerNamespace: number;
    upsertBatchSize: number;
    fetchBatchSize: number;
    listPageSize: number;
  };
  copy_options: CopyOptions | null;
}

interface NsProgressRow {
  namespace: string;
  target_namespace: string;
  status: string;
  total_records: string;
  pagination_token: string | null;
}

type SkipMode = NonNullable<CopyOptions['skipExisting']>;

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Copy worker. Each job comprises one or more namespaces; we run up to
 * `maxNamespacesInFlight` of them in parallel. For each namespace we:
 *   1. Resume from persisted pagination_token (or null) and stream IDs via list.
 *   2. Fetch in batches of `fetchBatchSize` (capped at 1000 by Pinecone).
 *   3. Upsert into the mapped target namespace, batched by record count and request size.
 *   4. Persist the next pagination_token + counters atomically before moving on.
 *   5. On done, mark the namespace progress row as completed.
 *
 * The pipeline is fully resumable: kill -9'd workers pick up at their last persisted token.
 */
export function startCopyWorker(): Worker {
  const worker = new Worker(
    COPY_QUEUE,
    async (job: Job<CopyPayload>) => runCopy(job.data.jobId, job.data.isBootstrap === true),
    { connection, concurrency: env.WORKER_COPY_CONCURRENCY },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.data?.jobId, err }, 'copy worker failed'),
  );
  worker.on('completed', (job) =>
    logger.info({ jobId: job.data.jobId }, 'copy job complete'),
  );
  return worker;
}

async function isJobCancelled(jobId: string): Promise<boolean> {
  const r = await pool.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [jobId]);
  return r.rows[0]?.status === 'cancelled';
}

class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} cancelled`);
    this.name = 'JobCancelledError';
  }
}

async function runCopy(jobId: string, isBootstrap: boolean): Promise<void> {
  const jobRow = await pool.query<JobConfigRow>(
    `SELECT id, source_connection_id, target_connection_id, source_index, target_index,
            metadata_filter, dry_run, concurrency, copy_options
     FROM jobs WHERE id = $1`,
    [jobId],
  );
  const job = jobRow.rows[0];
  if (!job) throw new Error(`job ${jobId} not found`);

  if (await isJobCancelled(jobId)) {
    logger.info({ jobId }, 'copy job already cancelled before start; exiting');
    return;
  }

  await pool.query(
    `UPDATE jobs
       SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE id = $1 AND status NOT IN ('cancelled', 'completed', 'failed')`,
    [jobId],
  );
  publishProgress({ jobId, status: 'running', message: isBootstrap ? 'Sync bootstrap copy starting' : 'Copy job running' });

  const nsRows = await pool.query<NsProgressRow>(
    `SELECT namespace, target_namespace, status, total_records, pagination_token
     FROM namespace_progress WHERE job_id = $1
     ORDER BY namespace`,
    [jobId],
  );
  const namespaces = nsRows.rows.filter((r) => r.status !== 'completed');
  const limit = pLimit(job.concurrency.maxNamespacesInFlight ?? 8);

  const [srcClient, tgtClient] = await Promise.all([
    clientFor(job.source_connection_id),
    clientFor(job.target_connection_id),
  ]);
  const indexInfo = await srcClient.describeIndex(job.source_index);
  const dimension = indexInfo.dimension ?? 0;

  // Seed total_records from describe_index_stats so the dashboard shows a meaningful Total
  // *during* the copy, not just at completion. One round-trip; small.
  try {
    const stats = await srcClient.describeIndexStats(job.source_index);
    const seedTargets = namespaces.filter((n) => Number(n.total_records ?? 0) === 0);
    for (const ns of seedTargets) {
      const count = stats.namespaces[ns.namespace] ?? 0;
      if (count > 0) {
        await pool.query(
          `UPDATE namespace_progress
             SET total_records = $3, updated_at = now()
           WHERE job_id = $1 AND namespace = $2 AND total_records = 0`,
          [jobId, ns.namespace, count],
        );
        publishProgress({ jobId, namespace: ns.namespace, totalRecords: count });
      }
    }
  } catch (err) {
    logger.warn({ jobId, err }, 'failed to seed total_records from describe_index_stats');
  }

  let cancelledDuringRun = false;
  await Promise.all(
    namespaces.map((ns) =>
      limit(() =>
        copyNamespace(jobId, job, ns, srcClient, tgtClient, dimension).catch(async (err) => {
          if (err instanceof JobCancelledError) {
            cancelledDuringRun = true;
            await pool.query(
              `UPDATE namespace_progress
               SET status = 'cancelled', updated_at = now()
               WHERE job_id = $1 AND namespace = $2 AND status NOT IN ('completed','failed')`,
              [jobId, ns.namespace],
            );
            publishProgress({ jobId, namespace: ns.namespace, status: 'cancelled' });
            return;
          }
          logger.error({ jobId, namespace: ns.namespace, err }, 'namespace copy failed');
          await pool.query(
            `UPDATE namespace_progress
             SET status = 'failed', error_message = $3, updated_at = now()
             WHERE job_id = $1 AND namespace = $2`,
            [jobId, ns.namespace, err instanceof Error ? err.message : String(err)],
          );
          publishProgress({
            jobId,
            namespace: ns.namespace,
            status: 'failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    ),
  );

  // Roll up final job status. If any namespace failed, mark the whole job failed.
  const summary = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM namespace_progress WHERE job_id = $1 GROUP BY status`,
    [jobId],
  );
  const counts = Object.fromEntries(summary.rows.map((r) => [r.status, Number(r.count)]));
  const anyFailed = (counts.failed ?? 0) > 0;
  const cancelled = cancelledDuringRun || (await isJobCancelled(jobId));
  const status = cancelled
    ? 'cancelled'
    : isBootstrap
      ? 'running'
      : anyFailed
        ? 'failed'
        : 'completed';
  // Never resurrect a cancelled job — the user explicitly stopped it.
  await pool.query(
    `UPDATE jobs SET status = $1, completed_at = $2, updated_at = now()
     WHERE id = $3 AND status <> 'cancelled'`,
    [status, status === 'running' ? null : new Date(), jobId],
  );
  publishProgress({
    jobId,
    status,
    message: cancelled
      ? 'Job cancelled'
      : isBootstrap
        ? 'Bootstrap copy complete'
        : `Job ${status}`,
  });
  await recordAudit({
    jobId,
    eventType: cancelled ? 'job.cancelled' : 'copy.completed',
    message: `status=${status}`,
    details: counts,
  });
}

async function copyNamespace(
  jobId: string,
  job: JobConfigRow,
  ns: NsProgressRow,
  srcClient: Awaited<ReturnType<typeof clientFor>>,
  tgtClient: Awaited<ReturnType<typeof clientFor>>,
  dimension: number,
): Promise<void> {
  await pool.query(
    `UPDATE namespace_progress
     SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE job_id = $1 AND namespace = $2`,
    [jobId, ns.namespace],
  );

  const conc = job.concurrency;
  const pageSize = Math.min(100, Math.max(1, conc.listPageSize ?? 100));
  const fetchBatch = Math.min(1000, Math.max(1, conc.fetchBatchSize ?? 1000));
  const upsertBatch = Math.min(1000, Math.max(1, conc.upsertBatchSize ?? 1000));
  // Hard-clamp by env var so legacy jobs that were saved with a large maxRequestsPerNamespace
  // (the old schema default was 30, which is enough to trigger sustained 429s on Pinecone)
  // can't blow up the worker. Operators can raise the cap via WORKER_MAX_INFLIGHT_PER_NS.
  const requestedInFlight = Math.max(1, Math.floor(Number(conc.maxRequestsPerNamespace)) || 8);
  const maxInFlight = Math.min(requestedInFlight, env.WORKER_MAX_INFLIGHT_PER_NS);
  if (requestedInFlight > maxInFlight) {
    logger.info(
      { jobId, namespace: ns.namespace, requestedInFlight, maxInFlight },
      'clamped per-namespace concurrency to env cap',
    );
  }
  const skipMode: SkipMode = job.copy_options?.skipExisting ?? 'never';

  // Counters mutated by every in-flight batch. JS's single-threaded event loop guarantees
  // each `+=` is atomic, so concurrent batches can update these safely without locking.
  // We only need to be careful when *snapshotting* them for DB writes (see `snap()`).
  let processed = 0;
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let ruConsumed = 0;
  let wuConsumed = 0;
  let buffered: string[] = [];

  // Error reporting: the first failure gets logged in full; subsequent ones are sampled (one
  // per ~5s) so a 429 storm can't drown the rest of the worker logs. The first error message
  // is also persisted on the namespace_progress row so the dashboard surfaces it.
  let firstErrorMessage: string | null = null;
  let lastErrorLogAt = 0;
  let suppressedErrorCount = 0;
  const reportBatchError = (err: unknown): void => {
    const status =
      (err as { status?: number; response?: { status?: number } }).status ??
      (err as { response?: { status?: number } }).response?.status;
    const message = err instanceof Error ? err.message : String(err);
    if (firstErrorMessage === null) firstErrorMessage = `${status ? `HTTP ${status}: ` : ''}${message}`;
    const now = Date.now();
    if (now - lastErrorLogAt < 5000) {
      suppressedErrorCount += 1;
      return;
    }
    lastErrorLogAt = now;
    logger.warn(
      {
        jobId,
        namespace: ns.namespace,
        status,
        suppressedSinceLast: suppressedErrorCount,
        err,
      },
      'batch copy failed; recording and continuing',
    );
    suppressedErrorCount = 0;
  };

  /**
   * Process a single batch of IDs. Runs concurrently with other batches inside the
   * per-namespace `pLimit(maxInFlight)` pool, so this function must:
   *   - never share mutable state with other batches besides the `+=` counters above;
   *   - in `hash` mode, parallelize source and target fetches (independent indexes);
   *   - swallow per-batch errors as `failed += ids.length` so one bad batch can't kill
   *     the whole namespace.
   */
  const processBatch = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    try {
      let toUpsert: Awaited<ReturnType<typeof srcClient.fetch>>['records'] = [];
      let preExistingCount = 0;

      if (skipMode === 'never') {
        const src = await srcClient.fetch(job.source_index, ns.namespace, ids);
        ruConsumed += src.usage.readUnits ?? Math.ceil(ids.length / 10);
        toUpsert = job.metadata_filter
          ? src.records.filter((r) => matchesMetadataFilter(r.metadata, job.metadata_filter!))
          : src.records;
      } else if (skipMode === 'id') {
        const tgt = await tgtClient.fetch(job.target_index, ns.target_namespace, ids);
        ruConsumed += tgt.usage.readUnits ?? Math.ceil(ids.length / 10);
        const present = new Set(tgt.records.map((r) => r.id));
        preExistingCount = present.size;
        const toFetchIds = ids.filter((id) => !present.has(id));
        if (toFetchIds.length > 0) {
          const src = await srcClient.fetch(job.source_index, ns.namespace, toFetchIds);
          ruConsumed += src.usage.readUnits ?? Math.ceil(toFetchIds.length / 10);
          toUpsert = job.metadata_filter
            ? src.records.filter((r) => matchesMetadataFilter(r.metadata, job.metadata_filter!))
            : src.records;
        }
      } else {
        // `hash` mode: source and target fetches are independent → run them in parallel.
        const [src, tgt] = await Promise.all([
          srcClient.fetch(job.source_index, ns.namespace, ids),
          tgtClient.fetch(job.target_index, ns.target_namespace, ids),
        ]);
        ruConsumed +=
          (src.usage.readUnits ?? Math.ceil(ids.length / 10)) +
          (tgt.usage.readUnits ?? Math.ceil(ids.length / 10));
        const targetByIdHash = new Map(tgt.records.map((r) => [r.id, recordHash(r)] as const));
        let records = job.metadata_filter
          ? src.records.filter((r) => matchesMetadataFilter(r.metadata, job.metadata_filter!))
          : src.records;
        const before = records.length;
        records = records.filter((r) => {
          const existing = targetByIdHash.get(r.id);
          if (!existing) return true;
          return recordHash(r) !== existing;
        });
        skipped += before - records.length;
        toUpsert = records;
      }

      if (toUpsert.length > 0) {
        const requestBytes = toUpsert.reduce((s, r) => s + approximateRecordBytes(r), 0);
        if (job.dry_run) {
          copied += toUpsert.length;
          wuConsumed += Math.max(5, Math.ceil(requestBytes / 1024));
        } else {
          const result = await tgtClient.upsert(job.target_index, ns.target_namespace, toUpsert, {
            batchRecords: upsertBatch,
          });
          copied += result.upsertedCount;
          wuConsumed += Math.max(5, Math.ceil(result.requestBytes / 1024));
        }
      }
      if (skipMode === 'id') skipped += preExistingCount;
      processed += ids.length;
    } catch (err) {
      failed += ids.length;
      reportBatchError(err);
    }
  };

  // ─── Pipelined dispatch with bounded concurrency and ordered checkpointing ────
  //
  // The list iterator runs ahead, slicing IDs into batches and dispatching them through
  // a `pLimit(maxInFlight)` pool. Each dispatched batch is tagged with the pagination
  // token that's safe to resume from *if and only if* every earlier batch has also
  // completed. We track that with a sequence-number commit cursor: `durableToken`
  // advances only when batches have completed in order, ensuring a worker crash
  // re-reads exactly the IDs that hadn't been fully processed (idempotent upserts
  // make this safe for the records that *had* been processed).
  const limit = pLimit(maxInFlight);
  const inflight = new Map<number, { token: string | null; done: boolean }>();
  const allPending = new Set<Promise<void>>();
  let nextSeq = 0;
  let commitCursor = 0;
  let durableToken: string | null = ns.pagination_token ?? null;

  const advanceCommit = (): void => {
    while (true) {
      const e = inflight.get(commitCursor);
      if (!e || !e.done) return;
      if (e.token !== null) durableToken = e.token;
      inflight.delete(commitCursor);
      commitCursor += 1;
    }
  };

  /**
   * Snapshot all counters in one synchronous turn so concurrent `+=` calls can't race
   * across DB-write field reads (e.g. persisting processed=500 alongside copied=1000).
   */
  const snap = () => ({
    processed,
    copied,
    skipped,
    failed,
    ru: ruConsumed,
    wu: wuConsumed,
  });

  let lastCancelCheck = 0;
  const cancelCheckMs = 2000;
  const checkCancellation = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastCancelCheck < cancelCheckMs) return;
    lastCancelCheck = now;
    if (await isJobCancelled(jobId)) throw new JobCancelledError(jobId);
  };

  let lastCheckpointAt = 0;
  const persistCheckpoint = async (force = false): Promise<void> => {
    const now = Date.now();
    // Throttle to ~2 writes/sec; counters move smoothly via SSE in between.
    if (!force && now - lastCheckpointAt < 500) return;
    lastCheckpointAt = now;
    const s = snap();
    await pool.query(
      `UPDATE namespace_progress
       SET pagination_token = $3, processed_records = $4, copied_records = $5,
           failed_records = $6, skipped_records = $7, ru_consumed = $8, wu_consumed = $9,
           error_message = COALESCE(error_message, $10),
           updated_at = now()
       WHERE job_id = $1 AND namespace = $2`,
      [
        jobId,
        ns.namespace,
        durableToken,
        s.processed,
        s.copied,
        s.failed,
        s.skipped,
        s.ru,
        s.wu,
        firstErrorMessage,
      ],
    );
  };

  const dispatchBatch = async (ids: string[], tokenAfter: string | null): Promise<void> => {
    // Backpressure: bound queued + running tasks to ~2× the concurrency cap so we don't
    // blow memory on huge namespaces by reading every list page upfront.
    while (allPending.size >= 2 * maxInFlight) {
      await Promise.race(Array.from(allPending));
    }
    const seq = nextSeq;
    nextSeq += 1;
    inflight.set(seq, { token: tokenAfter, done: false });
    const p: Promise<void> = limit(() => processBatch(ids)).then(() => {
      const entry = inflight.get(seq);
      if (entry) entry.done = true;
      advanceCommit();
      const s = snap();
      publishProgress({
        jobId,
        namespace: ns.namespace,
        processedRecords: s.processed,
        copiedRecords: s.copied,
        failedRecords: s.failed,
        skippedRecords: s.skipped,
        ruConsumed: s.ru,
        wuConsumed: s.wu,
      });
    });
    allPending.add(p);
    void p.finally(() => allPending.delete(p));
  };

  let lastListPageNextToken: string | null = ns.pagination_token ?? null;
  try {
    for await (const page of srcClient.listIds(job.source_index, ns.namespace, {
      pageSize,
      resumeToken: ns.pagination_token ?? undefined,
    })) {
      await checkCancellation();
      ruConsumed += page.readUnits ?? 1;
      buffered.push(...page.ids);
      lastListPageNextToken = page.nextToken;
      while (buffered.length >= fetchBatch) {
        const slice = buffered.splice(0, fetchBatch);
        // Token-after is only meaningful when this slice consumed everything from the
        // current page (and all earlier pages). Otherwise leftover IDs from the same
        // page haven't been dispatched yet, so we can't advance the resume cursor here.
        const tokenAfter = buffered.length === 0 ? page.nextToken : null;
        await dispatchBatch(slice, tokenAfter);
        await checkCancellation();
      }
      await persistCheckpoint();
    }
    if (buffered.length > 0) {
      const tail = buffered;
      buffered = [];
      // Tail batch covers the remainder of the very last page → safe to associate it
      // with that page's nextToken (typically null = end-of-list).
      await dispatchBatch(tail, lastListPageNextToken);
    }
    // Drain everything the limiter has queued before we declare the namespace done.
    await Promise.allSettled(Array.from(allPending));
    advanceCommit();
    await persistCheckpoint(true);
  } catch (err) {
    // On cancellation or unexpected failure, let any in-flight batches settle so we don't
    // leave orphan work behind, then propagate so the caller can mark the namespace.
    await Promise.allSettled(Array.from(allPending));
    advanceCommit();
    await persistCheckpoint(true).catch(() => {});
    throw err;
  }

  // Use the index's dimension to record an estimated total based on actual processed work.
  const total = await getNamespaceCount(srcClient, job.source_index, ns.namespace);
  await pool.query(
    `UPDATE namespace_progress
     SET status = 'completed', pagination_token = NULL,
         total_records = $3, processed_records = $4, copied_records = $5,
         failed_records = $6, skipped_records = $7, ru_consumed = $8, wu_consumed = $9,
         completed_at = now(), updated_at = now()
     WHERE job_id = $1 AND namespace = $2`,
    [jobId, ns.namespace, total, processed, copied, failed, skipped, ruConsumed, wuConsumed],
  );

  publishProgress({
    jobId,
    namespace: ns.namespace,
    status: 'completed',
    totalRecords: total,
    processedRecords: processed,
    copiedRecords: copied,
    failedRecords: failed,
    skippedRecords: skipped,
    ruConsumed,
    wuConsumed,
  });

  void dimension; // dimension currently informational; kept for future cost-aware throttling.
}

async function getNamespaceCount(
  client: Awaited<ReturnType<typeof clientFor>>,
  indexName: string,
  ns: string,
): Promise<number> {
  try {
    const stats = await client.describeIndexStats(indexName);
    return stats.namespaces[ns] ?? 0;
  } catch {
    return 0;
  }
}

function matchesMetadataFilter(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  if (!metadata) return false;
  // Minimal filter support: equality across all keys. Full Pinecone filter syntax is out of scope here.
  for (const [k, v] of Object.entries(filter)) {
    if (metadata[k] !== v) return false;
  }
  return true;
}
