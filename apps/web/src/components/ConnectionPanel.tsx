'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Connection } from '@/lib/api';
import { useMigratorStore } from '@/lib/store';
import { Button, Card, CardTitle, Field, Input, Pill } from './ui';
import type { IndexInfo } from '@migrator/shared';

export function ConnectionPanel() {
  const qc = useQueryClient();
  const connectionsQ = useQuery({ queryKey: ['connections'], queryFn: api.listConnections });
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('default');
  const [ephemeral, setEphemeral] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forgetInfo, setForgetInfo] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: (input: { apiKey: string; label: string; ephemeral: boolean }) => api.createConnection(input),
    onSuccess: () => {
      setApiKey('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const forgetMutation = useMutation({
    mutationFn: () => api.forgetEphemeral(),
    onSuccess: (data) => {
      setError(null);
      if (data.skippedInUse > 0) {
        setForgetInfo(
          `Removed ${data.removed} ephemeral key(s). ${data.skippedInUse} could not be removed because jobs still reference them — delete or finish those jobs first.`,
        );
      } else {
        setForgetInfo(data.removed > 0 ? `Removed ${data.removed} ephemeral key(s).` : null);
      }
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (err: Error) => {
      setForgetInfo(null);
      setError(err.message);
    },
  });

  return (
    <Card>
      <CardTitle>Pinecone connections</CardTitle>
      <div className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
        <Field label="API key" hint="Stored encrypted at rest. Never logged.">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="pcsk_..."
            autoComplete="off"
          />
        </Field>
        <Field label="Label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="prod" />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">&nbsp;</span>
          <Button
            disabled={!apiKey || addMutation.isPending}
            onClick={() => addMutation.mutate({ apiKey, label, ephemeral })}
          >
            {addMutation.isPending ? 'Validating…' : 'Add'}
          </Button>
        </div>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={ephemeral} onChange={(e) => setEphemeral(e.target.checked)} />
        Forget this key when the server restarts (recommended for shared environments).
      </label>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {forgetInfo && !error && <p className="mt-2 text-sm text-muted-foreground">{forgetInfo}</p>}

      <div className="mt-5 flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Saved connections</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={forgetMutation.isPending}
          onClick={() => forgetMutation.mutate()}
        >
          {forgetMutation.isPending ? 'Forgetting…' : 'Forget all ephemeral keys'}
        </Button>
      </div>
      <ul className="mt-2 space-y-2">
        {(connectionsQ.data?.connections ?? []).map((c) => (
          <ConnectionRow key={c.id} c={c} />
        ))}
        {connectionsQ.isSuccess && (connectionsQ.data.connections?.length ?? 0) === 0 && (
          <li className="text-sm text-muted-foreground">No connections yet.</li>
        )}
      </ul>
    </Card>
  );
}

function ConnectionRow({ c }: { c: Connection }) {
  const qc = useQueryClient();
  const [removeError, setRemoveError] = useState<string | null>(null);
  const indexesQ = useQuery({
    queryKey: ['indexes', c.id],
    queryFn: () => api.listIndexes(c.id),
  });
  const setSource = useMigratorStore((s) => s.setSource);
  const setTarget = useMigratorStore((s) => s.setTarget);
  const source = useMigratorStore((s) => s.source);
  const target = useMigratorStore((s) => s.target);

  const remove = useMutation({
    mutationFn: () => api.deleteConnection(c.id),
    onSuccess: () => {
      setRemoveError(null);
      useMigratorStore.setState((s) => ({
        source:
          s.source.connection?.id === c.id ? { connection: null, indexName: null } : s.source,
        target:
          s.target.connection?.id === c.id ? { connection: null, indexName: null } : s.target,
      }));
      void qc.invalidateQueries({ queryKey: ['connections'] });
      void qc.invalidateQueries({ queryKey: ['indexes'] });
    },
    onError: (err: Error) => setRemoveError(err.message),
  });

  return (
    <li className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">{c.label}</span>
          <Pill tone="info">{c.fingerprint.slice(0, 8)}…</Pill>
          {c.ephemeral && <Pill tone="warning">ephemeral</Pill>}
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? 'Removing…' : 'Remove'}
        </Button>
      </div>
      {removeError && <p className="mt-2 text-sm text-danger">{removeError}</p>}
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        {(indexesQ.data?.indexes ?? []).map((idx: IndexInfo) => {
          const isSource = source.connection?.id === c.id && source.indexName === idx.name;
          const isTarget = target.connection?.id === c.id && target.indexName === idx.name;
          return (
            <div
              key={idx.name}
              className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <div className="flex flex-col">
                <span className="font-medium">{idx.name}</span>
                <span className="text-xs text-muted-foreground">
                  {idx.dimension ? `${idx.dimension}d` : 'sparse'} · {idx.metric ?? '?'} ·{' '}
                  {idx.cloud ?? '?'}/{idx.region ?? '?'}
                </span>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={isSource ? 'success' : 'outline'}
                  onClick={() => setSource({ id: c.id, label: c.label }, idx.name)}
                >
                  Source
                </Button>
                <Button
                  size="sm"
                  variant={isTarget ? 'success' : 'outline'}
                  onClick={() => setTarget({ id: c.id, label: c.label }, idx.name)}
                >
                  Target
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </li>
  );
}
