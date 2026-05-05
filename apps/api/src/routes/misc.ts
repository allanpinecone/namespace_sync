import type { AppInstance } from '../types-fastify.js';
import { listAudit } from '../services/audit.js';
import { registry } from '../services/metrics.js';

export async function registerMiscRoutes(app: AppInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true, timestamp: new Date().toISOString() }));

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return reply.send(await registry.metrics());
  });

  app.get('/audit', async (req) => {
    const { jobId, limit } = req.query as { jobId?: string; limit?: string };
    return { audit: await listAudit(jobId, limit ? Number(limit) : 200) };
  });
}
