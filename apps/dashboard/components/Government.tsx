'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CivEvent, Election, Villager } from '@/lib/types'

// SSE is the poke, react-query is the truth: on any election event we
// invalidate (debounced) instead of hand-merging — the tally can never drift
// from government-service. The M1-5 graph hand-merges because force layouts
// hate refetch resets; a card page has no such excuse.
const CIVIC_EVENT_TYPES = new Set([
  'ElectionStarted',
  'CandidateNominated',
  'VoteCast',
  'ElectionDecided',
])

const PHASE_STYLES: Record<Election['status'], string> = {
  scheduled: 'bg-zinc-800 text-zinc-300',
  nominating: 'bg-amber-950 text-amber-300 border border-amber-800',
  voting: 'bg-sky-950 text-sky-300 border border-sky-800',
  decided: 'bg-emerald-950 text-emerald-300 border border-emerald-800',
  annulled: 'bg-red-950 text-red-300 border border-red-900',
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} → ${response.status}`)
  return response.json()
}

/** villagerId → name, from agent-service (the roster is tiny and static). */
function useVillagerNames(): Record<string, string> {
  const { data } = useQuery({
    queryKey: ['villager-names'],
    queryFn: () => fetchJson<Villager[]>('/api/agent/villagers'),
    staleTime: 5 * 60_000,
  })
  const names: Record<string, string> = {}
  for (const villager of data ?? []) names[villager.id] = villager.name
  return names
}

function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(interval)
  }, [tickMs])
  return now
}

function countdown(deadlineIso: string, now: number): string {
  const remaining = Math.max(0, Math.floor((Date.parse(deadlineIso) - now) / 1000))
  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function relative(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

/** Bootstrap the latest arc: 10s poll as the belt (react-query dedupes these
 * across the panel and the feed — one fetch, two consumers). */
function useElection(): { election: Election | undefined; isPending: boolean; error: unknown } {
  const latest = useQuery({
    queryKey: ['latest-election'],
    queryFn: () => fetchJson<Election[]>('/api/government/elections?limit=1'),
    refetchInterval: 10_000,
  })
  const electionId = latest.data?.[0]?.electionId

  const detail = useQuery({
    queryKey: ['election', electionId],
    queryFn: () => fetchJson<Election>(`/api/government/elections/${electionId}?include=votes`),
    enabled: electionId !== undefined,
    refetchInterval: 10_000,
  })

  return {
    election: detail.data ?? latest.data?.[0],
    isPending: latest.isPending,
    error: latest.error ?? detail.error,
  }
}

/** SSE as the suspenders: any election event pokes a debounced invalidate, so
 * a burst of votes is one refetch and the tally never drifts from the server.
 * Mounted ONCE (by ElectionPanel) — one socket per page, not per widget. */
function useCivicSse(): void {
  const queryClient = useQueryClient()
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const source = new EventSource('/api/events/events/stream')
    source.onmessage = (message) => {
      try {
        const event: CivEvent = JSON.parse(message.data)
        if (!CIVIC_EVENT_TYPES.has(event.eventType)) return
        if (debounce.current) clearTimeout(debounce.current)
        debounce.current = setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['latest-election'] })
          queryClient.invalidateQueries({ queryKey: ['election'] })
        }, 800)
      } catch {
        // heartbeats / non-JSON frames — not ours to worry about
      }
    }
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
      source.close()
    }
  }, [queryClient])
}

function PhaseClock({ election, now }: { election: Election; now: number }) {
  const deadline =
    election.status === 'scheduled'
      ? { label: 'nominations open in', at: election.startsAt }
      : election.status === 'nominating'
        ? { label: 'nominations close in', at: election.nominatingEndsAt }
        : election.status === 'voting'
          ? { label: 'ballot box closes in', at: election.endsAt }
          : null
  if (!deadline) return null
  return (
    <div className="text-right">
      <div className="font-mono text-2xl tabular-nums text-zinc-100">{countdown(deadline.at, now)}</div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{deadline.label}</div>
    </div>
  )
}

function CandidateRow({
  name,
  platform,
  votes,
  maxVotes,
  isWinner,
  decided,
}: {
  name: string
  platform: string | null
  votes: number
  maxVotes: number
  isWinner: boolean
  decided: boolean
}) {
  const width = maxVotes > 0 ? Math.max(4, Math.round((votes / maxVotes) * 100)) : 0
  return (
    <li className={'rounded-lg border p-3 ' + (isWinner ? 'border-emerald-700 bg-emerald-950/30' : 'border-zinc-800 bg-zinc-900/40')}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">
          {name}
          {isWinner && <span className="ml-2 text-xs text-emerald-400">★ mayor{decided ? '' : '?'}</span>}
        </span>
        <span className="shrink-0 tabular-nums text-sm text-zinc-300">
          {votes} {votes === 1 ? 'vote' : 'votes'}
        </span>
      </div>
      {platform && <p className="mt-1 text-xs italic text-zinc-400">“{platform}”</p>}
      <div className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-800">
        <div
          className={'h-full rounded transition-all duration-500 ' + (isWinner ? 'bg-emerald-500' : 'bg-sky-500')}
          style={{ width: `${width}%` }}
        />
      </div>
    </li>
  )
}

export function ElectionPanel() {
  const { election, isPending, error } = useElection()
  const names = useVillagerNames()
  const now = useNow(1000)
  useCivicSse()

  if (isPending) return <p className="text-sm text-zinc-500">Checking the notice board…</p>
  if (error)
    return (
      <p className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        government-service unreachable: {String(error)}
      </p>
    )
  if (!election)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 text-sm text-zinc-400">
        No election has ever been called. The operator opens one with{' '}
        <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">POST /elections</code> — the institution is
        seeded; the politics are the villagers&apos; own.
      </div>
    )

  const nameOf = (villagerId: string | null) =>
    (villagerId && names[villagerId]) || (villagerId ? `villager ${villagerId.slice(0, 8)}` : '—')
  const maxVotes = Math.max(...election.candidates.map((c) => c.votes), 1)

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold capitalize">Election for {election.office}</h2>
            <span className={'rounded-full px-2.5 py-0.5 text-xs font-medium ' + PHASE_STYLES[election.status]}>
              {election.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            nominations {new Date(election.startsAt).toLocaleTimeString()} –{' '}
            {new Date(election.nominatingEndsAt).toLocaleTimeString()} · voting until{' '}
            {new Date(election.endsAt).toLocaleTimeString()} · {election.totalVotes}{' '}
            {election.totalVotes === 1 ? 'vote' : 'votes'} cast
          </p>
        </div>
        <PhaseClock election={election} now={now} />
      </div>

      {election.status === 'decided' && election.winnerVillagerId && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">
          The votes are counted — <span className="font-semibold">{nameOf(election.winnerVillagerId)}</span> is
          the new mayor of the village.
        </div>
      )}
      {election.status === 'annulled' && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          Election annulled{election.annulledReason ? `: ${election.annulledReason.replace('_', ' ')}` : ''}.
        </div>
      )}

      {election.candidates.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No one has stepped forward yet{election.status === 'nominating' ? ' — nominations are open.' : '.'}
        </p>
      ) : (
        <ol className="space-y-2">
          {[...election.candidates]
            .sort((a, b) => b.votes - a.votes)
            .map((candidate) => (
              <CandidateRow
                key={candidate.candidateId}
                name={nameOf(candidate.villagerId)}
                platform={candidate.platform}
                votes={candidate.votes}
                maxVotes={maxVotes}
                isWinner={
                  election.winnerCandidateId === candidate.candidateId ||
                  (election.status === 'voting' && candidate.votes === maxVotes && candidate.votes > 0)
                }
                decided={election.status === 'decided'}
              />
            ))}
        </ol>
      )}
    </div>
  )
}

export function VoteFeed() {
  const { election } = useElection()
  const names = useVillagerNames()
  const now = useNow(5000)

  const votes = [...(election?.votes ?? [])].sort((a, b) => Date.parse(b.castAt) - Date.parse(a.castAt))
  const candidateVillager: Record<string, string> = {}
  for (const candidate of election?.candidates ?? []) candidateVillager[candidate.candidateId] = candidate.villagerId

  const nameOf = (villagerId: string | undefined) =>
    (villagerId && names[villagerId]) || (villagerId ? `villager ${villagerId.slice(0, 8)}` : '—')

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      {votes.length === 0 ? (
        <p className="text-xs text-zinc-500">No votes yet — the receipts appear here as ballots land.</p>
      ) : (
        <ol className="space-y-3">
          {votes.map((vote) => (
            <li key={vote.voteId} className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span>
                  <span className="font-medium">{nameOf(vote.voterId)}</span>
                  <span className="text-zinc-500"> → </span>
                  <span className="font-medium">{nameOf(candidateVillager[vote.candidateId])}</span>
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">{relative(vote.castAt, now)}</span>
              </div>
              {vote.reason && <p className="mt-0.5 text-xs italic leading-relaxed text-zinc-400">“{vote.reason}”</p>}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-[10px] leading-relaxed text-zinc-600">
        every ballot is a VoteCast event with the voter&apos;s own stated reason · live via SSE
      </p>
    </div>
  )
}
