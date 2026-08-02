import Link from 'next/link'
import { BenchControls } from '@/components/BenchControls'

export default function BenchPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bench & race launcher</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Start the same commands as <code className="text-zinc-300">npm run race</code> /{' '}
            <code className="text-zinc-300">node scripts/civ-bench.mjs</code> from the browser. Jobs run on the
            machine hosting this dashboard.
          </p>
        </div>
        <nav className="flex gap-4 text-xs text-zinc-500">
          <Link href="/" className="hover:text-zinc-300">
            ← Overview
          </Link>
          <Link href="/race" className="hover:text-zinc-300">
            Scoreboard →
          </Link>
          <Link href="/mission-control" className="hover:text-zinc-300">
            Mission Control →
          </Link>
        </nav>
      </header>
      <BenchControls />
    </main>
  )
}
