import type { PricingConfig } from '@migrator/shared';

const DEFAULT_ID_BYTES = 36; // typical UUID
const DEFAULT_METADATA_BYTES = 500; // generous default before sampling

export interface NamespaceCostInput {
  namespace: string;
  recordCount: number;
  /** Pinecone dense-vector dimension. Set to 0 for sparse-only indexes. */
  dimension: number;
  /** Average ID size in bytes (default 36 for UUID). */
  avgIdBytes?: number;
  /** Average metadata size in bytes. If unknown, supply a sample-based estimate. */
  avgMetadataBytes?: number;
  /** For sparse vectors: average non-zero values count per record. */
  avgSparseNonZeroValues?: number;
}

export interface NamespaceCostBreakdown {
  namespace: string;
  recordCount: number;
  avgRecordKB: number;
  listCalls: number;
  fetchCalls: number;
  upsertCalls: number;
  listRU: number;
  fetchRU: number;
  totalRU: number;
  upsertWU: number;
  totalWU: number;
  storageGB: number;
  sourceReadCostUsd: number;
  targetWriteCostUsd: number;
  monthlyStorageCostUsd: number;
  totalUsd: number;
}

export interface CopyJobCostBreakdown {
  perNamespace: NamespaceCostBreakdown[];
  totals: {
    recordCount: number;
    listRU: number;
    fetchRU: number;
    totalRU: number;
    upsertWU: number;
    storageGB: number;
    sourceReadCostUsd: number;
    targetWriteCostUsd: number;
    monthlyStorageCostUsd: number;
    totalUsd: number;
  };
}

const ceilDiv = (a: number, b: number): number => (b === 0 ? 0 : Math.ceil(a / b));

/**
 * Compute the average byte size of a single record, including ID, metadata, and vector payload.
 * Mirrors the formula from https://docs.pinecone.io/guides/manage-cost/understanding-cost
 */
export function avgRecordBytes(input: NamespaceCostInput): number {
  const idBytes = input.avgIdBytes ?? DEFAULT_ID_BYTES;
  const metadataBytes = input.avgMetadataBytes ?? DEFAULT_METADATA_BYTES;
  const dense = input.dimension > 0 ? input.dimension * 4 : 0;
  const sparse = (input.avgSparseNonZeroValues ?? 0) * 8;
  return idBytes + metadataBytes + dense + sparse;
}

/**
 * Estimate the cost to copy a single namespace from source to target with the
 * `list -> fetch -> upsert` pipeline used by the copy engine.
 *
 * - List has a fixed cost of 1 RU per call; up to 100 IDs per call.
 * - Fetch has a cost of 1 RU per 10 records, with a 1-RU minimum per request.
 * - Upsert costs 1 WU per 1 KB of request body, with a 5-WU minimum per request.
 */
export function estimateNamespaceCost(
  input: NamespaceCostInput,
  pricing: PricingConfig,
  upsertBatchSize = 500,
  fetchBatchSize = 500,
): NamespaceCostBreakdown {
  const recordCount = Math.max(0, Math.floor(input.recordCount));
  const recordBytes = avgRecordBytes(input);
  const recordKB = recordBytes / 1024;

  const listIdsPerCall = Math.max(1, pricing.operationCosts.listIdsPerCall);
  const listCalls = ceilDiv(recordCount, listIdsPerCall);
  const listRU = listCalls * pricing.operationCosts.listRUPerCall;

  // Fetch: 1 RU per 10 records, 1 RU minimum per request.
  const fetchCalls = ceilDiv(recordCount, fetchBatchSize);
  const fetchRecordsRU = (recordCount * pricing.operationCosts.fetchRUPer10Records) / 10;
  const fetchMinFloor = fetchCalls * pricing.operationCosts.fetchMinRU;
  const fetchRU = Math.max(fetchRecordsRU, fetchMinFloor);

  const upsertCalls = ceilDiv(recordCount, upsertBatchSize);
  const upsertBodyKB = recordCount * recordKB;
  const upsertMinFloor = upsertCalls * pricing.operationCosts.upsertMinWUPerRequest;
  const upsertWU = Math.max(upsertBodyKB * pricing.operationCosts.upsertWUPerKB, upsertMinFloor);

  const totalRU = listRU + fetchRU;
  const totalWU = upsertWU;

  const storageGB = (recordCount * recordBytes) / (1024 * 1024 * 1024);
  const sourceReadCostUsd = totalRU * pricing.rates.readUnit;
  const targetWriteCostUsd = totalWU * pricing.rates.writeUnit;
  const monthlyStorageCostUsd = storageGB * pricing.rates.storageGBMonth;

  return {
    namespace: input.namespace,
    recordCount,
    avgRecordKB: round(recordKB, 4),
    listCalls,
    fetchCalls,
    upsertCalls,
    listRU: round(listRU, 2),
    fetchRU: round(fetchRU, 2),
    totalRU: round(totalRU, 2),
    upsertWU: round(upsertWU, 2),
    totalWU: round(totalWU, 2),
    storageGB: round(storageGB, 4),
    sourceReadCostUsd: round(sourceReadCostUsd, 4),
    targetWriteCostUsd: round(targetWriteCostUsd, 4),
    monthlyStorageCostUsd: round(monthlyStorageCostUsd, 4),
    totalUsd: round(sourceReadCostUsd + targetWriteCostUsd, 4),
  };
}

