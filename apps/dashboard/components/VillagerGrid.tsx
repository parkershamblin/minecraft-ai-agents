'use client'

import { useQuery } from '@tanstack/react-query'
import type { Villager } from '@/lib/types'

async function fetchVillagers(): Promise<Villager[]> {
  const response = await fetch('/api/agent/villagers')
  if (!response.ok) throw new Error(`agent-service ${response.status}`)
  return response.json()
}

export function VillagerGrid() {
  const { data, isPending, error } = useQuery({
    queryKey: ['villagers'],
    queryFn: fetchVillagers,
    refetchInterval: 15_000,
  })

  if (isPending) return <p className="text-sm text-zinc-500">Waking the villagers…</p>
  if (error)
    return (
      <p className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        agent-service unreachable: {String(error)}
      </p>
    )
  if (data.length === 0)
    return (
      <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
        No villagers yet — run <code className="rounded bg-zinc-800 px-1">task seed</code>.
      </p>
    )

  return (
    <div className="space-y-3">
      {data.map((villager) => (
        <article key={villager.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{villager.name}</h3>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs ' +
                (villager.status === 'alive'
                  ? 'bg-emerald-950 text-emerald-300'
                  : 'bg-zinc-800 text-zinc-400')
              }
            >
              {villager.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {(villager.personality.traits ?? []).join(' · ') || 'personality unknown'}
          </p>
          {villager.backstory && (
            <p className="mt-2 line-clamp-2 text-sm text-zinc-400">{villager.backstory}</p>
          )}
        </article>
      ))}
    </div>
  )
}
