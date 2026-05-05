import type { JobDetailPayload, NamespaceProgressRow, SyncStateRow } from '@/lib/api';

function rowMatchesNamespace(row: NamespaceProgressRow, ns: string): boolean {
  return row.namespace === ns || row.target_namespace === ns;
}

/**
 * Apply a worker `publishProgress` payload (camelCase) onto the last `GET /jobs/:id` payload
 * so the dashboard updates immediately without waiting for a refetch (avoids stale HTTP cache
 * and refetch races when many events arrive quickly).
 */
export function mergeJobDetailFromProgressEvent(
  prev: JobDetailPayload,
  evt: Record<string, unknown>,
): JobDetailPayload {
  let next: JobDetailPayload = prev;

  const ns = typeof evt.namespace === 'string' ? evt.namespace : undefined;
  const hasCopyCounters =
    typeof evt.processedRecords === 'number' ||
    typeof evt.copiedRecords === 'number' ||
    typeof evt.totalRecords === 'number' ||
    typeof evt.failedRecords === 'number' ||
    typeof evt.skippedRecords === 'number' ||
    typeof evt.ruConsumed === 'number' ||
    typeof evt.wuConsumed === 'number';

  if (ns && (hasCopyCounters || typeof evt.status === 'string')) {
    next = {
      ...next,
      progress: next.progress.map((row) => {
        if (!rowMatchesNamespace(row, ns)) return row;
        const u = { ...row };
        if (typeof evt.status === 'string') u.status = evt.status;
        if (typeof evt.totalRecords === 'number') u.total_records = evt.totalRecords;
        if (typeof evt.processedRecords === 'number') u.processed_records = evt.processedRecords;
        if (typeof evt.copiedRecords === 'number') u.copied_records = evt.copiedRecords;
        if (typeof evt.failedRecords === 'number') u.failed_records = evt.failedRecords;
        if (typeof evt.skippedRecords === 'number') u.skipped_records = evt.skippedRecords;
        if (typeof evt.ruConsumed === 'number') u.ru_consumed = evt.ruConsumed;
        if (typeof evt.wuConsumed === 'number') u.wu_consumed = evt.wuConsumed;
        return u;
      }),
    };
  }

  if (
    next.syncState &&
    (typeof evt.pendingOps === 'number' ||
      typeof evt.syncInsertsApplied === 'number' ||
      typeof evt.syncDeletesApplied === 'number' ||
      typeof evt.syncUpdatesApplied === 'number')
  ) {
    const s: SyncStateRow = { ...next.syncState };
    if (typeof evt.pendingOps === 'number') {
      s.pending_ops = evt.pendingOps;
    } else {
      if (typeof evt.syncInsertsApplied === 'number') {
        s.inserts_applied = Number(s.inserts_applied) + evt.syncInsertsApplied;
        s.pending_ops = Math.max(0, Number(s.pending_ops) - evt.syncInsertsApplied);
      }
      if (typeof evt.syncUpdatesApplied === 'number') {
        s.updates_applied = Number(s.updates_applied) + evt.syncUpdatesApplied;
        s.pending_ops = Math.max(0, Number(s.pending_ops) - evt.syncUpdatesApplied);
      }
      if (typeof evt.syncDeletesApplied === 'number') {
        s.deletes_applied = Number(s.deletes_applied) + evt.syncDeletesApplied;
        s.pending_ops = Math.max(0, Number(s.pending_ops) - evt.syncDeletesApplied);
      }
    }
    next = { ...next, syncState: s };
  }

  return next;
}
