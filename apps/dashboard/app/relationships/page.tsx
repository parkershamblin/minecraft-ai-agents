import Link from 'next/link'
import { RelationshipGraph } from '@/components/RelationshipGraph'

export default function RelationshipsPage() {
  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Relationships</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Who likes whom, live — every edge is a RelationshipChanged event with a reason.
          </p>
        </div>
        <nav className="text-xs text-zinc-500">
          <Link href="/" className="hover:text-zinc-300">
            ← Overview
          </Link>
        </nav>
      </header>

      <RelationshipGraph />
    </main>
  )
}
