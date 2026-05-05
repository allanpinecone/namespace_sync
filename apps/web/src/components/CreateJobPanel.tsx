'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useMigratorStore } from '@/lib/store';
import { Button, Card, CardTitle, Field, Input, Pill } from './ui';
import type { NamespaceMapping } from '@migrator/shared';

type Mode = 'copy' | 'sync';
type MappingKind = NamespaceMapping['kind'];
type SkipExistingMode = 'never' | 'id' | 'hash';

export function CreateJobPanel() {
  const router = useRouter();
  const source = useMigratorStore((s) => s.source);
  const target = useMigratorStore((s) => s.target);
  const selected = useMigratorStore((s) => s.selected);

  const [mode, setMode] = useState<Mode>('copy');
  const [name, setName] = useState('migration-' + new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-'));
  const [mappingKind, setMappingKind] = useState<MappingKind>('same');
  const [mappingValue, setMappingValue] = useState('');
  const [mappingPattern, setMappingPattern] = useState('^');
  const [mappingReplacement, setMappingReplacement] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [skipExisting, setSkipExisting] = useState<SkipExistingMode>('never');
  const [pollIntervalSec, setPollIntervalSec] = useState(30);
  const [versionFieldEnabled, setVersionFieldEnabled] = useState(false);
  const [versionField, setVersionField] = useState('_v');
  const [tombstonePct, setTombstonePct] = useState(10);

  const buildMapping = (): NamespaceMapping => {
    switch (mappingKind) {
      case 'same':
        return { kind: 'same' };
      case 'prefix':
        return { kind: 'prefix', value: mappingValue };
      case 'suffix':
        return { kind: 'suffix', value: mappingValue };
      case 'single':
        return { kind: 'single', target: mappingValue || 'merged' };
      case 'regex':
        return { kind: 'regex', pattern: mappingPattern, replacement: mappingReplacement };
    }
  };

  const preflight = useMutation({
    mutationFn: () =>
      api.preflight({
        sourceConnectionId: source.connection!.id,
        sourceIndex: source.indexName!,
        targetConnectionId: target.connection!.id,
        targetIndex: target.indexName!,
        namespaces: selected,
        mapping: buildMapping(),
      }),
  });

  const create = useMutation({
    mutationFn: async () => {
      const baseInput = {
        name,
        sourceConnectionId: source.connection!.id,
        sourceIndex: source.indexName!,
        targetConnectionId: target.connection!.id,
        targetIndex: target.indexName!,
        namespaces: selected,
        mapping: buildMapping(),
        concurrency: {
          maxNamespacesInFlight: 8,
          maxRequestsPerNamespace: 8,
          upsertBatchSize: 1000,
          fetchBatchSize: 1000,
          listPageSize: 100,
        },
        copyOptions: { skipExisting },
        dryRun,
      };
      if (mode === 'copy') return api.createCopyJob(baseInput);
      return api.createSyncJob({
        ...baseInput,
        pollIntervalMs: pollIntervalSec * 1000,
        tombstoneGuard: { maxDeletePctPerPass: tombstonePct / 100 },
        versionField: { enabled: versionFieldEnabled, field: versionField, samplePerPass: 2000 },
      });
    },
    onSuccess: ({ job }) => router.push(`/jobs/${job.id}`),
  });

  const ready =
    !!source.connection?.id &&
    !!target.connection?.id &&
    !!source.indexName &&
    !!target.indexName &&
    selected.length > 0;

  return (
    <Card>
      <CardTitle>Create migration job</CardTitle>

      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <Field label="Job name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex items-end gap-2">
          <Button variant={mode === 'copy' ? 'primary' : 'outline'} onClick={() => setMode('copy')}>
            One-time copy
          </Button>
          <Button variant={mode === 'sync' ? 'primary' : 'outline'} onClick={() => setMode('sync')}>
            Zero-downtime sync
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="Target namespace mapping">
          <div className="flex gap-2">
            <select
              className="h-10 rounded-md border border-border bg-card px-2 text-sm"
              value={mappingKind}
              onChange={(e) => setMappingKind(e.target.value as MappingKind)}
            >
              <option value="same">same name</option>
              <option value="prefix">prefix</option>
              <option value="suffix">suffix</option>
              <option value="single">all → one namespace</option>
              <option value="regex">regex replace</option>
            </select>
            {mappingKind === 'prefix' || mappingKind === 'suffix' || mappingKind === 'single' ? (
              <Input
                value={mappingValue}
                onChange={(e) => setMappingValue(e.target.value)}
                placeholder={mappingKind === 'single' ? 'merged' : mappingKind}
              />
            ) : null}
          </div>
          {mappingKind === 'regex' && (
            <div className="mt-2 flex gap-2">
              <Input
                placeholder="pattern"
                value={mappingPattern}
                onChange={(e) => setMappingPattern(e.target.value)}
              />
              <Input
                placeholder="replacement"
                value={mappingReplacement}
                onChange={(e) => setMappingReplacement(e.target.value)}
              />
            </div>
          )}
        </Field>

        <Field label="Options">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            Dry run (skip target writes; just verify the read pipeline)
          </label>
          <div className="mt-3 flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Skip already-present records
            </span>
            <select
              className="h-10 rounded-md border border-border bg-card px-2 text-sm"
              value={skipExisting}
              onChange={(e) => setSkipExisting(e.target.value as SkipExistingMode)}
            >
              <option value="never">Never — always upsert (default)</option>
              <option value="id">Skip if ID already exists in target (cheapest)</option>
              <option value="hash">Skip if same content (values + metadata match)</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {skipExisting === 'never' &&
                'Every batch is upserted, even if identical to the target. Use when you want to overwrite.'}
              {skipExisting === 'id' &&
                'Costs one extra fetch on the target per batch but skips both the source fetch and upsert WU for IDs that already exist. Best for resuming after a crash or cancel.'}
              {skipExisting === 'hash' &&
                'Costs one extra fetch on each side per batch but only upserts when values or metadata differ. Safest mode for re-running migrations.'}
            </p>
          </div>
        </Field>
      </div>

      {mode === 'sync' && (
        <div className="mt-4 grid gap-3 rounded-lg border border-border bg-muted/30 p-3 md:grid-cols-3">
          <Field label="Poll interval (sec)">
            <Input
              type="number"
              min={5}
              max={3600}
              value={pollIntervalSec}
              onChange={(e) => setPollIntervalSec(Math.max(5, Number(e.target.value)))}
            />
          </Field>
          <Field
            label="Tombstone guard %"
            hint="Pause for confirm if more than this % of target IDs vanish in one pass"
          >
            <Input
              type="number"
              min={1}
              max={100}
              value={tombstonePct}
              onChange={(e) => setTombstonePct(Math.max(1, Number(e.target.value)))}
            />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Version field (optional)
            </span>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={versionFieldEnabled}
                onChange={(e) => setVersionFieldEnabled(e.target.checked)}
              />
              Detect in-place updates by metadata field
            </label>
            {versionFieldEnabled && (
              <Input
                value={versionField}
                onChange={(e) => setVersionField(e.target.value)}
                placeholder="_v or updated_at"
              />
            )}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button disabled={!ready || preflight.isPending} variant="outline" onClick={() => preflight.mutate()}>
          {preflight.isPending ? 'Running pre-flight…' : 'Run pre-flight'}
        </Button>
        <Button
          disabled={!ready || (preflight.data && !preflight.data.ok) || create.isPending}
          variant="primary"
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Starting…' : `Start ${mode === 'copy' ? 'copy' : 'sync'} job`}
        </Button>
        <span className="text-xs text-muted-foreground">
          {selected.length.toLocaleString()} namespaces selected
        </span>
      </div>

      {preflight.data && (
        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-medium">Pre-flight checks</h3>
          {preflight.data.checks.map((c) => (
            <div key={c.id} className="flex items-start gap-2 text-sm">
              <Pill
                tone={c.level === 'fail' ? 'danger' : c.level === 'warn' ? 'warning' : 'success'}
              >
                {c.level}
              </Pill>
              <span className="text-muted-foreground">{c.message}</span>
            </div>
          ))}
          {preflight.data.mappingPreview.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Mapping preview ({preflight.data.mappingPreview.length} namespaces)
              </summary>
              <div className="mt-2 max-h-60 overflow-auto rounded-md border border-border">
                <table className="min-w-full text-xs">
                  <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1">Source</th>
                      <th className="px-2 py-1">→ Target</th>
                      <th className="px-2 py-1 text-right">Records</th>
                      <th className="px-2 py-1">Existed?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preflight.data.mappingPreview.slice(0, 200).map((m) => (
                      <tr key={m.source} className="border-t border-border/40">
                        <td className="px-2 py-1 font-mono">{m.source || '(default)'}</td>
                        <td className="px-2 py-1 font-mono">{m.target || '(default)'}</td>
                        <td className="px-2 py-1 text-right">{m.recordCount.toLocaleString()}</td>
                        <td className="px-2 py-1">
                          {m.targetExists ? (
                            <Pill tone="warning">existed</Pill>
                          ) : (
                            <Pill tone="success">new</Pill>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}
