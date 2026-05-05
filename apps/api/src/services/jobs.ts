import type {
  CreateCopyJobInput,
  CreateSyncJobInput,
  JobKind,
  JobStatus,
} from '@migrator/shared';
import { pool } from '../db/index.js';
import { copyQueue, syncPollQueue } from './queue.js';
import { applyMapping } from './preflight.js';
import { recordAudit } from './audit.js';
import { logger } from '../logger.js';

export interface JobRow {
  id: string;
  name: string;
  kind: JobKind;
  status: JobStatus;
  source_index: string;
  target_index: string;
  namespaces: string[];
  mapping: unknown;
  concurrency: unknown;
  copy_options: unknown;
  source_connection_id: string;
  target_connection_id: string;
  metadata_filter: unknown;
  dry_run: boolean;
  poll_interval_ms: number | null;
  tombstone_guard: unknown;
  version_field: unknown;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export async function createCopyJob(input: CreateCopyJobInput): Promise<JobRow> {
  const res = await pool.query<JobRow>(
    `INSERT INTO jobs (
       name, kind, status, source_connection_id, target_connection_id,
       source_index, target_index, namespaces, mapping, concurrency, copy_options,
       metadata_filter, dry_run
     ) VALUES ($1,'copy','pending',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)
     RETURNING *`,
    [
      input.name,
      input.sourceConnectionId,
      input.targetConnectionId,
      input.sourceIndex,
      input.targetIndex,
      input.namespaces,
      JSON.stringify(input.mapping),
      JSON.stringify(input.concurrency),
      JSON.stringify(input.copyOptions),
      input.metadataFilter ? JSON.stringify(input.metadataFilter) : null,
      input.dryRun,
    ],
  );
  const job = res.rows[0]!;
  await seedNamespaceProgress(job.id, input.namespaces, input.mapping);
  await copyQueue.add(
    `copy:${job.id}`,
    { jobId: job.id },
    {
      jobId: job.id,
      removeOnComplete: { age: 3600 * 24, count: 1000 },
      removeOnFail: { age: 3600 * 24 * 7, count: 1000 },
    },
  );
  await recordAudit({
    jobId: job.id,
    eventType: 'job.created',
    message: 'Copy job queued',
    details: { kind: 'copy', copyOptions: input.copyOptions },
  });
  logger.info({ jobId: job.id, namespaces: input.namespaces.length }, 'copy job created');
  return job;
}

export async function createSyncJob(input: CreateSyncJobInput): Promise<JobRow> {
  const res = await pool.query<JobRow>(
    `INSERT INTO jobs (
       name, kind, status, source_connection_id, target_connection_id,
       source_index, target_index, namespaces, mapping, concurrency, copy_options,
       metadata_filter, dry_run,
       poll_interval_ms, tombstone_guard, version_field
     ) VALUES ($1,'sync','pending',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb)
     RETURNING *`,
    [
      input.name,
      input.sourceConnectionId,
      input.targetConnectionId,
      input.sourceIndex,
      input.targetIndex,
      input.namespaces,
      JSON.stringify(input.mapping),
      JSON.stringify(input.concurrency),
      JSON.stringify(input.copyOptions),
      input.metadataFilter ? JSON.stringify(input.metadataFilter) : null,
      input.dryRun,
      input.pollIntervalMs,
      JSON.stringify(input.tombstoneGuard),
      JSON.stringify(input.versionField),
    ],
  );
  const job = res.rows[0]!;
  await seedNamespaceProgress(job.id, input.namespaces, input.mapping);
  await pool.query('INSERT INTO sync_state (job_id) VALUES ($1) ON CONFLICT DO NOTHING', [job.id]);

  // First, schedule a one-shot bootstrap copy (the sync poller will then keep both sides in lockstep).
  await copyQueue.add(`copy:bootstrap:${job.id}`, { jobId: job.id, isBootstrap: true });

  // Then schedule the recurring sync poll. The worker re-enqueues itself with the configured delay.
  await syncPollQueue.add(
    `sync:poll:${job.id}`,
    { jobId: job.id },
    { jobId: `sync:poll:${job.id}`, delay: 0 },
  );
  await recordAudit({
    jobId: job.id,
    eventType: 'job.created',
    message: 'Sync job queued (bootstrap + poller)',
    details: { kind: 'sync', pollIntervalMs: input.pollIntervalMs },
  });
  return job;
}

async function seedNamespaceProgress(
  jobId: string,
  namespaces: string[],
  mapping: CreateCopyJobInput['mapping'],
): Promise<void> {
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const ns of namespaces) {
    placeholders.push(`($${i++}, $${i++}, $${i++})`);
    values.push(jobId, ns, applyMapping(ns, mapping));
  }
  if (placeholders.length === 0) return;
  await pool.query(
    `INSERT INTO namespace_progress (job_id, namespace, target_namespace)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (job_id, namespace) DO NOTHING`,
    values,
  );
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  const res = await pool.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [jobId]);
  return res.rows[0] ?? null;
}

