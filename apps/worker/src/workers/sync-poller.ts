import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { SYNC_POLL_QUEUE, cdcTopicForJob, type CdcMessage } from '@migrator/shared';
import { env } from '../config.js';
import { logger } from '../logger.js';
import { pool } from '../db.js';
import { clientFor } from '../connections.js';
import { publishProgress } from '../events.js';
import { getProducer } from '../kafka.js';
import { setDiff, pLimit } from '../util.js';
import { recordAudit } from '../audit.js';

interface PollPayload {
  jobId: string;
}

interface SyncJobRow {
  id: string;
  source_connection_id: string;
  target_connection_id: string;
  source_index: string;
  target_index: string;
  poll_interval_ms: number;
  tombstone_guard: { maxDeletePctPerPass: number };
  version_field: { enabled: boolean; field: string; samplePerPass: number };
  concurrency: { maxNamespacesInFlight: number; listPageSize: number };
}

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const localQueue = new Queue(SYNC_POLL_QUEUE, {
  connection,
  defaultJobOptions: {
    // Without retention BullMQ keeps every completed/failed sync poll forever, which is
    // why a long-running migrator can pile up thousands of `bull:sync-poll:*` keys in Redis.
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 3600 * 24, count: 100 },
  },
});

/**
 * SyncPoller. Each pass:
 *   1. List source IDs and target IDs for every selected namespace.
 *   2. Compute set-difference: inserts (in source not target), deletes (in target not source).
 *   3. Tombstone-safety: if delete proportion > guard threshold, pause and require user confirm.
 *   4. Optionally: in version-field mode, sample metadata for matching IDs and detect updates.
 *   5. Publish CDC messages to Kafka so the apply consumer can process them downstream.
 * Re-enqueues itself with the configured `pollIntervalMs` delay until paused/cancelled.
 */
export function startSyncPollWorker(): Worker {
  const worker = new Worker(
    SYNC_POLL_QUEUE,
    async (job: Job<PollPayload>) => runPoll(job.data.jobId),
    { connection, concurrency: env.WORKER_SYNC_POLL_CONCURRENCY },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.data?.jobId, err }, 'sync poller failed'),
  );
  return worker;
}

