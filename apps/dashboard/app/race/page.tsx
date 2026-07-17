import Link from 'next/link'
import { RaceScoreboard } from '@/components/RaceScoreboard'

export default function RacePage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Red vs Blue</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Two teams of three LLM villagers race to the first crafted iron pickaxe — every milestone judged from the
            event ledger, live.
          </p>
        </div>
        <nav className="flex gap-4 text-xs text-zinc-500">
          <Link href="/" className="hover:text-zinc-300">
            ← Overview
          </Link>
        </nav>
      </header>
      <RaceScoreboard />
    </main>
  )
}
