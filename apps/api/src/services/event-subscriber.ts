import IORedis from 'ioredis';
import { eventBus, PROGRESS_CHANNEL } from './events.js';
import { gauges, counters } from './metrics.js';
import { env } from '../config.js';
import { logger } from '../logger.js';

/**
 * Subscribe to the worker -> API Redis pub/sub channel and re-emit on the in-process bus.
 * Workers publish JSON-encoded job events; we forward them to SSE listeners and to Prom counters.
 */
export async function startEventSubscriber(): Promise<void> {
  const sub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await sub.subscribe(PROGRESS_CHANNEL);
  sub.on('message', (_channel, raw) => {
    try {
      const evt = JSON.parse(raw) as Record<string, unknown>;
      eventBus.emit('job', evt);

      const jobId = String(evt.jobId ?? '');
      if (!jobId) return;
      if (typeof evt.copiedRecords === 'number') {
        const ns = String(evt.namespace ?? '');
        counters.recordsCopied.inc({ job_id: jobId, namespace: ns }, evt.copiedRecords);
      }
      if (typeof evt.failedRecords === 'number') {
        const ns = String(evt.namespace ?? '');
        counters.recordsFailed.inc({ job_id: jobId, namespace: ns }, evt.failedRecords);
      }
      if (typeof evt.ruConsumed === 'number') counters.ruConsumed.inc({ job_id: jobId }, evt.ruConsumed);
      if (typeof evt.wuConsumed === 'number') counters.wuConsumed.inc({ job_id: jobId }, evt.wuConsumed);
      if (typeof evt.lagSeconds === 'number') gauges.syncLagSeconds.set({ job_id: jobId }, evt.lagSeconds);
      if (typeof evt.pendingOps === 'number') gauges.syncPendingOps.set({ job_id: jobId }, evt.pendingOps);
      if (typeof evt.syncInsertsApplied === 'number')
        counters.syncInserts.inc({ job_id: jobId }, evt.syncInsertsApplied);
      if (typeof evt.syncDeletesApplied === 'number')
        counters.syncDeletes.inc({ job_id: jobId }, evt.syncDeletesApplied);
      if (typeof evt.syncUpdatesApplied === 'number')
        counters.syncUpdates.inc({ job_id: jobId }, evt.syncUpdatesApplied);
    } catch (err) {
      logger.warn({ err }, 'failed to parse worker event');
    }
  });
}
