'use client'

import { useQuery } from '@tanstack/react-query'

interface LeaderboardRow {
  villagerId: string
  name: string
  score: number
  edgeCount: number
}

async function fetchLeaderboard(metric: 'popular' | 'hated'): Promise<LeaderboardRow[]> {
  const response = await fetch(`/api/agent/leaderboard?metric=${metric}`)
  if (!response.ok) throw new Error(`agent-service ${response.status}`)
  return response.json()
}

function Board({ title, rows }: { title: string; rows: LeaderboardRow[] }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-400">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500">Nobody yet — feelings form as villagers interact.</p>
      ) : (
        <ol className="space-y-1.5">
          {rows.map((row, index) => (
            <li key={row.villagerId} className="flex items-baseline gap-2 text-sm">
              <span className="w-4 shrink-0 tabular-nums text-xs text-zinc-500">{index + 1}.</span>
              <span className="truncate">{row.name}</span>
              <span
                className={
                  'ml-auto shrink-0 tabular-nums text-xs ' +
                  (row.score > 0 ? 'text-emerald-400' : row.score < 0 ? 'text-red-400' : 'text-zinc-400')
                }
              >
                {row.score > 0 ? `+${row.score}` : row.score}
              </span>
              <span className="shrink-0 text-[10px] text-zinc-600">
                {row.edgeCount} {row.edgeCount === 1 ? 'edge' : 'edges'}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** Interim M1 leaderboard — score = sum of incoming affinity, straight off
 * agent-service (analytics-service takes this over in M2). */
export function Leaderboard() {
  const { data, isPending, error } = useQuery({
    queryKey: ['leaderboard'],
    queryFn: async () => {
      const [popular, hated] = await Promise.all([fetchLeaderboard('popular'), fetchLeaderboard('hated')])
      return { popular: popular.slice(0, 5), hated: hated.slice(0, 5) }
    },
    refetchInterval: 10_000,
  })

  if (isPending) return <p className="text-sm text-zinc-500">Tallying opinions…</p>
  if (error)
    return (
      <p className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        agent-service unreachable: {String(error)}
      </p>
    )

  return (
    <div className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <Board title="Most popular" rows={data.popular} />
      <Board title="Most hated" rows={data.hated} />
      <p className="text-[10px] leading-relaxed text-zinc-600">
        score = everyone&apos;s feelings toward them, summed · refreshes every 10s
      </p>
    </div>
  )
}
