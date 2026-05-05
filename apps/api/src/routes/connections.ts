import type { AppInstance } from '../types-fastify.js';
import { connectionInputSchema } from '@migrator/shared';
import {
  createConnection,
  deleteConnection,
  listConnections,
  purgeEphemeralConnections,
  getClient,
  isFkViolation,
  ConnectionDeleteBlockedError,
} from '../services/connections.js';
import { recordAudit } from '../services/audit.js';

export async function registerConnectionRoutes(app: AppInstance): Promise<void> {
  app.get('/connections', async () => ({ connections: await listConnections() }));

  app.post('/connections', async (req, reply) => {
    const parsed = connectionInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const result = await createConnection(parsed.data);
      await recordAudit({
        eventType: 'connection.created',
        details: { connectionId: result.connection.id, indexCount: result.indexes.length },
      });
      return result;
    } catch (err) {
      req.log.warn({ err }, 'connection validation failed');
      return reply.code(401).send({
        error: 'Invalid Pinecone API key or unable to reach Pinecone',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.delete('/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteConnection(id);
    } catch (err) {
      if (err instanceof ConnectionDeleteBlockedError) {
        return reply.code(409).send({
          error:
            'This connection is still tied to jobs that are not finished (pending, preflight, running, or paused). Sync jobs stay "running" after the bootstrap copy until you promote or cancel them — do that first, then remove the connection.',
        });
      }
      if (isFkViolation(err)) {
        return reply.code(409).send({
          error:
            'This connection is still referenced by the database (e.g. an active job). Remove or finish related work, then try again.',
        });
      }
      throw err;
    }
    await recordAudit({ eventType: 'connection.deleted', details: { connectionId: id } });
    // JSON body avoids empty-body parsing quirks in browsers and proxies (older clients expected JSON here).
    return { ok: true as const };
  });

  app.post('/connections/forget-ephemeral', async () => {
    const result = await purgeEphemeralConnections();
    await recordAudit({
      eventType: 'connection.purge_ephemeral',
      details: { removed: result.removed, skippedInUse: result.skippedInUse },
    });
    return result;
  });

  app.get('/connections/:id/indexes', async (req) => {
    const { id } = req.params as { id: string };
    const client = await getClient(id);
    const indexes = await client.listIndexes();
    return { indexes };
  });

  app.get('/connections/:id/indexes/:indexName', async (req) => {
    const { id, indexName } = req.params as { id: string; indexName: string };
    const client = await getClient(id);
    const info = await client.describeIndex(indexName);
    const stats = await client.describeIndexStats(indexName);
    return { index: info, stats };
  });
}
