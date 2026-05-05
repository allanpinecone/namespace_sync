import IORedis from 'ioredis';
import { env } from './config.js';

const PROGRESS_CHANNEL = 'migrator:progress';

const publisher = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

export interface ProgressEvent {
  jobId: string;
  namespace?: string;
  status?: string;
  totalRecords?: number;
  processedRecords?: number;
  copiedRecords?: number;
  failedRecords?: number;
  skippedRecords?: number;
  ruConsumed?: number;
  wuConsumed?: number;
  message?: string;
  lagSeconds?: number;
  pendingOps?: number;
  syncInsertsApplied?: number;
  syncDeletesApplied?: number;
  syncUpdatesApplied?: number;
}

export function publishProgress(evt: ProgressEvent): void {
  publisher.publish(PROGRESS_CHANNEL, JSON.stringify(evt)).catch(() => {});
}
