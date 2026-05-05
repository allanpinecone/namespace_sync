import type {
  ConnectionInput,
  IndexInfo,
  NamespaceInfo,
  CreateCopyJobInput,
  CreateSyncJobInput,
  PricingConfig,
  NamespaceMapping,
} from '@migrator/shared';

const raw = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').trim();
const stripped = raw.replace(/\/$/, '');
/** Absolute origin (`http://localhost:4000`) or same-origin path prefix (`/migrator-api`). */
export const apiBase = stripped.length > 0 ? stripped : 'http://localhost:4000';

function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${apiBase}${p}`;
}

function hasJsonRequestBody(init?: RequestInit): boolean {
  const b = init?.body;
  if (b == null || b === '') return false;
  if (typeof b === 'string') return b.length > 0;
  // FormData / URLSearchParams / Blob — caller sets Content-Type if needed
  return false;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  if (hasJsonRequestBody(init) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(apiUrl(path), {
    ...init,
    cache: 'no-store',
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: string };
      if (typeof parsed?.message === 'string' && parsed.message.trim()) {
        detail = parsed.message;
      } else if (typeof parsed?.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      /* keep raw body */
    }
    throw new Error(`API ${res.status}: ${detail}`);
  }
  // DELETE handlers often return 204 No Content with no body; `res.json()` would throw.
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text.trim()) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export interface Connection {
  id: string;
  label: string;
  fingerprint: string;
  ephemeral: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export const api = {
  getPricing: (): Promise<PricingConfig> => fetchJson('/pricing'),
  listConnections: (): Promise<{ connections: Connection[] }> => fetchJson('/connections'),
  createConnection: (input: ConnectionInput): Promise<{ connection: Connection; indexes: IndexInfo[] }> =>
    fetchJson('/connections', { method: 'POST', body: JSON.stringify(input) }),
  deleteConnection: (id: string): Promise<{ ok: true }> =>
    fetchJson(`/connections/${id}`, { method: 'DELETE' }),
  forgetEphemeral: (): Promise<{ removed: number; skippedInUse: number }> =>
    fetchJson(`/connections/forget-ephemeral`, { method: 'POST' }),
  listIndexes: (id: string): Promise<{ indexes: IndexInfo[] }> => fetchJson(`/connections/${id}/indexes`),
  describeIndex: (id: string, indexName: string) =>
    fetchJson<{ index: IndexInfo; stats: { dimension: number | null; totalRecordCount: number; namespaces: Record<string, number> } }>(
      `/connections/${id}/indexes/${encodeURIComponent(indexName)}`,
    ),
  getNamespaces: (id: string, indexName: string, refresh = false) =>
    fetchJson<{ namespaces: NamespaceInfo[]; fromCache: boolean; refreshedAt: string }>(
      `/connections/${id}/indexes/${encodeURIComponent(indexName)}/namespaces${refresh ? '?refresh=1' : ''}`,
    ),
  estimateCopyCost: (body: {
    connectionId: string;
    indexName: string;
    namespaces: string[];
    sample?: boolean;
    sampleSizePerNamespace?: number;
    avgMetadataBytes?: number;
    pricingOverride?: PricingConfig;
  }) =>
    fetchJson<{
      breakdown: { perNamespace: NamespaceCostRow[]; totals: TotalsRow };
      sampledRecords: number;
      pricingAsOf: string;
    }>('/cost/estimate-copy', { method: 'POST', body: JSON.stringify(body) }),
  preflight: (body: {
    sourceConnectionId: string;
    sourceIndex: string;
    targetConnectionId: string;
    targetIndex: string;
    namespaces: string[];
    mapping: NamespaceMapping;
  }) =>
    fetchJson<{
      ok: boolean;
      checks: Array<{ id: string; level: 'pass' | 'warn' | 'fail'; message: string }>;
      mappingPreview: Array<{ source: string; target: string; recordCount: number; targetExists: boolean }>;
      totalRecordsToCopy: number;
      source: IndexInfo;
      target: IndexInfo;
    }>('/jobs/preflight', { method: 'POST', body: JSON.stringify(body) }),
  createCopyJob: (body: CreateCopyJobInput) =>
    fetchJson<{ job: JobSummary }>('/jobs/copy', { method: 'POST', body: JSON.stringify(body) }),
  createSyncJob: (body: CreateSyncJobInput) =>
    fetchJson<{ job: JobSummary }>('/jobs/sync', { method: 'POST', body: JSON.stringify(body) }),
  listJobs: () => fetchJson<{ jobs: JobSummary[] }>('/jobs'),
  getJob: (id: string) => fetchJson<JobDetailPayload>(`/jobs/${id}`),
  cancelJob: (id: string) => fetchJson(`/jobs/${id}/cancel`, { method: 'POST' }),
  pauseJob: (id: string) => fetchJson(`/jobs/${id}/pause`, { method: 'POST' }),
  resumeJob: (id: string) => fetchJson(`/jobs/${id}/resume`, { method: 'POST' }),
  confirmDeletes: (id: string) => fetchJson(`/jobs/${id}/confirm-deletes`, { method: 'POST' }),
  promoteJob: (id: string) => fetchJson(`/jobs/${id}/promote`, { method: 'POST' }),
  verifyJob: (id: string, sampleSize = 100) =>
    fetchJson(`/jobs/${id}/verify`, { method: 'POST', body: JSON.stringify({ sampleSize }) }),
  audit: (jobId?: string) =>
    fetchJson<{ audit: AuditRow[] }>(`/audit${jobId ? `?jobId=${jobId}` : ''}`),
};

export interface JobSummary {
  id: string;
  name: string;
  kind: 'copy' | 'sync';
  status: string;
  source_index: string;
  target_index: string;
  namespaces: string[];
  dry_run: boolean;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export interface NamespaceProgressRow {
  namespace: string;
  target_namespace: string;
  status: string;
  total_records: string | number;
  processed_records: string | number;
  copied_records: string | number;
  failed_records: string | number;
  /** Records the worker skipped because the target already had them (skip-existing modes). */
  skipped_records?: string | number | null;
  ru_consumed: string | number;
  wu_consumed: string | number;
  pagination_token: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export interface SyncStateRow {
  job_id: string;
  last_poll_at: string | null;
  last_poll_duration_ms: number | null;
  poll_passes: number;
  inserts_applied: number;
  deletes_applied: number;
  updates_applied: number;
  pending_ops: number;
  awaiting_delete_confirmation: boolean;
  pending_delete_count: number;
  paused: boolean;
  cutover_at: string | null;
}

/** Response shape for `GET /jobs/:id` (job dashboard + SSE snapshot). */
export type JobDetailPayload = {
  job: JobSummary;
  progress: NamespaceProgressRow[];
  syncState: SyncStateRow | null;
};

export interface AuditRow {
  id: number;
  job_id: string | null;
  actor: string | null;
  event_type: string;
  message: string | null;
  details: unknown;
  created_at: string;
}

export interface NamespaceCostRow {
  namespace: string;
  recordCount: number;
  avgRecordKB: number;
  listCalls: number;
  fetchCalls: number;
  upsertCalls: number;
  totalRU: number;
  totalWU: number;
  storageGB: number;
  sourceReadCostUsd: number;
  targetWriteCostUsd: number;
  totalUsd: number;
}

export interface TotalsRow {
  recordCount: number;
  totalRU: number;
  upsertWU: number;
  storageGB: number;
  sourceReadCostUsd: number;
  targetWriteCostUsd: number;
  monthlyStorageCostUsd: number;
  totalUsd: number;
}
