'use client'

import { useEffect, useState } from 'react'
import type { CivEvent } from '@/lib/types'

/**
 * RB-3: the race scoreboard — the video's product shot. Reads the SAME
 * ledger the win is judged from: initial state from event-service's REST
 * slice of the newest attempt, live updates from the existing SSE relay.
 * Team mapping is client-side from AttemptStarted's embedded roster
 * (ADR-10); villager names resolve via agent-service's /villagers.
 *
 * Color: team identity uses the teams' OWN hues (they are literally named
 * red and blue) — #ef4444 / #0284c7, validated (dataviz six checks, dark
 * surface). Identity is never color-alone: every mark carries the team
 * name, and milestone state is a ✓ glyph, not a hue shift.
 */

const MILESTONES = ['first_coal', 'first_iron_ore', 'furnace_placed', 'first_ingot', 'iron_pickaxe'] as const
const MILESTONE_LABELS: Record<string, string> = {
  first_coal: 'coal',
  first_iron_ore: 'iron ore',
  furnace_placed: 'furnace',
  first_ingot: 'ingot',
  iron_pickaxe: 'IRON PICKAXE',
}
const TEAM_COLOR: Record<string, string> = { red: '#ef4444', blue: '#0284c7' }
const FEED_CAP = 30

interface TeamState {
  teamId: string
  villagerIds: string[]
  crossed: Record<string, { by: string; at: string }>
}

interface FeedLine {
  key: string
  at: string
  teamId: string
  text: string
}

interface RaceState {
  attemptId: string
  label: string | null
  difficulty: string
  startedAt: string
  teams: TeamState[]
  feed: FeedLine[]
  ended: { outcome: string; winningTeamId: string | null; durationSeconds: number } | null
}

function teamColor(teamId: string): string {
  return TEAM_COLOR[teamId] ?? '#71717a' // an unknown team name reads neutral, never a stolen hue
}