/** Sum a per-namespace cost array into a single rolled-up cost breakdown. */
export function rollupCopyJobCost(
  inputs: NamespaceCostInput[],
  pricing: PricingConfig,
  upsertBatchSize = 500,
  fetchBatchSize = 500,
): CopyJobCostBreakdown {
  const perNamespace = inputs.map((i) =>
    estimateNamespaceCost(i, pricing, upsertBatchSize, fetchBatchSize),
  );
  const totals = perNamespace.reduce(
    (acc, n) => {
      acc.recordCount += n.recordCount;
      acc.listRU += n.listRU;
      acc.fetchRU += n.fetchRU;
      acc.totalRU += n.totalRU;
      acc.upsertWU += n.upsertWU;
      acc.storageGB += n.storageGB;
      acc.sourceReadCostUsd += n.sourceReadCostUsd;
      acc.targetWriteCostUsd += n.targetWriteCostUsd;
      acc.monthlyStorageCostUsd += n.monthlyStorageCostUsd;
      acc.totalUsd += n.totalUsd;
      return acc;
    },
    {
      recordCount: 0,
      listRU: 0,
      fetchRU: 0,
      totalRU: 0,
      upsertWU: 0,
      storageGB: 0,
      sourceReadCostUsd: 0,
      targetWriteCostUsd: 0,
      monthlyStorageCostUsd: 0,
      totalUsd: 0,
    },
  );
  // round totals
  totals.listRU = round(totals.listRU, 2);
  totals.fetchRU = round(totals.fetchRU, 2);
  totals.totalRU = round(totals.totalRU, 2);
  totals.upsertWU = round(totals.upsertWU, 2);
  totals.storageGB = round(totals.storageGB, 4);
  totals.sourceReadCostUsd = round(totals.sourceReadCostUsd, 4);
  totals.targetWriteCostUsd = round(totals.targetWriteCostUsd, 4);
  totals.monthlyStorageCostUsd = round(totals.monthlyStorageCostUsd, 4);
  totals.totalUsd = round(totals.totalUsd, 4);
  return { perNamespace, totals };
}

export interface SyncMonthlyEstimateInput {
  /** Avg new IDs detected per poll pass across all selected namespaces. */
  avgInsertsPerPass: number;
  /** Avg deleted IDs detected per poll pass. */
  avgDeletesPerPass: number;
  /** Avg modify-in-place ops detected per pass when version-field mode is on. */
  avgUpdatesPerPass: number;
  pollIntervalMs: number;
  avgRecordKB: number;
  /** Total target storage in GB after migration. */
  storageGB: number;
}

export interface SyncMonthlyEstimate {
  passesPerMonth: number;
  monthlyInserts: number;
  monthlyDeletes: number;
  monthlyUpdates: number;
  monthlyRU: number;
  monthlyWU: number;
  monthlyOpsCostUsd: number;
  monthlyStorageCostUsd: number;
  monthlyTotalUsd: number;
}

/** Project monthly cost of an active sync job given observed change rates. */
export function estimateSyncMonthlyCost(
  input: SyncMonthlyEstimateInput,
  pricing: PricingConfig,
): SyncMonthlyEstimate {
  const HOURS_PER_MONTH = 730;
  const passesPerMonth = (HOURS_PER_MONTH * 3600 * 1000) / Math.max(1, input.pollIntervalMs);

  const monthlyInserts = input.avgInsertsPerPass * passesPerMonth;
  const monthlyDeletes = input.avgDeletesPerPass * passesPerMonth;
  const monthlyUpdates = input.avgUpdatesPerPass * passesPerMonth;

  // Each pass = 2 list scans (source + target). RU per scan = ceil(N/100). N varies, but
  // we approximate by assuming the active working-set from inserts dominates:
  const listRUPerPass = 2; // floor; the orchestrator overrides this with measured values when available
  const monthlyListRU = listRUPerPass * passesPerMonth;
  const monthlyFetchRU = (monthlyInserts + monthlyUpdates) * (pricing.operationCosts.fetchRUPer10Records / 10);
  const monthlyRU = monthlyListRU + monthlyFetchRU;

  const writesPerMonth = monthlyInserts + monthlyDeletes + monthlyUpdates;
  const monthlyWU = Math.max(
    writesPerMonth * input.avgRecordKB * pricing.operationCosts.upsertWUPerKB,
    Math.ceil(writesPerMonth / 1000) * pricing.operationCosts.upsertMinWUPerRequest,
  );

  const monthlyOpsCostUsd =
    monthlyRU * pricing.rates.readUnit + monthlyWU * pricing.rates.writeUnit;
  const monthlyStorageCostUsd = input.storageGB * pricing.rates.storageGBMonth;

  return {
    passesPerMonth: round(passesPerMonth, 2),
    monthlyInserts: round(monthlyInserts, 0),
    monthlyDeletes: round(monthlyDeletes, 0),
    monthlyUpdates: round(monthlyUpdates, 0),
    monthlyRU: round(monthlyRU, 2),
    monthlyWU: round(monthlyWU, 2),
    monthlyOpsCostUsd: round(monthlyOpsCostUsd, 4),
    monthlyStorageCostUsd: round(monthlyStorageCostUsd, 4),
    monthlyTotalUsd: round(monthlyOpsCostUsd + monthlyStorageCostUsd, 4),
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
