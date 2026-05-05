'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiBase, type JobDetailPayload, type NamespaceProgressRow } from '@/lib/api';
import { mergeJobDetailFromProgressEvent } from '@/lib/job-progress-merge';
import { Button, Card, CardTitle, Pill } from '@/components/ui';

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const job = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.getJob(id),
    staleTime: 0,
    gcTime: 5 * 60_000,
    refetchInterval: (q) =>
      q.state.data?.job.status === 'completed' || q.state.data?.job.status === 'failed' ? false : 1500,
  });
  const audit = useQuery({ queryKey: ['audit', id], queryFn: () => api.audit(id), refetchInterval: 5000 });
  const [liveMessages, setLiveMessages] = useState<string[]>([]);

  // Subscribe to SSE for live updates. Merge each event into the query cache so counters move
  // immediately (invalidate + default staleTime caused sluggish or racing refetches).
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`${apiBase}/jobs/${id}/events`);
    es.addEventListener('snapshot', (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as JobDetailPayload;
        qc.setQueryData(['job', id], d);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('update', (e) => {
      try {
        const evt = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
        if (typeof evt.message === 'string' && evt.message) {
          setLiveMessages((m) => [evt.message as string, ...m].slice(0, 20));
        }
        qc.setQueryData(['job', id], (prev) => {
          if (!prev) return prev;
          return mergeJobDetailFromProgressEvent(prev as JobDetailPayload, evt);
        });
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      void qc.refetchQueries({ queryKey: ['job', id], type: 'active' });
    };
    return () => es.close();
  }, [id, qc]);

  const cancel = useMutation({ mutationFn: () => api.cancelJob(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['job', id] }) });
  const pause = useMutation({ mutationFn: () => api.pauseJob(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['job', id] }) });
  const resume = useMutation({ mutationFn: () => api.resumeJob(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['job', id] }) });
  const promote = useMutation({ mutationFn: () => api.promoteJob(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['job', id] }) });
  const verify = useMutation({ mutationFn: () => api.verifyJob(id) });
  const confirmDeletes = useMutation({ mutationFn: () => api.confirmDeletes(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['job', id] }) });

  const totals = useMemo(() => {
    const rows = (job.data?.progress ?? []) as NamespaceProgressRow[];
    return rows.reduce(
      (acc, r) => {
        acc.total += Number(r.total_records ?? 0);
        acc.processed += Number(r.processed_records ?? 0);
        acc.copied += Number(r.copied_records ?? 0);
        acc.skipped += Number(r.skipped_records ?? 0);
        acc.failed += Number(r.failed_records ?? 0);
        acc.ru += Number(r.ru_consumed ?? 0);
        acc.wu += Number(r.wu_consumed ?? 0);
        return acc;
      },
      { total: 0, processed: 0, copied: 0, skipped: 0, failed: 0, ru: 0, wu: 0 },
    );
  }, [job.data]);

  if (job.isLoading) return <main className="p-6">Loading…</main>;
  if (!job.data) return <main className="p-6">Not found.</main>;

  const j = job.data.job;
  const sync = job.data.syncState;
  const isSync = j.kind === 'sync';
  const lagSec = sync?.last_poll_at
    ? Math.round((Date.now() - new Date(sync.last_poll_at).getTime()) / 1000)
    : null;

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <Link href="/jobs" className="text-xs text-primary underline">
            ← back to jobs
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{j.name}</h1>
          <p className="text-sm text-muted-foreground">
            <Pill tone={j.kind === 'sync' ? 'info' : 'default'}>{j.kind}</Pill>{' '}
            <Pill
              tone={
                j.status === 'completed'
                  ? 'success'
                  : j.status === 'failed'
                    ? 'danger'
                    : j.status === 'running'
                      ? 'info'
                      : j.status === 'paused'
                        ? 'warning'
                        : 'default'
              }
            >
              {j.status}
            </Pill>{' '}
            <span className="font-mono text-xs">{j.source_index} → {j.target_index}</span>
          </p>
        </div>
        <div className="flex gap-2">
          {isSync && j.status !== 'completed' && j.status !== 'failed' && (
            <>
              <Button size="sm" variant="outline" onClick={() => pause.mutate()}>
                Pause
              </Button>
              <Button size="sm" variant="outline" onClick={() => resume.mutate()}>
                Resume
              </Button>
              <Button size="sm" variant="success" onClick={() => promote.mutate()}>
                Promote target (cutover)
              </Button>
            </>
          )}
          {!isSync && j.status === 'completed' && (
            <Button size="sm" variant="success" onClick={() => verify.mutate()}>
              Verify
            </Button>
          )}
          {j.status !== 'completed' && j.status !== 'failed' && (
            <Button size="sm" variant="danger" onClick={() => cancel.mutate()}>
              Cancel
            </Button>
          )}
        </div>
      </header>

      <div className={`grid gap-3 ${totals.skipped > 0 ? 'md:grid-cols-7' : 'md:grid-cols-6'}`}>
        <Stat label="Total" value={totals.total.toLocaleString()} />
        <Stat label="Processed" value={totals.processed.toLocaleString()} />
        <Stat label="Copied" value={totals.copied.toLocaleString()} />
        {totals.skipped > 0 && (
          <Stat label="Skipped" value={totals.skipped.toLocaleString()} hint="Already in target" />
        )}
        <Stat label="Failed" value={totals.failed.toLocaleString()} tone={totals.failed > 0 ? 'danger' : undefined} />
        <Stat label="RU consumed" value={totals.ru.toLocaleString()} />
        <Stat label="WU consumed (est)" value={totals.wu.toLocaleString()} />
      </div>
      {isSync && (
        <p className="text-xs text-muted-foreground">
          These totals sum the <strong>bootstrap copy</strong> only (per-namespace rows above). Ongoing
          replication is counted under <strong>Sync status</strong> (inserts, updates, deletes).
        </p>
      )}

      {isSync && sync && (
        <Card>
          <CardTitle>Sync status</CardTitle>
          <div className="grid gap-3 md:grid-cols-5">
            <Stat label="Poll passes" value={sync.poll_passes.toLocaleString()} />
            <Stat label="Inserts applied" value={sync.inserts_applied.toLocaleString()} />
            <Stat label="Deletes applied" value={sync.deletes_applied.toLocaleString()} />
            <Stat label="Updates applied" value={sync.updates_applied.toLocaleString()} />
            <Stat
              label="Lag (sec)"
              value={lagSec === null ? '—' : String(lagSec)}
              tone={lagSec !== null && lagSec > 120 ? 'warning' : undefined}
            />
          </div>
          {sync.awaiting_delete_confirmation && (
            <div className="mt-4 rounded-md border border-warning bg-warning/10 p-3 text-sm">
              <strong>Tombstone guard tripped.</strong> {sync.pending_delete_count.toLocaleString()} pending deletes
              detected — review and confirm to proceed.
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="warning" onClick={() => confirmDeletes.mutate()}>
                  Confirm and apply deletes
                </Button>
              </div>
            </div>
          )}
          {sync.cutover_at && (
            <p className="mt-3 text-sm text-success">
              Cutover completed at {new Date(sync.cutover_at).toLocaleString()}.
            </p>
          )}
        </Card>
      )}

      <Card>
        <CardTitle>Per-namespace progress</CardTitle>
        <div className="max-h-[400px] overflow-auto rounded-md border border-border">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Namespace</th>
                <th className="px-3 py-2">→ Target</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Processed</th>
                <th className="px-3 py-2 text-right">Copied</th>
                {totals.skipped > 0 && <th className="px-3 py-2 text-right">Skipped</th>}
                <th className="px-3 py-2 text-right">RU</th>
              </tr>
            </thead>
            <tbody>
              {(job.data.progress as NamespaceProgressRow[]).map((p) => (
                <tr key={p.namespace} className="border-t border-border/40">
                  <td className="px-3 py-1.5 font-mono">{p.namespace || '(default)'}</td>
                  <td className="px-3 py-1.5 font-mono">{p.target_namespace || '(default)'}</td>
                  <td className="px-3 py-1.5">
                    <Pill
                      tone={
                        p.status === 'completed'
                          ? 'success'
                          : p.status === 'failed'
                            ? 'danger'
                            : p.status === 'running'
                              ? 'info'
                              : 'default'
                      }
                    >
                      {p.status}
                    </Pill>
                  </td>
                  <td className="px-3 py-1.5 text-right">{Number(p.total_records).toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right">{Number(p.processed_records).toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right">{Number(p.copied_records).toLocaleString()}</td>
                  {totals.skipped > 0 && (
                    <td className="px-3 py-1.5 text-right">{Number(p.skipped_records ?? 0).toLocaleString()}</td>
                  )}
                  <td className="px-3 py-1.5 text-right">{Number(p.ru_consumed).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(job.data.progress as NamespaceProgressRow[]).some((p) => p.error_message) && (
          <div className="mt-3 space-y-1 rounded-md border border-danger/40 bg-danger/5 p-3 text-xs">
            <div className="font-medium text-danger">First error per namespace</div>
            {(job.data.progress as NamespaceProgressRow[])
              .filter((p) => p.error_message)
              .map((p) => (
                <div key={p.namespace} className="font-mono">
                  <span className="text-muted-foreground">{p.namespace || '(default)'}:</span>{' '}
                  {p.error_message}
                </div>
              ))}
          </div>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardTitle>Live events</CardTitle>
          <ul className="space-y-1 text-xs">
            {liveMessages.length === 0 && <li className="text-muted-foreground">Waiting for events…</li>}
            {liveMessages.map((m, i) => (
              <li key={i} className="font-mono">{m}</li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardTitle>Audit log</CardTitle>
          <ul className="space-y-1 text-xs">
            {(audit.data?.audit ?? []).map((a) => (
              <li key={a.id} className="border-b border-border/30 pb-1">
                <span className="text-muted-foreground">
                  {new Date(a.created_at).toLocaleTimeString()} ·{' '}
                </span>
                <span className="font-medium">{a.event_type}</span>
                {a.message && <span> — {a.message}</span>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'danger' | 'warning';
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={
          'text-lg font-semibold ' +
          (tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : '')
        }
      >
        {value}
      </div>
      {hint ? <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
