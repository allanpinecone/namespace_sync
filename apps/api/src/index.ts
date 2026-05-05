import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { env } from './config.js';
import { logger } from './logger.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerNamespaceRoutes } from './routes/namespaces.js';
import { registerCostRoutes } from './routes/cost.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerMiscRoutes } from './routes/misc.js';
import { startEventSubscriber } from './services/event-subscriber.js';
import { purgeEphemeralConnections } from './services/connections.js';
import { shutdownQueues } from './services/queue.js';

async function main(): Promise<void> {
  const app = Fastify({ loggerInstance: logger, bodyLimit: 10 * 1024 * 1024 });
  await app.register(cors, { origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()) });
  await app.register(sensible);

  await registerMiscRoutes(app);
  await registerConnectionRoutes(app);
  await registerNamespaceRoutes(app);
  await registerCostRoutes(app);
  await registerJobRoutes(app);

  // On boot, drop any ephemeral keys lingering from a previous session.
  const purged = await purgeEphemeralConnections();
  if (purged.removed > 0 || purged.skippedInUse > 0) {
    logger.info(purged, 'purged ephemeral connections from prior run');
  }

  await startEventSubscriber();

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  logger.info({ host: env.API_HOST, port: env.API_PORT }, 'API ready');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await shutdownQueues();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(err, 'API failed to start');
  process.exit(1);
});
