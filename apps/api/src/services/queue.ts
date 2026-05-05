import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { COPY_QUEUE, SYNC_POLL_QUEUE, VERIFY_QUEUE } from '@migrator/shared';
import { env } from '../config.js';

export const redisConnection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Default retention so finished BullMQ jobs do not pile up in Redis (we previously saw
 * thousands of `bull:sync-poll:*` keys accumulate across long-running migrations).
 */
const defaultJobOptions = {
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 3600 * 24, count: 200 },
};
export const copyQueue = new Queue(COPY_QUEUE, { connection: redisConnection, defaultJobOptions });
export const syncPollQueue = new Queue(SYNC_POLL_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});
export const verifyQueue = new Queue(VERIFY_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});

export const copyQueueEvents = new QueueEvents(COPY_QUEUE, { connection: redisConnection.duplicate() });
export const syncPollQueueEvents = new QueueEvents(SYNC_POLL_QUEUE, {
  connection: redisConnection.duplicate(),
});
export const verifyQueueEvents = new QueueEvents(VERIFY_QUEUE, { connection: redisConnection.duplicate() });

export async function shutdownQueues(): Promise<void> {
  await Promise.allSettled([
    copyQueue.close(),
    syncPollQueue.close(),
    verifyQueue.close(),
    copyQueueEvents.close(),
    syncPollQueueEvents.close(),
    verifyQueueEvents.close(),
  ]);
  redisConnection.disconnect();
}
