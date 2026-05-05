import type { AppInstance } from '../types-fastify.js';
import { z } from 'zod';
import {
  estimateSyncMonthlyCost,
  rollupCopyJobCost,
  type NamespaceCostInput,
} from '@migrator/cost-estimator';
import { pricingConfigSchema } from '@migrator/shared';
import { loadPricing } from '../config.js';
import { getClient } from '../services/connections.js';
import { getNamespaces } from '../services/namespaces.js';

const sampleSchema = z.object({
  connectionId: z.string().uuid(),
  indexName: z.string(),
  namespaces: z.array(z.string()).min(1),
  pricingOverride: pricingConfigSchema.optional(),
  /** Whether to sample a few records per namespace for a more accurate avg metadata size. */
  sample: z.boolean().default(true),
  sampleSizePerNamespace: z.number().int().min(1).max(1000).default(50),
  /** Manual avg metadata size in bytes (used when sample=false). */
  avgMetadataBytes: z.number().int().nonnegative().optional(),
});

const syncProjectionSchema = z.object({
  pollIntervalMs: z.number().int().min(5_000).default(30_000),
  avgInsertsPerPass: z.number().nonnegative().default(0),
  avgDeletesPerPass: z.number().nonnegative().default(0),
  avgUpdatesPerPass: z.number().nonnegative().default(0),
  avgRecordKB: z.number().nonnegative().default(3.5),
  storageGB: z.number().nonnegative().default(0),
  pricingOverride: pricingConfigSchema.optional(),
});

export async function registerCostRoutes(app: AppInstance): Promise<void> {
  app.get('/pricing', async () => loadPricing());

  app.post('/cost/estimate-copy', async (req, reply) => {
    const parsed = sampleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { connectionId, indexName, namespaces, sample, sampleSizePerNamespace, avgMetadataBytes } =
      parsed.data;
    const pricing = parsed.data.pricingOverride ?? loadPricing();

    const client = await getClient(connectionId);
    const indexInfo = await client.describeIndex(indexName);
    const dimension = indexInfo.dimension ?? 0;
    const { namespaces: allNs } = await getNamespaces(connectionId, indexName);
    const counts = new Map(allNs.map((n) => [n.name, n.recordCount]));

    const inputs: NamespaceCostInput[] = [];
    let sampledRecords = 0;
    for (const ns of namespaces) {
      const recordCount = counts.get(ns) ?? 0;
      let avgMeta: number | undefined = avgMetadataBytes;
      if (sample && recordCount > 0) {
        const sampleSize = Math.min(sampleSizePerNamespace, recordCount, 100);
        // List a single page to grab some IDs, then fetch them to measure avg size.
        const ids: string[] = [];
        for await (const page of client.listIds(indexName, ns, { pageSize: sampleSize })) {
          ids.push(...page.ids);
          if (ids.length >= sampleSize) break;
        }
        if (ids.length > 0) {
          const fetched = await client.fetch(indexName, ns, ids.slice(0, sampleSize));
          if (fetched.records.length > 0) {
            const totalMeta = fetched.records.reduce((s, r) => s + estimateMetadataBytes(r.metadata), 0);
            avgMeta = Math.max(50, Math.round(totalMeta / fetched.records.length));
            sampledRecords += fetched.records.length;
          }
        }
      }
      inputs.push({
        namespace: ns,
        recordCount,
        dimension,
        avgMetadataBytes: avgMeta,
      });
    }
    const breakdown = rollupCopyJobCost(inputs, pricing);
    return { breakdown, sampledRecords, pricingAsOf: pricing.asOf };
  });

  app.post('/cost/estimate-sync', async (req, reply) => {
    const parsed = syncProjectionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const pricing = parsed.data.pricingOverride ?? loadPricing();
    const projection = estimateSyncMonthlyCost(parsed.data, pricing);
    return { projection, pricingAsOf: pricing.asOf };
  });
}

function estimateMetadataBytes(meta: Record<string, unknown> | undefined): number {
  if (!meta) return 0;
  return Buffer.byteLength(JSON.stringify(meta), 'utf8');
}
