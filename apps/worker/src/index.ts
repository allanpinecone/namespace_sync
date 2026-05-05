import { startCopyWorker } from './workers/copy.js';
import { startSyncPollWorker } from './workers/sync-poller.js';
import { startSyncConsumerSupervisor, shutdownSyncConsumers } from './workers/sync-consumer.js';
import { startVerifyWorker } from './workers/verify.js';
import { logger } from './logger.js';
import { shutdownKafka } from './kafka.js';
import { pool } from './db.js';

async function main(): Promise<void> {
  const copyWorker = startCopyWorker();
  const pollWorker = startSyncPollWorker();
  const verifyWorker = startVerifyWorker();
  await startSyncConsumerSupervisor();

  logger.info('Workers ready: copy, sync-poll, sync-consumer, verify');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down workers');
    await Promise.allSettled([copyWorker.close(), pollWorker.close(), verifyWorker.close()]);
    await shutdownSyncConsumers();
    await shutdownKafka();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(err, 'workers failed to start');
  process.exit(1);
});
