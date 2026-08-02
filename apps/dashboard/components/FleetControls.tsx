'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

type SeedStatus = {
  aliveCount: number
  alive: string[]
  embodiedCount?: number
  embodied?: string[]
  orphanBodies?: string[]
  rosterSize: number
  roster: string[]
  next: string | null
  defaultCount: number
}

type SeedResult = {
  seeded: string[]
  existing: string[]
  count: number
  aliveCount: number
}

type DespawnResult = {
  despawned: string[]
  aliveCount: number
  alive: string[]
  embodied?: string[]
}

async function fetchStatus(): Promise<SeedStatus> {
  const response = await fetch('/api/agent/internal/seed/status')
  if (!response.ok) throw new Error(`seed status ${response.status}`)
  return response.json()
}

async function seedTo(count: number): Promise<SeedResult> {
  const response = await fetch('/api/agent/internal/seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `seed ${response.status}`)
  }
  return response.json()
}

async function despawnBody(body: { names: string[] } | { keep: number }): Promise<DespawnResult> {
  const response = await fetch('/api/agent/internal/despawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `despawn ${response.status}`)
  }
  return response.json()
}

/** Last removable name: prefer alive, else orphan body, in seed-roster order. */
function lastRemovableInRoster(data: SeedStatus): string | null {
  const removable = new Set([...data.alive, ...(data.orphanBodies ?? []), ...(data.embodied ?? [])])
  for (let i = data.roster.length - 1; i >= 0; i--) {
    const name = data.roster[i]
    if (removable.has(name)) return name
  }
  return null
}

export function FleetControls() {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<string | null>(null)
  const { data, isPending, error } = useQuery({
    queryKey: ['seed-status'],
    queryFn: fetchStatus,
    refetchInterval: 5_000,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['seed-status'] })
    void queryClient.invalidateQueries({ queryKey: ['villagers'] })
  }

  const seedMutation = useMutation({
    mutationFn: seedTo,
    onSuccess: (result) => {
      const added = result.seeded.length ? `spawned ${result.seeded.join(', ')}` : 're-embodied existing'
      setMessage(`${added} · fleet ${result.aliveCount}`)
      invalidate()
    },
    onError: (err) => setMessage(String(err)),
  })

  const despawnMutation = useMutation({
    mutationFn: despawnBody,
    onSuccess: (result) => {
      const still = result.embodied?.length ? ` · still on server: ${result.embodied.join(', ')}` : ''
      if (result.despawned.length === 0) {
        setMessage(`nothing to remove · fleet ${result.aliveCount}${still}`)
      } else {
        setMessage(`removed ${result.despawned.join(', ')} · fleet ${result.aliveCount}${still}`)
      }
      // Bodies quit asynchronously — refresh a few times.
      invalidate()
      window.setTimeout(invalidate, 1500)
      window.setTimeout(invalidate, 4000)
    },
    onError: (err) => setMessage(String(err)),
  })

  if (isPending) {
    return <p className="text-sm text-zinc-500">Loading fleet controls…</p>
  }
  if (error || !data) {
    return (
      <p className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        Fleet controls unavailable: {String(error)}
      </p>
    )
  }

  const embodiedCount = data.embodiedCount ?? data.embodied?.length ?? 0
  const orphans = data.orphanBodies ?? []
  const atCap = data.aliveCount >= data.rosterSize
  const busy = seedMutation.isPending || despawnMutation.isPending
  const last = lastRemovableInRoster(data)
  const canTrim = data.aliveCount > 0 || embodiedCount > 0

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-200">Fleet</h3>
        <p className="text-xs text-zinc-500">
          {data.aliveCount} ticking · {embodiedCount} on server / {data.rosterSize} roster
          {data.next ? ` · next: ${data.next}` : ' · roster full'}
        </p>
      </div>

      {orphans.length > 0 && (
        <p className="mt-2 rounded-md border border-amber-900/50 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-100">
          Orphan bodies (DB says gone, still in Minecraft): {orphans.join(', ')}. Use Keep 0 or Remove to clear
          them.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || atCap || !data.next}
          onClick={() => seedMutation.mutate(data.aliveCount + 1)}
          className="rounded-lg bg-emerald-800 px-3 py-1.5 text-xs font-medium text-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {data.next ? `Add ${data.next}` : 'Roster full'}
        </button>
        {[3, 6].map((n) => (
          <button
            key={n}
            type="button"
            disabled={busy || data.aliveCount >= n}
            onClick={() => seedMutation.mutate(n)}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Seed to {n}
          </button>
        ))}
        <button
          type="button"
          disabled={busy || data.aliveCount < 1}
          onClick={() => seedMutation.mutate(Math.max(1, data.aliveCount))}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
          title="Re-send spawn for everyone already in the DB (after minecraft-service recreate)"
        >
          Respawn fleet
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !last}
          onClick={() => last && despawnMutation.mutate({ names: [last] })}
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-1.5 text-xs text-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {last ? `Remove ${last}` : 'Nothing to remove'}
        </button>
        {[3, 1, 0].map((n) => (
          <button
            key={n}
            type="button"
            disabled={busy || (n > 0 ? data.aliveCount <= n && embodiedCount <= n : !canTrim)}
            onClick={() => despawnMutation.mutate({ keep: n })}
            className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-1.5 text-xs text-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              n === 0
                ? 'Despawn every ticking villager and every orphan body still on the server'
                : `Keep first ${n} of the seed roster`
            }
          >
            Keep {n}
          </button>
        ))}
      </div>

      {data.alive.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.alive.map((name) => (
            <button
              key={name}
              type="button"
              disabled={busy}
              onClick={() => despawnMutation.mutate({ names: [name] })}
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-rose-800 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-40"
              title={`Remove ${name}`}
            >
              {name} ×
            </button>
          ))}
        </div>
      )}
      {orphans.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {orphans.map((name) => (
            <button
              key={`orphan-${name}`}
              type="button"
              disabled={busy}
              onClick={() => despawnMutation.mutate({ names: [name] })}
              className="rounded border border-amber-800 bg-amber-950/40 px-2 py-0.5 text-[11px] text-amber-100 hover:border-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
              title={`Clear orphan body ${name}`}
            >
              {name} (orphan) ×
            </button>
          ))}
        </div>
      )}
      {message && <p className="mt-2 text-xs text-zinc-400">{message}</p>}
    </div>
  )
}