export async function listJobs(opts: { kind?: JobKind; limit?: number } = {}): Promise<JobRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) {
    params.push(opts.kind);
    conditions.push(`kind = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(opts.limit ?? 50);
  const res = await pool.query<JobRow>(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows;
}

export async function getJobNamespaceProgress(jobId: string): Promise<unknown[]> {
  const res = await pool.query(
    `SELECT namespace, target_namespace, status, total_records, processed_records,
            copied_records, failed_records, skipped_records, pagination_token,
            ru_consumed, wu_consumed,
            started_at, completed_at, error_message, updated_at
     FROM namespace_progress WHERE job_id = $1 ORDER BY namespace`,
    [jobId],
  );
  return res.rows;
}

export async function getSyncStateRow(jobId: string): Promise<unknown> {
  const res = await pool.query(
    'SELECT * FROM sync_state WHERE job_id = $1',
    [jobId],
  );
  return res.rows[0] ?? null;
}

export async function pauseSyncJob(jobId: string): Promise<void> {
  await pool.query('UPDATE sync_state SET paused = TRUE WHERE job_id = $1', [jobId]);
  await pool.query('UPDATE jobs SET status = $1, updated_at = now() WHERE id = $2', ['paused', jobId]);
  await recordAudit({ jobId, eventType: 'sync.paused' });
}

export async function resumeSyncJob(jobId: string): Promise<void> {
  await pool.query('UPDATE sync_state SET paused = FALSE WHERE job_id = $1', [jobId]);
  await pool.query('UPDATE jobs SET status = $1, updated_at = now() WHERE id = $2', ['running', jobId]);
  await syncPollQueue.add(
    `sync:poll:${jobId}`,
    { jobId },
    { jobId: `sync:poll:${jobId}`, delay: 0 },
  );
  await recordAudit({ jobId, eventType: 'sync.resumed' });
}

export async function confirmDeletes(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE sync_state SET awaiting_delete_confirmation = FALSE, pending_delete_count = 0 WHERE job_id = $1`,
    [jobId],
  );
  await syncPollQueue.add(
    `sync:poll:${jobId}`,
    { jobId },
    { jobId: `sync:poll:${jobId}`, delay: 0 },
  );
  await recordAudit({ jobId, eventType: 'sync.deletes_confirmed' });
}

/**
 * Mark a sync job as cut over: stop the poller, drain pending ops, freeze the consumer.
 * Records the cutover timestamp so the consumer supervisor stops the Kafka consumer next pass.
 */
export async function promoteSyncJob(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE sync_state SET cutover_at = now(), paused = TRUE WHERE job_id = $1`,
    [jobId],
  );
  await pool.query(
    `UPDATE jobs SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`,
    [jobId],
  );
  await Promise.allSettled([syncPollQueue.remove(`sync:poll:${jobId}`)]);
  await recordAudit({ jobId, eventType: 'sync.promoted', message: 'Cutover complete' });
}

export async function cancelJob(jobId: string): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE id = $1`, [jobId]);
  // Best-effort BullMQ cleanup. The worker also short-circuits any in-flight pass via the
  // status check, so even if removal misses we will not actually keep working on this job.
  await Promise.allSettled([
    copyQueue.remove(`copy:${jobId}`),
    copyQueue.remove(`copy:bootstrap:${jobId}`),
    syncPollQueue.remove(`sync:poll:${jobId}`),
    drainSyncPollDelayedFor(jobId),
  ]);
  await recordAudit({ jobId, eventType: 'job.cancelled' });
}

/**
 * Sweep delayed/waiting sync-poll jobs whose payload references this job. Pre-existing
 * deployments may have many already enqueued without our stable jobId, so cancel needs to
 * remove them by payload to actually stop the poll loop.
 */
async function drainSyncPollDelayedFor(jobId: string): Promise<void> {
  const jobs = await syncPollQueue.getJobs(['delayed', 'waiting', 'paused', 'prioritized']);
  for (const j of jobs) {
    if (j.data?.jobId === jobId) {
      await j.remove().catch(() => {});
    }
  }
}

