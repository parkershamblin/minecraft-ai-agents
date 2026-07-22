import Link from 'next/link'
import { EventFeed } from '@/components/EventFeed'
import { VillagerGrid } from '@/components/VillagerGrid'

export default function OverviewPage() {
  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Civilization Engine</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Autonomous villagers on a live Minecraft server — every thought, word, and step is an event.
          </p>
        </div>
        <nav className="flex gap-4 text-xs text-zinc-500">
          <Link href="/mission-control" className="hover:text-zinc-300">
            Mission Control →
          </Link>
          <Link href="/race" className="hover:text-zinc-300">
            Race →
          </Link>
          <Link href="/government" className="hover:text-zinc-300">
            Government →
          </Link>
          <Link href="/relationships" className="hover:text-zinc-300">
            Relationships →
          </Link>
        </nav>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
        <section className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-400">Villagers</h2>
          <VillagerGrid />
        </section>
        <section className="lg:col-span-3">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-400">Live events</h2>
          <EventFeed />
        </section>
      </div>
    </main>
  )
}
