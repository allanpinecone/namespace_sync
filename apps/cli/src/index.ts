#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';

const program = new Command();
program
  .name('pinecone-migrator')
  .description('Talk to a running Pinecone Migrator API server')
  .version('0.1.0')
  .option('-a, --api <url>', 'API base URL', process.env.MIGRATOR_API ?? 'http://localhost:4000');

const api = (): string => (program.opts().api as string).replace(/\/$/, '');

function hasJsonRequestBody(init?: RequestInit): boolean {
  const b = init?.body;
  if (b == null || b === '') return false;
  return typeof b === 'string' && b.length > 0;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (
    hasJsonRequestBody(init) &&
    !headers['Content-Type'] &&
    !headers['content-type']
  ) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${api()}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: string };
      if (typeof parsed?.message === 'string' && parsed.message.trim()) detail = parsed.message;
      else if (typeof parsed?.error === 'string') detail = parsed.error;
    } catch {
      /* keep raw */
    }
    throw new Error(`API ${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

program
  .command('connections')
  .description('List Pinecone connections registered on the server')
  .action(async () => {
    const r = await call<{ connections: Array<{ id: string; label: string; fingerprint: string; ephemeral: boolean }> }>(
      '/connections',
    );
    for (const c of r.connections) {
      console.log(`${c.id}  ${c.label.padEnd(20)} ${c.ephemeral ? '[ephemeral]' : ''} ${c.fingerprint.slice(0, 12)}…`);
    }
  });

program
  .command('connect')
  .description('Add a new Pinecone connection')
  .requiredOption('-k, --api-key <key>', 'Pinecone API key (env: PINECONE_API_KEY)')
  .option('-l, --label <label>', 'Friendly label', 'default')
  .option('--persistent', 'Persist the key across server restarts (default ephemeral)', false)
  .action(async (opts) => {
    const apiKey = opts.apiKey || process.env.PINECONE_API_KEY;
    if (!apiKey) throw new Error('--api-key or PINECONE_API_KEY is required');
    const r = await call<{ connection: { id: string }; indexes: Array<{ name: string }> }>('/connections', {
      method: 'POST',
      body: JSON.stringify({ apiKey, label: opts.label, ephemeral: !opts.persistent }),
    });
    console.log(`connection: ${r.connection.id}`);
    console.log(`indexes: ${r.indexes.map((i) => i.name).join(', ')}`);
  });

program
  .command('namespaces')
  .description('List namespaces in an index')
  .requiredOption('-c, --connection <id>', 'Connection ID')
  .requiredOption('-i, --index <name>', 'Index name')
  .action(async (opts) => {
    const r = await call<{ namespaces: Array<{ name: string; recordCount: number }> }>(
      `/connections/${opts.connection}/indexes/${encodeURIComponent(opts.index)}/namespaces`,
    );
    for (const n of r.namespaces) {
      console.log(`${(n.name || '(default)').padEnd(40)} ${n.recordCount.toLocaleString()} records`);
    }
  });

program
  .command('cost')
  .description('Estimate the cost of copying a set of namespaces')
  .requiredOption('-c, --connection <id>', 'Source connection ID')
  .requiredOption('-i, --index <name>', 'Source index name')
  .requiredOption('-n, --namespaces <list>', 'Comma-separated namespaces (or @file)')
  .option('--no-sample', 'Disable sampling (faster but less accurate)')
  .action(async (opts) => {
    const namespaces = await loadList(opts.namespaces);
    const r = await call<{
      breakdown: { totals: { totalRU: number; upsertWU: number; totalUsd: number; recordCount: number } };
      sampledRecords: number;
      pricingAsOf: string;
    }>('/cost/estimate-copy', {
      method: 'POST',
      body: JSON.stringify({
        connectionId: opts.connection,
        indexName: opts.index,
        namespaces,
        sample: opts.sample !== false,
      }),
    });
    const t = r.breakdown.totals;
    console.log(`Pricing as of: ${r.pricingAsOf}`);
    console.log(`Records: ${t.recordCount.toLocaleString()}`);
    console.log(`Read units: ${t.totalRU.toLocaleString()}`);
    console.log(`Write units: ${t.upsertWU.toLocaleString()}`);
    console.log(`Estimated cost: $${t.totalUsd.toFixed(4)}`);
  });

program
  .command('copy')
  .description('Start a one-time copy job')
  .requiredOption('--source-connection <id>')
  .requiredOption('--source-index <name>')
  .requiredOption('--target-connection <id>')
  .requiredOption('--target-index <name>')
  .requiredOption('-n, --namespaces <list>', 'Comma-separated or @file')
  .option('--name <name>', 'Job name')
  .option('--mapping <kind>', 'Mapping kind: same|prefix|suffix|single|regex', 'same')
  .option('--mapping-value <value>', 'Value for prefix/suffix/single mapping')
  .option('--regex-pattern <pattern>')
  .option('--regex-replacement <replacement>')
  .option('--dry-run', 'Run the read pipeline but skip target writes', false)
  .option(
    '--skip-existing <mode>',
    'Skip records already in target: never|id|hash (default: never)',
    'never',
  )
  .action(async (opts) => {
    const namespaces = await loadList(opts.namespaces);
    const mapping = buildMapping(opts);
    const skipExisting = parseSkipMode(opts.skipExisting);
    const r = await call<{ job: { id: string } }>('/jobs/copy', {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name ?? `cli-copy-${Date.now()}`,
        sourceConnectionId: opts.sourceConnection,
        sourceIndex: opts.sourceIndex,
        targetConnectionId: opts.targetConnection,
        targetIndex: opts.targetIndex,
        namespaces,
        mapping,
        copyOptions: { skipExisting },
        dryRun: opts.dryRun,
      }),
    });
    console.log(`job: ${r.job.id}`);
  });

program
  .command('sync')
  .description('Start a polling-based zero-downtime sync job')
  .requiredOption('--source-connection <id>')
  .requiredOption('--source-index <name>')
  .requiredOption('--target-connection <id>')
  .requiredOption('--target-index <name>')
  .requiredOption('-n, --namespaces <list>', 'Comma-separated or @file')
  .option('--name <name>')
  .option('--poll-sec <n>', 'Poll interval in seconds', '30')
  .option('--mapping <kind>', 'Mapping kind: same|prefix|suffix|single|regex', 'same')
  .option('--mapping-value <value>')
  .option('--version-field <field>', 'Optional metadata field for in-place update detection')
  .option('--tombstone-pct <n>', 'Pause-and-confirm threshold for deletes (%)', '10')
  .option(
    '--skip-existing <mode>',
    'Skip records already in target during bootstrap copy: never|id|hash',
    'never',
  )
  .action(async (opts) => {
    const namespaces = await loadList(opts.namespaces);
    const mapping = buildMapping(opts);
    const skipExisting = parseSkipMode(opts.skipExisting);
    const r = await call<{ job: { id: string } }>('/jobs/sync', {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name ?? `cli-sync-${Date.now()}`,
        sourceConnectionId: opts.sourceConnection,
        sourceIndex: opts.sourceIndex,
        targetConnectionId: opts.targetConnection,
        targetIndex: opts.targetIndex,
        namespaces,
        mapping,
        copyOptions: { skipExisting },
        pollIntervalMs: Number(opts.pollSec) * 1000,
        tombstoneGuard: { maxDeletePctPerPass: Number(opts.tombstonePct) / 100 },
        versionField: opts.versionField
          ? { enabled: true, field: opts.versionField, samplePerPass: 2000 }
          : { enabled: false, field: '_v', samplePerPass: 2000 },
      }),
    });
    console.log(`sync job: ${r.job.id}`);
  });

program
  .command('status')
  .argument('<jobId>')
  .description('Show current status of a job')
  .action(async (jobId: string) => {
    const r = await call<{ job: { name: string; status: string; kind: string }; progress: unknown[]; syncState: unknown }>(
      `/jobs/${jobId}`,
    );
    console.log(`${r.job.name}  [${r.job.kind}]  ${r.job.status}`);
    console.log(JSON.stringify(r.progress, null, 2));
    if (r.syncState) console.log('sync state:', JSON.stringify(r.syncState, null, 2));
  });

program
  .command('promote')
  .argument('<jobId>')
  .description('Promote (cut over) a sync job to its target')
  .action(async (jobId: string) => {
    await call(`/jobs/${jobId}/promote`, { method: 'POST' });
    console.log(`promoted ${jobId}`);
  });

program
  .command('verify')
  .argument('<jobId>')
  .option('-n, --sample <size>', 'Sample size per namespace', '100')
  .description('Run post-copy verification on a job')
  .action(async (jobId: string, opts) => {
    await call(`/jobs/${jobId}/verify`, {
      method: 'POST',
      body: JSON.stringify({ sampleSize: Number(opts.sample) }),
    });
    console.log(`verification queued for ${jobId}`);
  });

async function loadList(arg: string): Promise<string[]> {
  if (arg.startsWith('@')) {
    const text = await readFile(arg.slice(1), 'utf8');
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return arg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSkipMode(value: string | undefined): 'never' | 'id' | 'hash' {
  const v = (value ?? 'never').toLowerCase();
  if (v === 'never' || v === 'id' || v === 'hash') return v;
  throw new Error(`--skip-existing must be one of: never, id, hash (got ${value})`);
}

function buildMapping(opts: {
  mapping: string;
  mappingValue?: string;
  regexPattern?: string;
  regexReplacement?: string;
}): Record<string, unknown> {
  switch (opts.mapping) {
    case 'same':
      return { kind: 'same' };
    case 'prefix':
      return { kind: 'prefix', value: opts.mappingValue ?? '' };
    case 'suffix':
      return { kind: 'suffix', value: opts.mappingValue ?? '' };
    case 'single':
      return { kind: 'single', target: opts.mappingValue ?? 'merged' };
    case 'regex':
      return {
        kind: 'regex',
        pattern: opts.regexPattern ?? '^',
        replacement: opts.regexReplacement ?? '',
      };
    default:
      return { kind: 'same' };
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
