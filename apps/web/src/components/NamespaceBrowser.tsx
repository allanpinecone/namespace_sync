'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Fuse from 'fuse.js';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import type { NamespaceInfo } from '@migrator/shared';
import { Button, Card, CardTitle, Input, Pill } from './ui';
import { useMigratorStore } from '@/lib/store';
import { api, apiBase } from '@/lib/api';

interface Props {
  /** When true, this is the source-side picker (the only one that selects namespaces to copy). */
  isSource?: boolean;
}

/**
 * Streams namespaces from the API via Server-Sent Events and renders them in a virtualized
 * list with fuzzy/partial search. Built for indexes with up to ~100k namespaces.
 *
 * The "select all matching" master checkbox toggles every namespace currently passing the
 * filter (not just the rendered window).
 */
export function NamespaceBrowser({ isSource = true }: Props) {
  const source = useMigratorStore((s) => s.source);
  const target = useMigratorStore((s) => s.target);
  const setSource = useMigratorStore((s) => s.setSource);
  const selected = useMigratorStore((s) => s.selected);
  const setSelected = useMigratorStore((s) => s.setSelected);
  const toggle = useMigratorStore((s) => s.toggleSelected);

  const conn = isSource ? source : target;
  const connectionsQ = useQuery({ queryKey: ['connections'], queryFn: api.listConnections });

  const [namespaces, setNamespaces] = useState<NamespaceInfo[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);

  // Reset state when the (connection, index) tuple changes.
  useEffect(() => {
    setNamespaces([]);
    setRefreshedAt(null);
    setError(null);
    setSelected([]);
  }, [conn.connection?.id, conn.indexName, setSelected]);

  // Persisted state can point to a connection that no longer exists (for example, ephemeral
  // keys are purged on API restart). Clear stale source selection so we don't stream against
  // an invalid connection and show a misleading error banner.
  useEffect(() => {
    if (!isSource) return;
    if (!conn.connection?.id) return;
    if (!connectionsQ.isSuccess) return;
    const exists = connectionsQ.data.connections.some((c) => c.id === conn.connection?.id);
    if (!exists) {
      setSource(null, null);
      setSelected([]);
      setError(null);
      setStreaming(false);
    }
  }, [
    isSource,
    conn.connection?.id,
    connectionsQ.isSuccess,
    connectionsQ.data,
    setSource,
    setSelected,
  ]);

  // Subscribe to the SSE stream of namespaces.
  useEffect(() => {
    if (!isSource) return;
    if (!conn.connection?.id || !conn.indexName) return;
    if (connectionsQ.isSuccess) {
      const exists = connectionsQ.data.connections.some((c) => c.id === conn.connection?.id);
      if (!exists) return;
    }
    const indexEncoded = encodeURIComponent(conn.indexName);
    const streamUrl = `${apiBase}/connections/${conn.connection.id}/indexes/${indexEncoded}/namespaces/stream`;
    const fetchUrl = `${apiBase}/connections/${conn.connection.id}/indexes/${indexEncoded}/namespaces`;
    const es = new EventSource(streamUrl);
    const hydrateFromFetch = async (): Promise<boolean> => {
      try {
        const res = await fetch(fetchUrl);
        if (!res.ok) return false;
        const data = (await res.json()) as {
          namespaces: NamespaceInfo[];
          refreshedAt: string;
        };
        setNamespaces(data.namespaces ?? []);
        setRefreshedAt(data.refreshedAt ?? new Date().toISOString());
        setError(null);
        setStreaming(false);
        return true;
      } catch {
        return false;
      }
    };
    let closedByClient = false;
    let sawComplete = false;
    const closeStream = (): void => {
      if (closedByClient) return;
      closedByClient = true;
      es.close();
    };
    setStreaming(true);
    es.addEventListener('namespaces', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { batch: NamespaceInfo[] };
      setNamespaces((prev) => [...prev, ...data.batch]);
      setError(null);
    });
    es.addEventListener('complete', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { total: number; refreshedAt: string };
      sawComplete = true;
      setRefreshedAt(data.refreshedAt);
      setError(null);
      setStreaming(false);
      closeStream();
    });
    es.addEventListener('error', async () => {
      // EventSource emits "error" when a stream is closed. Ignore if we already saw a
      // valid completion event or we closed the stream ourselves.
      if (sawComplete || closedByClient) return;
      // Fallback path: some proxies/browser implementations emit a generic SSE error
      // despite a healthy backend. Re-try with plain JSON fetch before surfacing an error.
      const recovered = await hydrateFromFetch();
      if (recovered) {
        closeStream();
        return;
      }
      setError('Failed to stream namespaces; check the API server logs.');
      setStreaming(false);
      closeStream();
    });
    return () => {
      closeStream();
      setStreaming(false);
    };
  }, [
    conn.connection?.id,
    conn.indexName,
    isSource,
    connectionsQ.isSuccess,
    connectionsQ.data,
  ]);

  // Build a Fuse index of names for fuzzy matching. Memoized so the index isn't rebuilt on
  // every keystroke. We rebuild when the namespaces array reference changes (after SSE batches).
  const fuse = useMemo(
    () =>
      new Fuse(namespaces, {
        keys: ['name'],
        threshold: 0.32,
        ignoreLocation: true,
        includeScore: false,
        minMatchCharLength: 1,
      }),
    [namespaces],
  );

  const filtered = useMemo(() => {
    let arr: NamespaceInfo[];
    if (!query) arr = namespaces;
    else arr = fuse.search(query).map((r) => r.item);
    if (hideEmpty) arr = arr.filter((n) => n.recordCount > 0);
    return arr;
  }, [query, namespaces, fuse, hideEmpty]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allFilteredSelected = filtered.length > 0 && filtered.every((n) => selectedSet.has(n.name));
  const someFilteredSelected = filtered.some((n) => selectedSet.has(n.name));

  const toggleAllMatching = (): void => {
    const filteredNames = new Set(filtered.map((n) => n.name));
    if (allFilteredSelected) {
      setSelected(selected.filter((n) => !filteredNames.has(n)));
    } else {
      const next = new Set(selected);
      for (const n of filteredNames) next.add(n);
      setSelected([...next]);
    }
  };

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 25,
  });

  if (!conn.connection?.id || !conn.indexName) {
    return (
      <Card>
        <CardTitle>Namespaces</CardTitle>
        <p className="text-sm text-muted-foreground">
          Select a {isSource ? 'source' : 'target'} index above to begin.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <CardTitle className="mb-1">Source namespaces</CardTitle>
          <p className="text-xs text-muted-foreground">
            {namespaces.length.toLocaleString()} total · {filtered.length.toLocaleString()} match · {selected.length.toLocaleString()} selected
            {refreshedAt && ` · refreshed ${new Date(refreshedAt).toLocaleTimeString()}`}
          </p>
        </div>
        {streaming && <Pill tone="info">streaming…</Pill>}
      </div>

      <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
        <Input
          placeholder="Search by name (substring + fuzzy)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button variant="outline" size="md" onClick={() => setHideEmpty((v) => !v)}>
          {hideEmpty ? 'Show empty' : 'Hide empty'}
        </Button>
        <Button variant="ghost" size="md" onClick={() => setSelected([])}>
          Clear selection
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-2">
        <input
          type="checkbox"
          checked={allFilteredSelected}
          ref={(el) => {
            if (el) el.indeterminate = !allFilteredSelected && someFilteredSelected;
          }}
          onChange={toggleAllMatching}
          aria-label="Select all matching namespaces"
        />
        <span className="text-sm">
          Select all matching ({filtered.length.toLocaleString()})
        </span>
      </div>

      <div
        ref={parentRef}
        className="mt-2 h-[420px] overflow-auto rounded-lg border border-border"
        style={{ contain: 'strict' }}
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const ns = filtered[vi.index]!;
            const isSelected = selectedSet.has(ns.name);
            return (
              <label
                key={ns.name}
                className={
                  'absolute inset-x-0 flex items-center gap-3 border-b border-border/40 px-3 text-sm hover:bg-muted/40 ' +
                  (isSelected ? 'bg-primary/10' : '')
                }
                style={{ transform: `translateY(${vi.start}px)`, height: `${vi.size}px` }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(ns.name)}
                />
                <span className="flex-1 truncate font-mono">{ns.name || '(default)'}</span>
                <span className="text-xs text-muted-foreground">
                  {ns.recordCount.toLocaleString()} records
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
