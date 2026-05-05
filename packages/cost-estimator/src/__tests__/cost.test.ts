import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { estimateNamespaceCost, rollupCopyJobCost, avgRecordBytes } from '../index.js';
import pricing from '../../../../config/pricing.json' with { type: 'json' };
import { pricingConfigSchema } from '@migrator/shared';

const cfg = pricingConfigSchema.parse(pricing);

test('avgRecordBytes uses dimension * 4 + metadata + id', () => {
  const bytes = avgRecordBytes({
    namespace: 'x',
    recordCount: 0,
    dimension: 768,
    avgIdBytes: 36,
    avgMetadataBytes: 500,
  });
  assert.equal(bytes, 36 + 500 + 768 * 4);
});

test('estimateNamespaceCost matches Pinecone-documented operation costs', () => {
  const r = estimateNamespaceCost(
    { namespace: 'n', recordCount: 1_000_000, dimension: 1536, avgMetadataBytes: 1000 },
    cfg,
    1000,
    1000,
  );
  // 1M IDs / 100 IDs per call = 10_000 list calls, 1 RU each
  assert.equal(r.listCalls, 10_000);
  assert.equal(r.listRU, 10_000);
  // 1M records, fetch in 1000-record batches => 1000 calls. RU = max(1M/10, 1000*1) = 100_000
  assert.equal(r.fetchCalls, 1000);
  assert.equal(r.fetchRU, 100_000);
  // Upsert: 1M * 7.16KB = ~7,160,000 WU, well above min floor
  assert.equal(r.upsertCalls, 1000);
  assert.ok(r.upsertWU > 7_000_000 && r.upsertWU < 7_200_000);
  assert.ok(r.totalUsd > 0);
});

test('rollupCopyJobCost sums per-namespace numbers correctly', () => {
  const out = rollupCopyJobCost(
    [
      { namespace: 'a', recordCount: 100_000, dimension: 768, avgMetadataBytes: 100 },
      { namespace: 'b', recordCount: 200_000, dimension: 768, avgMetadataBytes: 100 },
    ],
    cfg,
  );
  assert.equal(out.totals.recordCount, 300_000);
  assert.equal(out.perNamespace.length, 2);
  assert.ok(out.totals.totalUsd > 0);
});
