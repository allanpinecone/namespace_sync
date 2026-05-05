import type { JobStatus, JobKind, NamespaceMapping, ConcurrencyConfig } from './schemas.js';

export interface JobRecord {
  id: string;
  name: string;
  kind: JobKind;
  status: JobStatus;
  sourceIndex: string;
  targetIndex: string;
  namespaces: string[];
  mapping: NamespaceMapping;
  concurrency: ConcurrencyConfig;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface NamespaceProgress {
  jobId: string;
  namespace: string;
  targetNamespace: string;
  status: JobStatus;
  totalRecords: number;
  processedRecords: number;
  copiedRecords: number;
  failedRecords: number;
  paginationToken: string | null;
  startedAt: string | null;
  completedAt: string | null;
  ruConsumed: number;
  wuConsumed: number;
  errorMessage: string | null;
}

export type CdcOpType = 'UPSERT' | 'DELETE' | 'UPDATE';

/** Message shape published to the Kafka CDC topic for sync jobs. */
export interface CdcMessage {
  op: CdcOpType;
  jobId: string;
  sourceNamespace: string;
  targetNamespace: string;
  ids: string[];
  /** Wall-clock millis when the poller observed this op. */
  detectedAt: number;
}

export interface SyncJobStatusSummary {
  jobId: string;
  status: JobStatus;
  lastPollAt: string | null;
  lastPollDurationMs: number | null;
  lagSeconds: number | null;
  pendingOps: number;
  pollPasses: number;
  insertsApplied: number;
  deletesApplied: number;
  updatesApplied: number;
  versionFieldEnabled: boolean;
  awaitingDeleteConfirmation: boolean;
  pendingDeleteCount: number;
}
