import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { VERIFY_QUEUE } from '@migrator/shared';
import { env } from '../config.js';
import { logger } from '../logger.js';
import { pool } from '../db.js';
import { clientFor } from '../connections.js';
import { recordHash, pLimit } from '../util.js';
import { recordAudit } from '../audit.js';

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

interface VerifyPayload {
  jobId: string;
  sampleSize: number;
}

interface VerifyJobRow {
  source_connection_id: string;
  target_connection_id: string;
  source_index: string;
  target_index: string;
}

interface NsRow {
  namespace: string;
  target_namespace: string;
}

/**
 * Verifier. For each namespace in a completed job, sample N source IDs, fetch from both
 * indexes in parallel, hash each record's vector + metadata and report mismatches.
 *
 * Mismatches and missing IDs are persisted to the `verification_runs` table so the UI can
 * surface them and offer a "re-copy these IDs" action.
 */
export function startVerifyWorker(): Worker {
  const worker = new Worker(
    VERIFY_QUEUE,
    async (job: Job<VerifyPayload>) => runVerify(job.data.jobId, job.data.sampleSize ?? 100),
    { connection, concurrency: env.WORKER_VERIFY_CONCURRENCY },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.data?.jobId, err }, 'verify worker failed'),
  );
  return worker;
}

async function runVerify(jobId: string, sampleSize: number): Promise<void> {
  const jobRes = await pool.query<VerifyJobRow>(
    `SELECT source_connection_id, target_connection_id, source_index, target_index
     FROM jobs WHERE id = $1`,
    [jobId],
  );
  const job = jobRes.rows[0];
  if (!job) return;

  const nsRes = await pool.query<NsRow>(
    `SELECT namespace, target_namespace FROM namespace_progress WHERE job_id = $1`,
    [jobId],
  );

  const [srcClient, tgtClient] = await Promise.all([
    clientFor(job.source_connection_id),
    clientFor(job.target_connection_id),
  ]);
  const limit = pLimit(4);

  await Promise.all(
    nsRes.rows.map((ns) =>
      limit(async () => {
        const sample = await sampleIds(srcClient, job.source_index, ns.namespace, sampleSize);
        if (sample.length === 0) {
          await pool.query(
            `INSERT INTO verification_runs (job_id, namespace, sample_size, matched, mismatched, missing, details)
             VALUES ($1, $2, $3, 0, 0, 0, $4::jsonb)`,
            [jobId, ns.namespace, 0, JSON.stringify({ note: 'empty namespace' })],
          );
          return;
        }

        const [srcRecords, tgtRecords] = await Promise.all([
          srcClient.fetch(job.source_index, ns.namespace, sample),
          tgtClient.fetch(job.target_index, ns.target_namespace, sample),
        ]);

        const tgtMap = new Map(tgtRecords.records.map((r) => [r.id, r]));
        let matched = 0;
        let mismatched = 0;
        let missing = 0;
        const mismatchDetails: Array<{ id: string; reason: string }> = [];
        for (const sr of srcRecords.records) {
          const tr = tgtMap.get(sr.id);
          if (!tr) {
            missing += 1;
            if (mismatchDetails.length < 50) mismatchDetails.push({ id: sr.id, reason: 'missing in target' });
            continue;
          }
          const sh = recordHash(sr);
          const th = recordHash(tr);
          if (sh === th) matched += 1;
          else {
            mismatched += 1;
            if (mismatchDetails.length < 50)
              mismatchDetails.push({ id: sr.id, reason: 'hash mismatch' });
          }
        }
        await pool.query(
          `INSERT INTO verification_runs (job_id, namespace, sample_size, matched, mismatched, missing, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            jobId,
            ns.namespace,
            sample.length,
            matched,
            mismatched,
            missing,
            JSON.stringify({ mismatchDetails }),
          ],
        );
        await recordAudit({
          jobId,
          eventType: 'verify.namespace',
          message: `${ns.namespace}: matched=${matched} mismatched=${mismatched} missing=${missing}`,
          details: { namespace: ns.namespace, matched, mismatched, missing },
        });
      }),
    ),
  );
}

async function sampleIds(
  client: Awaited<ReturnType<typeof clientFor>>,
  indexName: string,
  ns: string,
  desired: number,
): Promise<string[]> {
  const out: string[] = [];
  for await (const page of client.listIds(indexName, ns, { pageSize: 100 })) {
    out.push(...page.ids);
    if (out.length >= desired * 5) break;
  }
  if (out.length <= desired) return out;
  // Reservoir-style sample for randomness across the listed window.
  const picked = new Set<number>();
  while (picked.size < desired) picked.add(Math.floor(Math.random() * out.length));
  return [...picked].map((i) => out[i]!);
}
