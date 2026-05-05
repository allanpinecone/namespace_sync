/**
 * Kafka topic names used by the sync poller (producer) and the apply consumer.
 * Each sync job gets its own topic so we can scale consumers per job and inspect lag in isolation.
 */
export const cdcTopicForJob = (jobId: string): string => `migrator.cdc.${jobId}`;

/** BullMQ queue names. */
export const COPY_QUEUE = 'copy-jobs';
export const SYNC_POLL_QUEUE = 'sync-poll';
export const VERIFY_QUEUE = 'verify-jobs';
