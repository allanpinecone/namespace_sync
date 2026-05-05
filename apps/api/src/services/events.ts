import { EventEmitter } from 'node:events';

/**
 * In-process event bus used to fan progress updates from BullMQ workers (via Redis pub/sub
 * channels) out to SSE clients. Workers publish on Redis; the API subscribes and re-emits here.
 */
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(0);

export interface JobProgressEvent {
  type: 'progress';
  jobId: string;
  namespace?: string;
  totalRecords?: number;
  processedRecords?: number;
  copiedRecords?: number;
  failedRecords?: number;
  ruConsumed?: number;
  wuConsumed?: number;
  message?: string;
}

export interface JobStatusEvent {
  type: 'status';
  jobId: string;
  status: string;
  namespace?: string;
  message?: string;
}

export type JobEvent = JobProgressEvent | JobStatusEvent;

export const PROGRESS_CHANNEL = 'migrator:progress';
