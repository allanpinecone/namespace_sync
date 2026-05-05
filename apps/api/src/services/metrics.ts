import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const counters = {
  recordsCopied: new client.Counter({
    name: 'migrator_records_copied_total',
    help: 'Number of records successfully upserted into the target index',
    labelNames: ['job_id', 'namespace'],
    registers: [registry],
  }),
  recordsFailed: new client.Counter({
    name: 'migrator_records_failed_total',
    help: 'Number of records that failed to copy',
    labelNames: ['job_id', 'namespace'],
    registers: [registry],
  }),
  ruConsumed: new client.Counter({
    name: 'migrator_read_units_total',
    help: 'Read units consumed against the source index',
    labelNames: ['job_id'],
    registers: [registry],
  }),
  wuConsumed: new client.Counter({
    name: 'migrator_write_units_total',
    help: 'Write units consumed against the target index (estimated)',
    labelNames: ['job_id'],
    registers: [registry],
  }),
  syncInserts: new client.Counter({
    name: 'migrator_sync_inserts_total',
    help: 'CDC insert ops applied to target',
    labelNames: ['job_id'],
    registers: [registry],
  }),
  syncDeletes: new client.Counter({
    name: 'migrator_sync_deletes_total',
    help: 'CDC delete ops applied to target',
    labelNames: ['job_id'],
    registers: [registry],
  }),
  syncUpdates: new client.Counter({
    name: 'migrator_sync_updates_total',
    help: 'CDC update ops applied to target',
    labelNames: ['job_id'],
    registers: [registry],
  }),
};

export const gauges = {
  syncLagSeconds: new client.Gauge({
    name: 'migrator_sync_lag_seconds',
    help: 'Seconds since the last successful sync poll completed',
    labelNames: ['job_id'],
    registers: [registry],
  }),
  syncPendingOps: new client.Gauge({
    name: 'migrator_sync_pending_ops',
    help: 'Number of CDC ops detected but not yet applied',
    labelNames: ['job_id'],
    registers: [registry],
  }),
};
