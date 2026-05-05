'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardTitle, Pill } from '@/components/ui';

export default function JobsPage() {
  const q = useQuery({ queryKey: ['jobs'], queryFn: api.listJobs, refetchInterval: 5000 });

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <Link href="/" className="text-sm text-primary underline">
          ← New job
        </Link>
      </header>

      <Card>
        <CardTitle>All jobs</CardTitle>
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Source → Target</th>
              <th className="px-3 py-2">Namespaces</th>
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.jobs ?? []).map((j) => (
              <tr key={j.id} className="border-t border-border/40">
                <td className="px-3 py-2 font-medium">
                  <Link href={`/jobs/${j.id}`} className="text-primary underline">
                    {j.name}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <Pill tone={j.kind === 'sync' ? 'info' : 'default'}>{j.kind}</Pill>
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={j.status} />
                  {j.dry_run && <Pill className="ml-2" tone="warning">dry run</Pill>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {j.source_index} → {j.target_index}
                </td>
                <td className="px-3 py-2">{j.namespaces.length}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {new Date(j.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {q.data?.jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No jobs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </main>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'completed'
      ? 'success'
      : status === 'failed'
        ? 'danger'
        : status === 'running' || status === 'preflight'
          ? 'info'
          : status === 'paused'
            ? 'warning'
            : 'default';
  return <Pill tone={tone}>{status}</Pill>;
}
