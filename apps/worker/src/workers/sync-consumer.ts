import type { Consumer } from 'kafkajs';
import { cdcTopicForJob, type CdcMessage } from '@migrator/shared';
import { approximateRecordBytes } from '@migrator/pinecone-client';
import { logger } from '../logger.js';
import { pool } from '../db.js';
import { newConsumer } from '../kafka.js';
import { clientFor } from '../connections.js';
import { publishProgress } from '../events.js';
import { recordAudit } from '../audit.js';

interface SyncJobIds {
  source_connection_id: string;
  target_connection_id: string;
  source_index: string;
  target_index: string;
}

const consumers = new Map<string, Consumer>();

/**
 * Watch the jobs table for new sync jobs. For each one, spin up a Kafka consumer that reads
 * from the job's CDC topic and applies operations to the target index. Idempotent — calling
 * it multiple times for the same job is a no-op once the consumer exists.
 */
export async function startSyncConsumerSupervisor(): Promise<void> {
  // Initial pass
  await reconcileConsumers();
  // Cheap polling reconciliation; keeps the implementation simple and avoids needing PG LISTEN.
  setInterval(() => {
    void reconcileConsumers().catch((err) =>
      logger.error({ err }, 'sync consumer reconciliation failed'),
    );
  }, 10_000);
}

async function reconcileConsumers(): Promise<void> {
  const r = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM jobs WHERE kind = 'sync' AND status NOT IN ('completed','failed','cancelled')`,
  );
  const active = new Set(r.rows.map((row) => row.id));
  for (const jobId of active) {
    if (!consumers.has(jobId)) await spawnConsumer(jobId);
  }
  for (const [jobId, consumer] of consumers.entries()) {
    if (!active.has(jobId)) {
      await consumer.disconnect().catch(() => {});
      consumers.delete(jobId);
      logger.info({ jobId }, 'sync consumer stopped (job no longer active)');
    }
  }
}

async function spawnConsumer(jobId: string): Promise<void> {
  const groupId = `migrator.apply.${jobId}`;
  const consumer = await newConsumer(groupId);
  await consumer.subscribe({ topic: cdcTopicForJob(jobId), fromBeginning: true });
  consumers.set(jobId, consumer);
  logger.info({ jobId, groupId }, 'sync consumer started');

  await consumer.run({
    eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
      for (const message of batch.messages) {
        if (!message.value) continue;
        try {
          const msg = JSON.parse(message.value.toString()) as CdcMessage;
          await applyCdcMessage(msg);
          resolveOffset(message.offset);
          await heartbeat();
        } catch (err) {
          logger.error({ jobId, err, offset: message.offset }, 'failed to apply CDC message');
          // Don't resolve the offset; it will be retried after rebalance.
        }
      }
    },
  });
}

async function applyCdcMessage(msg: CdcMessage): Promise<void> {
  const r = await pool.query<SyncJobIds>(
    `SELECT source_connection_id, target_connection_id, source_index, target_index
     FROM jobs WHERE id = $1`,
    [msg.jobId],
  );
  const job = r.rows[0];
  if (!job) return;

  const [srcClient, tgtClient] = await Promise.all([
    clientFor(job.source_connection_id),
    clientFor(job.target_connection_id),
  ]);

  if (msg.op === 'UPSERT' || msg.op === 'UPDATE') {
    const fetched = await srcClient.fetch(job.source_index, msg.sourceNamespace, msg.ids);
    if (fetched.records.length > 0) {
      const result = await tgtClient.upsert(
        job.target_index,
        msg.targetNamespace,
        fetched.records,
        { batchRecords: 500 },
      );
      const wu = Math.max(5, Math.ceil(result.requestBytes / 1024));
      await pool.query(
        `UPDATE sync_state
         SET ${msg.op === 'UPSERT' ? 'inserts_applied' : 'updates_applied'} = ${msg.op === 'UPSERT' ? 'inserts_applied' : 'updates_applied'} + $2,
             pending_ops = GREATEST(0, pending_ops - $2)
         WHERE job_id = $1`,
        [msg.jobId, fetched.records.length],
      );
      publishProgress({
        jobId: msg.jobId,
        namespace: msg.targetNamespace,
        wuConsumed: wu,
        ...(msg.op === 'UPSERT'
          ? { syncInsertsApplied: fetched.records.length }
          : { syncUpdatesApplied: fetched.records.length }),
        message: `${msg.op} ${fetched.records.length} records applied`,
      });
      void approximateRecordBytes; // referenced for future op-cost accounting
    }
  } else if (msg.op === 'DELETE') {
    const result = await tgtClient.deleteMany(job.target_index, msg.targetNamespace, msg.ids);
    await pool.query(
      `UPDATE sync_state
       SET deletes_applied = deletes_applied + $2,
           pending_ops = GREATEST(0, pending_ops - $2)
       WHERE job_id = $1`,
      [msg.jobId, result.deletedCount],
    );
    publishProgress({
      jobId: msg.jobId,
      namespace: msg.targetNamespace,
      syncDeletesApplied: result.deletedCount,
      message: `DELETE ${result.deletedCount} records applied`,
    });
    await recordAudit({
      jobId: msg.jobId,
      eventType: 'sync.deletes_applied',
      details: { count: result.deletedCount, namespace: msg.targetNamespace },
    });
  }
}

export async function shutdownSyncConsumers(): Promise<void> {
  for (const c of consumers.values()) await c.disconnect().catch(() => {});
  consumers.clear();
}