export function RaceScoreboard() {
  const [race, setRace] = useState<RaceState | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let live = true

    const nameOf = (id: string, table: Record<string, string>) => table[id] ?? id.slice(0, 8)

    const ingest = (state: RaceState, event: CivEvent, table: Record<string, string>): RaceState => {
      const p = event.payload as Record<string, any>
      if (event.eventType === 'ProgressionMilestone' && p.attemptId === state.attemptId) {
        return {
          ...state,
          teams: state.teams.map((team) =>
            team.teamId === p.teamId && !team.crossed[p.milestone]
              ? { ...team, crossed: { ...team.crossed, [p.milestone]: { by: p.villagerId, at: event.occurredAt } } }
              : team,
          ),
          feed: [
            {
              key: event.eventId,
              at: event.occurredAt,
              teamId: p.teamId,
              text: `${nameOf(p.villagerId, table)} — ${p.detail ?? MILESTONE_LABELS[p.milestone] ?? p.milestone}`,
            },
            ...state.feed,
          ].slice(0, FEED_CAP),
        }
      }
      if (event.eventType === 'AttemptEnded' && p.attemptId === state.attemptId) {
        return {
          ...state,
          ended: { outcome: p.outcome, winningTeamId: p.winningTeamId, durationSeconds: p.durationSeconds },
        }
      }
      return state
    }

    const fromStarted = (event: CivEvent): RaceState => {
      const p = event.payload as Record<string, any>
      return {
        attemptId: p.attemptId,
        label: p.label,
        difficulty: p.difficulty,
        startedAt: event.occurredAt,
        teams: (p.teams as Array<{ teamId: string; villagerIds: string[] }>).map((t) => ({
          ...t,
          crossed: {},
        })),
        feed: [],
        ended: null,
      }
    }

    async function bootstrap() {
      const table: Record<string, string> = {}
      try {
        for (const v of await (await fetch('/api/agent/villagers')).json()) {
          table[v.id] = v.name
        }
      } catch {
        /* names degrade to short ids */
      }
      if (live) {
        setNames(table)
      }
      // Newest attempt: the store pages ascending with a 100 cap — follow
      // the cursor to the last page, take the last AttemptStarted, then
      // replay its aggregate slice for current state.
      let started: CivEvent | undefined
      let cursor: string | null = null
      do {
        const url = `/api/events/events?type=AttemptStarted&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const page: { data: CivEvent[]; nextCursor: string | null } = await (await fetch(url)).json()
        if (page.data.length > 0) {
          started = page.data.at(-1)
        }
        cursor = page.nextCursor
      } while (cursor)
      if (!started || !live) {
        return
      }
      let state = fromStarted(started)
      let sliceCursor: string | null = null
      do {
        const url = `/api/events/events?aggregate-type=Attempt&aggregate-id=${state.attemptId}&limit=100${sliceCursor ? `&cursor=${encodeURIComponent(sliceCursor)}` : ''}`
        const slice: { data: CivEvent[]; nextCursor: string | null } = await (await fetch(url)).json()
        for (const event of slice.data) {
          state = ingest(state, event, table)
        }
        sliceCursor = slice.nextCursor
      } while (sliceCursor)
      if (live) {
        setRace(state)
      }

      const source = new EventSource('/api/events/events/stream')
      source.onopen = () => setConnected(true)
      source.onerror = () => setConnected(false)
      source.addEventListener('event', (message) => {
        const event: CivEvent = JSON.parse((message as MessageEvent).data)
        if (event.eventType === 'AttemptStarted') {
          setRace(fromStarted(event)) // a new take supersedes the board
        } else if (event.eventType === 'ProgressionMilestone' || event.eventType === 'AttemptEnded') {
          setRace((current) => (current ? ingest(current, event, table) : current))
        }
      })
      return () => source.close()
    }

    const cleanup = bootstrap()
    return () => {
      live = false
      void cleanup.then((close) => close?.())
    }
  }, [])

  if (!race) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-8 text-sm text-zinc-500">
        No race attempt in the ledger yet — start one with <code className="text-zinc-400">scripts/race-rb2.mjs</code>.
      </div>
    )
  }

  const winner = race.ended?.outcome === 'won' ? race.ended.winningTeamId : null

  return (
    <div className="space-y-6">
      {race.ended && (
        <div
          className="rounded-xl border px-6 py-4 text-lg font-semibold"
          style={{ borderColor: winner ? teamColor(winner) : '#3f3f46' }}
        >
          {winner ? (
            <>
              <span style={{ color: teamColor(winner) }}>Team {winner}</span>
              <span className="text-zinc-200"> crafted the iron pickaxe first — race won in </span>
              <span className="tabular-nums text-zinc-200">{Math.round(race.ended.durationSeconds / 60)} min</span>
            </>
          ) : (
            <span className="text-zinc-400">Race {race.ended.outcome} — no winner this take</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {race.teams.map((team) => {
          const done = MILESTONES.filter((m) => team.crossed[m]).length
          return (
            <section key={team.teamId} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
              <header className="mb-4 flex items-baseline justify-between">
                <h3 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
                  <span className="h-3 w-3 rounded-full" style={{ background: teamColor(team.teamId) }} />
                  Team {team.teamId}
                </h3>
                <span className="text-xs text-zinc-500">
                  {team.villagerIds.map((v) => names[v] ?? v.slice(0, 8)).join(' · ')}
                </span>
              </header>
              {/* the ladder: 5 segments, 2px surface gaps, ✓ carries state (never hue alone) */}
              <div className="mb-2 flex gap-0.5">
                {MILESTONES.map((m) => (
                  <div
                    key={m}
                    className="h-2 flex-1 first:rounded-l last:rounded-r"
                    style={{ background: team.crossed[m] ? teamColor(team.teamId) : '#27272a' }}
                  />
                ))}
              </div>
              <ol className="space-y-1.5">
                {MILESTONES.map((m) => (
                  <li key={m} className="flex items-center gap-2 text-sm">
                    <span className={team.crossed[m] ? 'text-zinc-100' : 'text-zinc-600'}>
                      {team.crossed[m] ? '✓' : '·'}
                    </span>
                    <span className={m === 'iron_pickaxe' ? 'font-semibold ' : ''} style={{ color: team.crossed[m] ? '#e4e4e7' : '#71717a' }}>
                      {MILESTONE_LABELS[m]}
                    </span>
                    {team.crossed[m] && (
                      <span className="ml-auto tabular-nums text-xs text-zinc-500">
                        {new Date(team.crossed[m].at).toLocaleTimeString()}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs tabular-nums text-zinc-500">
                {done}/{MILESTONES.length} milestones
              </p>
            </section>
          )
        })}
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
          <span className="text-xs text-zinc-500">
            attempt {race.attemptId.slice(0, 13)}… · {race.difficulty}
            {race.label ? ` · ${race.label}` : ''} · milestone feed
          </span>
          <span className={'flex items-center gap-1.5 text-xs ' + (connected ? 'text-emerald-400' : 'text-red-400')}>
            <span className={'h-2 w-2 rounded-full ' + (connected ? 'bg-emerald-400' : 'bg-red-400')} />
            {connected ? 'live' : 'reconnecting'}
          </span>
        </div>
        <ol className="divide-y divide-zinc-800/60">
          {race.feed.length === 0 && <li className="p-4 text-sm text-zinc-500">No milestones yet — the wood age.</li>}
          {race.feed.map((line) => (
            <li key={line.key} className="flex items-center gap-3 px-4 py-2 text-sm">
              <time className="shrink-0 tabular-nums text-xs text-zinc-500">
                {new Date(line.at).toLocaleTimeString()}
              </time>
              <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium" style={{ color: teamColor(line.teamId) }}>
                <span className="h-2 w-2 rounded-full" style={{ background: teamColor(line.teamId) }} />
                {line.teamId}
              </span>
              <span className="truncate text-zinc-300">{line.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
