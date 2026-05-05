import Link from 'next/link';
import { ConnectionPanel } from '@/components/ConnectionPanel';
import { NamespaceBrowser } from '@/components/NamespaceBrowser';
import { CostEstimatePanel } from '@/components/CostEstimatePanel';
import { CreateJobPanel } from '@/components/CreateJobPanel';
import { Button } from '@/components/ui';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pinecone Vector Migrator</h1>
          <p className="text-sm text-muted-foreground">
            Copy or sync vectors between Pinecone indexes with cost previews and zero-downtime support.
          </p>
        </div>
        <Link href="/jobs">
          <Button variant="outline">View jobs</Button>
        </Link>
      </header>

      <ConnectionPanel />
      <NamespaceBrowser />
      <CostEstimatePanel />
      <CreateJobPanel />
    </main>
  );
}
