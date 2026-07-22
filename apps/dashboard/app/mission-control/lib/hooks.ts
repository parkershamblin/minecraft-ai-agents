'use client'

// Data hooks for live mode. Policy (documented in the PR): per-source
// fallback — Prometheus-backed panels fall together, ledger-backed panels
// likewise; a live source with an empty answer renders an honest empty state,
// never silently-swapped demo numbers. `?mode=demo` pins everything canned;
// `?mode=live` disables the demo fallback.

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CivEvent } from '@/lib/types'
import { fetchAttemptSlice, fetchLatestAttemptStarted, fetchVillagerNames, parseCoords, probeLedger } from './ledger'
import { matrixByLabel, probePrometheus, promQuery, promRange, resample, vectorByLabel, vectorValue } from './prom'
import { rangeSelector, SERIES_POINTS, stepFor } from './liveModel'
import type {
  LiveRace,
  MapTrack,
  Mode,
  PromLlmData,
  PromPipeData,
  PromRaceData,
  RangeWindow,
  SourceState,
  Tab,
  TrackPoint,
} from './types'

export function useDataMode(mode: Mode): { prom: SourceState; ledger: SourceState } {
  const enabled = mode === 'auto'
  const prom = useQuery({
    queryKey: ['mc-probe-prom'],
    queryFn: probePrometheus,
    enabled,
    retry: 0,
    refetchInterval: (query) => (query.state.status === 'error' ? 30_000 : 60_000),
    staleTime: 25_000,
  })
  const ledger = useQuery({
    queryKey: ['mc-probe-ledger'],
    queryFn: probeLedger,
    enabled,
    retry: 0,
    refetchInterval: (query) => (query.state.status === 'error' ? 30_000 : 60_000),
    staleTime: 25_000,
  })
  if (mode === 'demo') return { prom: 'demo', ledger: 'demo' }
  if (mode === 'live') return { prom: 'live', ledger: 'live' }
  const state = (q: typeof prom): SourceState =>
    q.isError ? 'demo' : q.data === true ? 'live' : q.isPending ? 'probing' : 'demo'
  return { prom: state(prom), ledger: state(ledger) }
}

// RaceScoreboard's bootstrap-then-stream, lifted to the MissionControl root so
// the EventSource survives tab switches: page to the newest AttemptStarted,
// replay its aggregate slice, then follow the SSE feed. A new AttemptStarted
// supersedes the board.
export function useLiveRace(enabled: boolean): { race: LiveRace | null; checked: boolean } {
  const [race, setRace] = useState<LiveRace | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setRace(null)
      setChecked(false)
      return
    }
    let live = true

    const fromStarted = (event: CivEvent, names: Record<string, string>): LiveRace => {
      const p = event.payload as Record<string, any>
      return {
        attemptId: p.attemptId,
        label: p.label ?? null,
        difficulty: p.difficulty ?? '?',
        startedAt: event.occurredAt,
        startSec: Date.parse(event.occurredAt) / 1000,
        teams: (p.teams as { teamId: string; villagerIds: string[] }[]) ?? [],
        names,
        milestones: [],
        ended: null,
        connected: false,
      }
    }

    const ingest = (state: LiveRace, event: CivEvent): LiveRace => {
      const p = event.payload as Record<string, any>
      if (event.eventType === 'ProgressionMilestone' && p.attemptId === state.attemptId) {
        if (state.milestones.some((m) => m.teamId === p.teamId && m.milestone === p.milestone)) {
          return state
        }
        return {
          ...state,
          milestones: [
            ...state.milestones,
            {
              milestone: p.milestone,
              teamId: p.teamId,
              villagerId: p.villagerId,
              villager: state.names[p.villagerId] ?? String(p.villagerId).slice(0, 8),
              tSec: Math.max(0, (Date.parse(event.occurredAt) - Date.parse(state.startedAt)) / 1000),
              detail: p.detail ?? null,
              coord: parseCoords(p.detail),
            },
          ],
        }
      }
      if (event.eventType === 'AttemptEnded' && p.attemptId === state.attemptId) {
        return {
          ...state,
          ended: { outcome: p.outcome, winningTeamId: p.winningTeamId ?? null, durationSeconds: p.durationSeconds },
        }
      }
      return state
    }

    async function bootstrap() {
      const names = await fetchVillagerNames()
      let started: CivEvent | null = null
      try {
        started = await fetchLatestAttemptStarted()
      } catch {
        if (live) setChecked(true)
        return
      }
      if (!live) return
      if (!started) {
        setChecked(true)
        return
      }
      let state = fromStarted(started, names)
      await fetchAttemptSlice(state.attemptId, (event) => {
        state = ingest(state, event)
      })
      if (!live) return
      setRace(state)
      setChecked(true)

      const source = new EventSource('/api/events/events/stream')
      source.onopen = () => setRace((current) => (current ? { ...current, connected: true } : current))
      source.onerror = () => setRace((current) => (current ? { ...current, connected: false } : current))
      source.addEventListener('event', (message) => {
        const event: CivEvent = JSON.parse((message as MessageEvent).data)
        if (event.eventType === 'AttemptStarted') {
          setRace(fromStarted(event, names)) // a new take supersedes the board
        } else if (event.eventType === 'ProgressionMilestone' || event.eventType === 'AttemptEnded') {
          setRace((current) => (current ? ingest(current, event) : current))
        }
      })
      return () => source.close()
    }

    const cleanup = bootstrap()
    return () => {
      live = false
      void cleanup.then((close) => close?.())
    }
  }, [enabled])

  return { race, checked }
}

