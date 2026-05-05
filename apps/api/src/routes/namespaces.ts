import type { AppInstance } from '../types-fastify.js';
import { getNamespaces, streamNamespaces } from '../services/namespaces.js';

export async function registerNamespaceRoutes(app: AppInstance): Promise<void> {
  app.get('/connections/:id/indexes/:indexName/namespaces', async (req) => {
    const { id, indexName } = req.params as { id: string; indexName: string };
    const { refresh } = req.query as { refresh?: string };
    const result = await getNamespaces(id, indexName, { forceRefresh: refresh === '1' });
    return result;
  });

  /**
   * SSE endpoint that streams namespaces in batches as they are paginated from Pinecone. The
   * client renders each batch as it arrives so users see results in seconds even at 100k+ namespaces.
   */
  app.get('/connections/:id/indexes/:indexName/namespaces/stream', async (req, reply) => {
    const { id, indexName } = req.params as { id: string; indexName: string };
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const total = await streamNamespaces(id, indexName, async (batch) => {
        send('namespaces', { batch });
      });
      send('complete', { total: total.length, refreshedAt: new Date().toISOString() });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
  });
}
