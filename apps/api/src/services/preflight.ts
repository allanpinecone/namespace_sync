import type { IndexInfo, NamespaceMapping } from '@migrator/shared';
import { getClient } from './connections.js';

export interface PreflightCheck {
  id: string;
  level: 'pass' | 'warn' | 'fail';
  message: string;
}

export interface PreflightResult {
  source: IndexInfo;
  target: IndexInfo;
  sourceStats: { dimension: number | null; totalRecordCount: number; namespaces: Record<string, number> };
  targetStats: { dimension: number | null; totalRecordCount: number; namespaces: Record<string, number> };
  totalRecordsToCopy: number;
  mappingPreview: Array<{ source: string; target: string; recordCount: number; targetExists: boolean }>;
  checks: PreflightCheck[];
  ok: boolean;
}

/**
 * Run pre-flight validation on a proposed copy/sync job:
 *   - source/target dimensions match
 *   - metric type matches
 *   - namespace quota headroom on the target index
 *   - integrated-embedding indexes are flagged (we cannot copy raw vectors into them)
 *   - selected namespaces actually exist
 *   - target namespace mapping does not produce duplicates
 */
export async function runPreflight(input: {
  sourceConnectionId: string;
  sourceIndex: string;
  targetConnectionId: string;
  targetIndex: string;
  namespaces: string[];
  mapping: NamespaceMapping;
}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const [srcClient, tgtClient] = await Promise.all([
    getClient(input.sourceConnectionId),
    getClient(input.targetConnectionId),
  ]);
  const [source, target] = await Promise.all([
    srcClient.describeIndex(input.sourceIndex),
    tgtClient.describeIndex(input.targetIndex),
  ]);
  const [sourceStats, targetStats] = await Promise.all([
    srcClient.describeIndexStats(input.sourceIndex),
    tgtClient.describeIndexStats(input.targetIndex),
  ]);

  // --- Dimensions ---
  if (source.dimension && target.dimension && source.dimension !== target.dimension) {
    checks.push({
      id: 'dimension-mismatch',
      level: 'fail',
      message: `Source dimension (${source.dimension}) does not match target dimension (${target.dimension}).`,
    });
  } else {
    checks.push({ id: 'dimension-match', level: 'pass', message: 'Dimensions match.' });
  }

  // --- Metric ---
  if (source.metric && target.metric && source.metric !== target.metric) {
    checks.push({
      id: 'metric-mismatch',
      level: 'warn',
      message: `Source metric (${source.metric}) differs from target metric (${target.metric}). Vector values copy fine but query semantics may change.`,
    });
  }

  // --- Vector type ---
  if (source.vectorType !== target.vectorType) {
    checks.push({
      id: 'vector-type-mismatch',
      level: 'fail',
      message: `Source vector type (${source.vectorType}) does not match target (${target.vectorType}).`,
    });
  }

  // --- Integrated embedding ---
  if (target.embeddingModel) {
    checks.push({
      id: 'integrated-embedding-target',
      level: 'fail',
      message: `Target index uses integrated embedding model "${target.embeddingModel}". Raw vector copy is not supported; use Pinecone bulk import or upsert text.`,
    });
  }

  // --- Spec ---
  if (source.spec !== 'serverless') {
    checks.push({
      id: 'pod-source',
      level: 'warn',
      message: 'Source is not a serverless index; list/list_namespaces operations may not be supported.',
    });
  }
  if (target.spec !== 'serverless') {
    checks.push({
      id: 'pod-target',
      level: 'warn',
      message: 'Target is not a serverless index; namespace creation behavior may differ.',
    });
  }

  // --- Build mapping preview & duplicate detection ---
  const targetNamespaces = new Set(Object.keys(targetStats.namespaces));
  const mapping = input.mapping;
  const targetCounts = new Map<string, number>();
  const mappingPreview = input.namespaces.map((ns) => {
    const target = applyMapping(ns, mapping);
    const count = sourceStats.namespaces[ns] ?? 0;
    targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
    return { source: ns, target, recordCount: count, targetExists: targetNamespaces.has(target) };
  });
  const duplicates = [...targetCounts.entries()].filter(([, n]) => n > 1).map(([t]) => t);
  if (duplicates.length > 0 && mapping.kind !== 'single') {
    checks.push({
      id: 'mapping-duplicate',
      level: 'fail',
      message: `Mapping produces duplicate target namespaces: ${duplicates.slice(0, 5).join(', ')}${
        duplicates.length > 5 ? '…' : ''
      }`,
    });
  }

  // --- Missing namespaces ---
  const sourceNs = new Set(Object.keys(sourceStats.namespaces));
  const missing = input.namespaces.filter((n) => !sourceNs.has(n));
  if (missing.length > 0) {
    checks.push({
      id: 'missing-namespaces',
      level: 'warn',
      message: `${missing.length} selected namespaces are not present in the source index right now.`,
    });
  }

  const totalRecordsToCopy = mappingPreview.reduce((s, m) => s + m.recordCount, 0);

  const ok = !checks.some((c) => c.level === 'fail');
  return {
    source,
    target,
    sourceStats,
    targetStats,
    totalRecordsToCopy,
    mappingPreview,
    checks,
    ok,
  };
}

/**
 * Apply a namespace mapping rule. Used both at preflight (preview) and at copy time.
 */
export function applyMapping(source: string, mapping: NamespaceMapping): string {
  switch (mapping.kind) {
    case 'same':
      return source;
    case 'prefix':
      return mapping.value + source;
    case 'suffix':
      return source + mapping.value;
    case 'single':
      return mapping.target;
    case 'regex': {
      try {
        return source.replace(new RegExp(mapping.pattern), mapping.replacement);
      } catch {
        return source;
      }
    }
  }
}