// One batched query per tab — every panel of a view updates atomically on the
// 10 s cadence that the header chip advertises.
//
// Key discipline: the query key carries the window's IDENTITY (the attempt
// anchor), never its size. While a race runs, computeWindow's end grows every
// second — keying on R/bucket minted a fresh cache entry each second, whose
// momentarily-undefined .data made mergeModel flash the demo dataset between
// polls (the demo⇄live flicker across every Prom-fed panel) and turned the
// 10 s cadence into a 1 s query storm. The queryFn closure is rebuilt each
// render, and react-query always invokes the latest one on refetch, so the
// growing R/step/window values stay fresh without ever entering the key.
// placeholderData bridges the one real key change (attempt switch) so the
// board never dips through the demo state mid-session.
export function usePromView(tab: Tab, enabled: boolean, window: RangeWindow) {
  const R = rangeSelector(window)
  const step = stepFor(window)
  const anchor = window.anchor ?? 'rolling'

  const race = useQuery({
    queryKey: ['mc-prom', 'race', anchor],
    enabled: enabled && tab === 'race',
    retry: 0,
    refetchInterval: 10_000,
    staleTime: 10_000,
    placeholderData: (prev: PromRaceData | undefined) => prev,
    queryFn: async (): Promise<PromRaceData> => {
      const [trips, malformed, normalized, fake, collectors, rate, lane] = await Promise.all([
        promQuery('max(civ_llm_budget_tripped)'),
        promQuery(`sum(increase(civ_llm_malformed_total[${R}]))`),
        promQuery(`sum(increase(civ_llm_normalized_total[${R}]))`),
        promQuery(`sum(increase(civ_llm_latency_seconds_count{provider="fake",job="agent-service"}[${R}]))`),
        promQuery(`topk(6, sum by (player) (increase(civ_materials_collected_total[${R}])))`),
        promRange('sum by (player) (rate(civ_materials_collected_total[2m])) * 60', window.start, window.end, step),
        promRange('max(civ_command_lane_depth)', window.start, window.end, step),
      ])
      return {
        trips: vectorValue(trips),
        malformed: vectorValue(malformed),
        normalized: vectorValue(normalized),
        fakeDecisions: vectorValue(fake),
        collectors: [...vectorByLabel(collectors, 'player').entries()]
          .map(([player, v]) => ({ player, v }))
          .sort((a, b) => b.v - a.v),
        rateByPlayer: matrixByLabel(rate, 'player', SERIES_POINTS, window.start, window.end),
        lane: lane[0] ? resample(lane[0].values, SERIES_POINTS, window.start, window.end) : [],
      }
    },
  })

  const llm = useQuery({
    queryKey: ['mc-prom', 'llm', anchor],
    enabled: enabled && tab === 'llm',
    retry: 0,
    refetchInterval: 10_000,
    staleTime: 10_000,
    placeholderData: (prev: PromLlmData | undefined) => prev,
    queryFn: async (): Promise<PromLlmData> => {
      const agent = '{job="agent-service"}'
      const [p95Now, lat, tok, tokTotal, spend, ticks, reactive, tickDur, trips, malformed, normalized, providers] =
        await Promise.all([
          promQuery(
            'histogram_quantile(0.95, sum by (le) (rate(civ_llm_latency_seconds_bucket{job="agent-service"}[5m])))',
          ),
          promRange(
            'histogram_quantile(0.95, sum by (le, provider) (rate(civ_llm_latency_seconds_bucket{job="agent-service"}[5m])))',
            window.start,
            window.end,
            step,
          ),
          promRange('sum by (direction) (rate(civ_llm_tokens_total[5m])) * 60', window.start, window.end, step),
          promQuery(`sum by (direction) (increase(civ_llm_tokens_total[${R}]))`),
          promQuery(`sum(increase(civ_llm_cost_dollars_total[${R}]))`),
          promRange('sum by (outcome) (rate(civ_ticks_total[5m])) * 60', window.start, window.end, step),
          promRange(
            'sum(rate(civ_ticks_total{trigger="reactive"}[5m])) / sum(rate(civ_ticks_total[5m]))',
            window.start,
            window.end,
            step,
          ),
          promRange(
            'histogram_quantile(0.95, sum by (le) (rate(civ_tick_seconds_bucket[5m])))',
            window.start,
            window.end,
            step,
          ),
          promQuery('max(civ_llm_budget_tripped)'),
          promQuery(`sum(increase(civ_llm_malformed_total[${R}]))`),
          promQuery(`sum(increase(civ_llm_normalized_total[${R}]))`),
          promQuery(`sum by (provider) (increase(civ_llm_latency_seconds_count${agent}[${R}]))`),
        ])
      const tokByDir = matrixByLabel(tok, 'direction', SERIES_POINTS, window.start, window.end)
      const tokTotals = vectorByLabel(tokTotal, 'direction')
      return {
        p95Now: vectorValue(p95Now),
        latByProvider: matrixByLabel(lat, 'provider', SERIES_POINTS, window.start, window.end),
        tokIn: tokByDir.get('input') ?? [],
        tokOut: tokByDir.get('output') ?? [],
        tokInTotal: tokTotals.get('input') ?? 0,
        tokOutTotal: tokTotals.get('output') ?? 0,
        spend: vectorValue(spend),
        ticksByOutcome: matrixByLabel(ticks, 'outcome', SERIES_POINTS, window.start, window.end),
        reactive: reactive[0] ? resample(reactive[0].values, SERIES_POINTS, window.start, window.end) : [],
        tickDur: tickDur[0] ? resample(tickDur[0].values, SERIES_POINTS, window.start, window.end) : [],
        trips: vectorValue(trips),
        malformed: vectorValue(malformed),
        normalized: vectorValue(normalized),
        providerCounts: vectorByLabel(providers, 'provider'),
      }
    },
  })

  const pipe = useQuery({
    queryKey: ['mc-prom', 'pipe', anchor],
    enabled: enabled && tab === 'pipe',
    retry: 0,
    refetchInterval: 10_000,
    staleTime: 10_000,
    placeholderData: (prev: PromPipeData | undefined) => prev,
    queryFn: async (): Promise<PromPipeData> => {
      const [evTotal, byTopic, lag, mem, reflections, up, scrape, bots, reconnects, sse] = await Promise.all([
        promQuery(`sum(increase(civ_events_ingested_total[${R}]))`),
        promRange('sum by (topic) (rate(civ_events_ingested_total[1m]))', window.start, window.end, step),
        promRange('sum by (client_id) (kafka_consumer_fetch_manager_records_lag)', window.start, window.end, step),
        promRange(
          'histogram_quantile(0.95, sum by (le) (rate(civ_memory_retrieval_seconds_bucket[5m]))) * 1000',
          window.start,
          window.end,
          step,
        ),
        promQuery(`sum by (outcome) (increase(civ_reflections_total[${R}]))`),
        promQuery('max by (job) (up{job=~".*-service"})'),
        promQuery('max by (job) (scrape_duration_seconds{job=~".*-service"})'),
        promQuery('max(civ_bot_sessions)'),
        promQuery(`sum(increase(civ_bot_reconnects_total[${R}]))`),
        promQuery('max(civ_sse_clients)'),
      ])
      return {
        evTotal: vectorValue(evTotal),
        byTopic: matrixByLabel(byTopic, 'topic', SERIES_POINTS, window.start, window.end),
        lagByClient: matrixByLabel(lag, 'client_id', SERIES_POINTS, window.start, window.end),
        mem: mem[0] ? resample(mem[0].values, SERIES_POINTS, window.start, window.end) : [],
        reflections: vectorByLabel(reflections, 'outcome'),
        upByJob: vectorByLabel(up, 'job'),
        scrapeByJob: vectorByLabel(scrape, 'job'),
        botSessions: vectorValue(bots),
        reconnects: vectorValue(reconnects),
        sseClients: vectorValue(sse),
      }
    },
  })

  return {
    race: race.data ?? null,
    llm: llm.data ?? null,
    pipe: pipe.data ?? null,
    anyError: race.isError || llm.isError || pipe.isError,
  }
}

