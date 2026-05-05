import type { AppInstance } from '../types-fastify.js';
import {
  cancelJob,
  confirmDeletes,
  createCopyJob,
  createSyncJob,
  getJob,
  getJobNamespaceProgress,
  getSyncStateRow,
  listJobs,
  pauseSyncJob,
  promoteSyncJob,
  resumeSyncJob,
} from '../services/jobs.js';
import {
  createCopyJobSchema,
  createSyncJobSchema,
  jobKindSchema,
} from '@migrator/shared';
import { eventBus } from '../services/events.js';
import { runPreflight } from '../services/preflight.js';
import { z } from 'zod';
import { verifyQueue } from '../services/queue.js';
import { recordAudit } from '../services/audit.js';

const preflightSchema = z.object({
  sourceConnectionId: z.string().uuid(),
  sourceIndex: z.string(),
  targetConnectionId: z.string().uuid(),
  targetIndex: z.string(),
  namespaces: z.array(z.string()).min(1),
  mapping: createCopyJobSchema.shape.mapping,
});

const verifySchema = z.object({
  sampleSize: z.number().int().min(1).max(2000).default(100),
});

export async function registerJobRoutes(app: AppInstance): Promise<void> {
  app.post('/jobs/preflight', async (req, reply) => {
    const parsed = preflightSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return await runPreflight(parsed.data);
  });

  app.post('/jobs/copy', async (req, reply) => {
    const parsed = createCopyJobSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const job = await createCopyJob(parsed.data);
    return { job };
  });

  app.post('/jobs/sync', async (req, reply) => {
    const parsed = createSyncJobSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const job = await createSyncJob(parsed.data);
    return { job };
  });

  app.get('/jobs', async (req) => {
    const { kind } = req.query as { kind?: string };
    const parsedKind = kind ? jobKindSchema.parse(kind) : undefined;
    return { jobs: await listJobs({ kind: parsedKind }) };
  });

  app.get('/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');
    const job = await getJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    const [progress, syncState] = await Promise.all([
      getJobNamespaceProgress(id),
      getSyncStateRow(id),
    ]);
    return { job, progress, syncState };
  });

  app.post('/jobs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    await cancelJob(id);
    return { ok: true };
  });

  app.post('/jobs/:id/pause', async (req) => {
    const { id } = req.params as { id: string };
    await pauseSyncJob(id);
    return { ok: true };
  });

  app.post('/jobs/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    await resumeSyncJob(id);
    return { ok: true };
  });

  app.post('/jobs/:id/confirm-deletes', async (req) => {
    const { id } = req.params as { id: string };
    await confirmDeletes(id);
    return { ok: true };
  });

  app.post('/jobs/:id/promote', async (req) => {
    const { id } = req.params as { id: string };
    await promoteSyncJob(id);
    return { ok: true };
  });

  app.post('/jobs/:id/verify', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = verifySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await verifyQueue.add(`verify:${id}`, { jobId: id, sampleSize: parsed.data.sampleSize });
    await recordAudit({ jobId: id, eventType: 'verify.requested', details: parsed.data });
    return { ok: true };
  });

  /** SSE: live progress events for a single job. */
  app.get('/jobs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const onEvent = (evt: { jobId: string }): void => {
      if (evt.jobId !== id) return;
      send('update', evt);
    };
    eventBus.on('job', onEvent);

    // Heartbeat every 15s so proxies don't time us out.
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      eventBus.off('job', onEvent);
    });

    // Send a snapshot immediately so the client renders before the next event.
    const job = await getJob(id);
    if (job) {
      const progress = await getJobNamespaceProgress(id);
      const syncState = await getSyncStateRow(id);
      send('snapshot', { job, progress, syncState });
    }
  });
}
