import Link from 'next/link'
import { ElectionPanel, VoteFeed } from '@/components/Government'

export default function GovernmentPage() {
  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Government</h1>
          <p className="mt-1 text-sm text-zinc-400">
            The village chooses — candidacies, ballots, and reasons, all live from the ledger&apos;s events.
          </p>
        </div>
        <nav className="flex gap-4 text-xs text-zinc-500">
          <Link href="/" className="hover:text-zinc-300">
            ← Overview
          </Link>
          <Link href="/relationships" className="hover:text-zinc-300">
            Relationships →
          </Link>
        </nav>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <ElectionPanel />
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-400">
            The receipts — why they voted
          </h2>
          <VoteFeed />
        </section>
      </div>
    </main>
  )
}