interface PositionsResponse {
  positions: { username: string; x: number; y: number; z: number }[]
  capturedAt: string
}

// 3 s poll of minecraft-service's admin server; buffers a client-side trail
// per villager (ring-capped) since nothing stores position history. Colors
// come from the demo roster (same six racers).
export function usePositions(enabled: boolean, startSec: number | null, roster: MapTrack[]): MapTrack[] | null {
  const buffers = useRef(new Map<string, TrackPoint[]>())
  const lastStart = useRef(startSec)
  if (lastStart.current !== startSec) {
    lastStart.current = startSec
    buffers.current.clear() // a new attempt resets the trail clock
  }
  const query = useQuery({
    queryKey: ['mc-positions'],
    enabled,
    retry: 0,
    refetchInterval: 3_000,
    staleTime: 3_000,
    queryFn: async (): Promise<PositionsResponse> => {
      const response = await fetch('/api/minecraft/internal/positions')
      if (!response.ok) {
        throw new Error(`minecraft-service ${response.status}`)
      }
      return response.json()
    },
  })

  useEffect(() => {
    if (!enabled) {
      buffers.current.clear()
    }
  }, [enabled])

  if (!enabled || query.isError || !query.data) return null
  const t0 = startSec ?? 0
  const capturedSec = Date.parse(query.data.capturedAt) / 1000
  for (const p of query.data.positions) {
    const buffer = buffers.current.get(p.username) ?? []
    const t = Math.max(0, capturedSec - t0)
    if (!buffer.length || buffer[buffer.length - 1].t < t) {
      buffer.push({ t, x: p.x, z: p.z })
      if (buffer.length > 600) buffer.shift()
    }
    buffers.current.set(p.username, buffer)
  }
  const tracks: MapTrack[] = []
  for (const seed of roster) {
    const pts = buffers.current.get(seed.name)
    if (pts && pts.length) {
      tracks.push({ ...seed, pts })
    }
  }
  return tracks.length ? tracks : null
}

// 1 s wall-clock tick while an attempt is running (live elapsed readout).
export function useNowSec(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}