async function runPoll(jobId: string): Promise<void> {
  const r = await pool.query<SyncJobRow & { status: string }>(
    `SELECT id, status, source_connection_id, target_connection_id, source_index, target_index,
            poll_interval_ms, tombstone_guard, version_field, concurrency
     FROM jobs WHERE id = $1 AND kind = 'sync'`,
    [jobId],
  );
  const job = r.rows[0];
  if (!job) return;
  if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
    logger.info({ jobId, status: job.status }, 'sync poller exiting; job is terminal');
    return;
  }

  const stateRow = await pool.query<{ paused: boolean; awaiting_delete_confirmation: boolean; cutover_at: string | null }>(
    `SELECT paused, awaiting_delete_confirmation, cutover_at FROM sync_state WHERE job_id = $1`,
    [jobId],
  );
  const state = stateRow.rows[0];
  if (!state) return;
  if (state.cutover_at) {
    logger.info({ jobId }, 'sync job already cut over; not re-enqueuing');
    return;
  }
  if (state.paused) {
    logger.info({ jobId }, 'sync job paused; deferring next poll');
    await localQueue.add(
      `sync:poll:${jobId}`,
      { jobId },
      { jobId: `sync:poll:${jobId}`, delay: job.poll_interval_ms },
    );
    return;
  }
  if (state.awaiting_delete_confirmation) {
    logger.info({ jobId }, 'awaiting delete confirmation; deferring');
    await localQueue.add(
      `sync:poll:${jobId}`,
      { jobId },
      { jobId: `sync:poll:${jobId}`, delay: job.poll_interval_ms },
    );
    return;
  }

  const startedAt = Date.now();

  const nsRows = await pool.query<{ namespace: string; target_namespace: string }>(
    `SELECT namespace, target_namespace FROM namespace_progress WHERE job_id = $1`,
    [jobId],
  );
  const namespaces = nsRows.rows;
  const [srcClient, tgtClient] = await Promise.all([
    clientFor(job.source_connection_id),
    clientFor(job.target_connection_id),
  ]);
  const producer = await getProducer();
  const topic = cdcTopicForJob(jobId);
  const limit = pLimit(job.concurrency.maxNamespacesInFlight ?? 4);

  let totalInserts = 0;
  let totalDeletes = 0;
  let totalUpdates = 0;
  let totalSourceCount = 0;
  let pendingDeleteCount = 0;
  let triggerTombstoneGuard = false;

  await Promise.all(
    namespaces.map((ns) =>
      limit(async () => {
        try {
          const [sourceIds, targetIds] = await Promise.all([
            collectAllIds(srcClient, job.source_index, ns.namespace, job.concurrency.listPageSize),
            collectAllIds(tgtClient, job.target_index, ns.target_namespace, job.concurrency.listPageSize),
          ]);
          totalSourceCount += sourceIds.length;
          const inserts = setDiff(sourceIds, targetIds);
          const deletes = setDiff(targetIds, sourceIds);

          // Tombstone safety per namespace
          const guardThreshold = job.tombstone_guard?.maxDeletePctPerPass ?? 0.1;
          const totalEither = Math.max(targetIds.length, 1);
          const deletePct = deletes.length / totalEither;
          const localTrigger = deletePct > guardThreshold && deletes.length > 50;
          if (localTrigger) {
            triggerTombstoneGuard = true;
            pendingDeleteCount += deletes.length;
          }

          const messages: { value: string }[] = [];
          if (inserts.length > 0) {
            for (const chunk of chunkArray(inserts, 500)) {
              const msg: CdcMessage = {
                op: 'UPSERT',
                jobId,
                sourceNamespace: ns.namespace,
                targetNamespace: ns.target_namespace,
                ids: chunk,
                detectedAt: Date.now(),
              };
              messages.push({ value: JSON.stringify(msg) });
              totalInserts += chunk.length;
            }
          }
          if (deletes.length > 0 && !localTrigger) {
            for (const chunk of chunkArray(deletes, 1000)) {
              const msg: CdcMessage = {
                op: 'DELETE',
                jobId,
                sourceNamespace: ns.namespace,
                targetNamespace: ns.target_namespace,
                ids: chunk,
                detectedAt: Date.now(),
              };
              messages.push({ value: JSON.stringify(msg) });
              totalDeletes += chunk.length;
            }
          }

          // Optional: version-field detection. Sample up to N source IDs that exist on both sides
          // and compare a metadata version field; replicate where source is newer.
          if (job.version_field?.enabled && sourceIds.length > 0) {
            const both = sourceIds.filter((id) => targetIds.includes(id));
            const sampleSize = Math.min(job.version_field.samplePerPass ?? 2000, both.length, 10000);
            if (sampleSize > 0) {
              const sample = sampleArray(both, sampleSize);
              const updateIds = await detectVersionUpdates(
                srcClient,
                tgtClient,
                job.source_index,
                job.target_index,
                ns,
                sample,
                job.version_field.field,
              );
              if (updateIds.length > 0) {
                for (const chunk of chunkArray(updateIds, 500)) {
                  const msg: CdcMessage = {
                    op: 'UPDATE',
                    jobId,
                    sourceNamespace: ns.namespace,
                    targetNamespace: ns.target_namespace,
                    ids: chunk,
                    detectedAt: Date.now(),
                  };
                  messages.push({ value: JSON.stringify(msg) });
                  totalUpdates += chunk.length;
                }
              }
            }
          }

          if (messages.length > 0) {
            await producer.send({ topic, messages });
          }
        } catch (err) {
          logger.warn({ jobId, namespace: ns.namespace, err }, 'sync poll for namespace failed');
        }
      }),
    ),
  );

  const elapsed = Date.now() - startedAt;
  const pendingOps = totalInserts + totalDeletes + totalUpdates;

  await pool.query(
    `UPDATE sync_state
     SET last_poll_at = now(), last_poll_duration_ms = $2, poll_passes = poll_passes + 1,
         pending_ops = $3, awaiting_delete_confirmation = $4, pending_delete_count = $5
     WHERE job_id = $1`,
    [jobId, elapsed, pendingOps, triggerTombstoneGuard, pendingDeleteCount],
  );

  publishProgress({
    jobId,
    status: 'running',
    pendingOps,
    lagSeconds: 0,
    message: `Pass complete: +${totalInserts} -${totalDeletes} ~${totalUpdates}`,
  });
  if (triggerTombstoneGuard) {
    publishProgress({
      jobId,
      status: 'paused',
      message: `Tombstone guard tripped: ${pendingDeleteCount} pending deletes require confirmation`,
    });
    await recordAudit({
      jobId,
      eventType: 'sync.tombstone_guard_tripped',
      details: { pendingDeleteCount },
    });
  }

  // Re-enqueue self for the next pass. One in-flight job per sync at a time (jobId option
  // dedupes); BullMQ removes its key on completion (defaultJobOptions).
  await localQueue.add(
    `sync:poll:${jobId}`,
    { jobId },
    { jobId: `sync:poll:${jobId}`, delay: job.poll_interval_ms },
  );
  void totalSourceCount;
}

async function collectAllIds(
  client: Awaited<ReturnType<typeof clientFor>>,
  indexName: string,
  ns: string,
  pageSize: number,
): Promise<string[]> {
  const out: string[] = [];
  for await (const page of client.listIds(indexName, ns, { pageSize: pageSize ?? 100 })) {
    out.push(...page.ids);
  }
  return out;
}

async function detectVersionUpdates(
  srcClient: Awaited<ReturnType<typeof clientFor>>,
  tgtClient: Awaited<ReturnType<typeof clientFor>>,
  srcIndex: string,
  tgtIndex: string,
  ns: { namespace: string; target_namespace: string },
  ids: string[],
  field: string,
): Promise<string[]> {
  const [srcRecords, tgtRecords] = await Promise.all([
    srcClient.fetch(srcIndex, ns.namespace, ids),
    tgtClient.fetch(tgtIndex, ns.target_namespace, ids),
  ]);
  const tgtMap = new Map(tgtRecords.records.map((r) => [r.id, r.metadata?.[field]]));
  const out: string[] = [];
  for (const r of srcRecords.records) {
    const sv = r.metadata?.[field];
    const tv = tgtMap.get(r.id);
    if (sv != null && (tv == null || compareVersion(sv, tv) > 0)) out.push(r.id);
  }
  return out;
}

function compareVersion(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  // Try ISO timestamp parse, otherwise lexicographic.
  const da = Date.parse(sa);
  const db = Date.parse(sb);
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return sa.localeCompare(sb);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sampleArray<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const out = arr.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (out.length - i));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.slice(0, n);
}
