'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { api, type NamespaceCostRow, type TotalsRow } from '@/lib/api';
import { useMigratorStore } from '@/lib/store';
import { Button, Card, CardTitle, Pill } from './ui';

type SortKey = 'namespace' | 'recordCount' | 'totalRU' | 'totalWU' | 'totalUsd';

export function CostEstimatePanel() {
  const source = useMigratorStore((s) => s.source);
  const selected = useMigratorStore((s) => s.selected);
  const pricingQ = useQuery({ queryKey: ['pricing'], queryFn: api.getPricing });

  const [sortKey, setSortKey] = useState<SortKey>('totalUsd');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [sample, setSample] = useState(true);

  const estimate = useMutation({
    mutationFn: () =>
      api.estimateCopyCost({
        connectionId: source.connection!.id,
        indexName: source.indexName!,
        namespaces: selected,
        sample,
      }),
  });

  const rows = useMemo(() => {
    const data = estimate.data?.breakdown.perNamespace ?? [];
    const sorted = [...data].sort((a, b) => {
      const ax = a[sortKey];
      const bx = b[sortKey];
      const cmp = typeof ax === 'number' && typeof bx === 'number' ? ax - bx : String(ax).localeCompare(String(bx));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted as NamespaceCostRow[];
  }, [estimate.data, sortKey, sortDir]);

  const totals = estimate.data?.breakdown.totals as TotalsRow | undefined;

  const sortBy = (k: SortKey) => () => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir('desc');
    }
  };

  const canEstimate = !!source.connection?.id && !!source.indexName && selected.length > 0;

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <CardTitle className="mb-1">Cost preview</CardTitle>
          <p className="text-xs text-muted-foreground">
            Pinecone rates as of {pricingQ.data?.asOf ?? '—'}.
            {estimate.data && ` Sampled ${estimate.data.sampledRecords.toLocaleString()} records for size estimate.`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} />
            Sample for accuracy
          </label>
          <Button disabled={!canEstimate || estimate.isPending} onClick={() => estimate.mutate()}>
            {estimate.isPending ? 'Estimating…' : 'Estimate cost'}
          </Button>
        </div>
      </div>

      {estimate.isError && (
        <p className="text-sm text-danger">{(estimate.error as Error).message}</p>
      )}

      {totals && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Records" value={totals.recordCount.toLocaleString()} />
          <Stat label="Read units" value={totals.totalRU.toLocaleString()} />
          <Stat label="Write units" value={totals.upsertWU.toLocaleString()} />
          <Stat label="Migration $" value={`$${totals.totalUsd.toFixed(4)}`} highlight />
          <Stat label="Storage / mo" value={`$${totals.monthlyStorageCostUsd.toFixed(4)}`} />
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <Th onClick={sortBy('namespace')} active={sortKey === 'namespace'} dir={sortDir}>
                  Namespace
                </Th>
                <Th onClick={sortBy('recordCount')} active={sortKey === 'recordCount'} dir={sortDir}>
                  Records
                </Th>
                <Th onClick={sortBy('totalRU')} active={sortKey === 'totalRU'} dir={sortDir}>
                  RU
                </Th>
                <Th onClick={sortBy('totalWU')} active={sortKey === 'totalWU'} dir={sortDir}>
                  WU
                </Th>
                <Th onClick={sortBy('totalUsd')} active={sortKey === 'totalUsd'} dir={sortDir}>
                  $
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r) => (
                <tr key={r.namespace} className="border-t border-border/40">
                  <td className="px-3 py-1.5 font-mono">{r.namespace || '(default)'}</td>
                  <td className="px-3 py-1.5 text-right">{r.recordCount.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right">{r.totalRU.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right">{r.totalWU.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right">${r.totalUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 200 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Showing first 200 namespaces of {rows.length.toLocaleString()}.
            </p>
          )}
        </div>
      )}

      {!totals && !estimate.isPending && (
        <p className="text-sm text-muted-foreground">
          Select a source index, pick namespaces, then click <Pill tone="info">Estimate cost</Pill>.
        </p>
      )}
    </Card>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className={
        'rounded-lg border border-border bg-muted/30 p-3 ' + (highlight ? 'ring-1 ring-primary' : '')
      }
    >
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  dir,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: 'asc' | 'desc';
}) {
  return (
    <th className="cursor-pointer px-3 py-2 text-right first:text-left" onClick={onClick}>
      {children}
      {active && <span className="ml-1">{dir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );
}
