// Live-mode model builder: starts from the demo model (per-source fallback —
// panels a source can't back keep their canned values, labeled by the header
// badge) and overlays ledger facts and Prometheus series where available.

import { fmtT } from './chartMath'
import { FAIL_RED, MILESTONE_GLYPH, MILESTONE_LABELS, MILESTONE_ORDER, muted, TEAM_COLOR } from './types'
import type {
  DashboardModel,
  LiveRace,
  MapMilestone,
  MapTrack,
  NamedSeries,
  PromLlmData,
  PromPipeData,
  PromRaceData,
  RangeWindow,
  ServiceRow,
  TeamKey,
} from './types'

export const SERIES_POINTS = 90

// Seed-roster fallback for the player→team join (AttemptStarted's roster wins
// when present; minecraftUsername === name for all six racers).
const SEED_TEAMS: Record<string, TeamKey> = {
  Elara: 'red',
  Bram: 'red',
  Wren: 'red',
  Ansel: 'blue',
  Petra: 'blue',
  Fen: 'blue',
}

const MILESTONES = MILESTONE_ORDER

export function computeWindow(race: LiveRace | null, nowSec: number): RangeWindow {
  if (race) {
    const start = race.startSec - 30
    const end = race.ended ? race.startSec + race.ended.durationSeconds : nowSec
    return { start, end: Math.max(end, start + 60), anchor: race.startSec }
  }
  return { start: nowSec - 900, end: nowSec, anchor: null }
}

export function rangeSelector(window: RangeWindow): string {
  return `${Math.max(60, Math.round(window.end - window.start))}s`
}

export function stepFor(window: RangeWindow): number {
  return Math.max(10, Math.round((window.end - window.start) / SERIES_POINTS))
}

export function axisLabels(window: RangeWindow): string[] {
  const marks = [0, 0.25, 0.5, 0.75, 1].map((f) => window.start + f * (window.end - window.start))
  if (window.anchor != null) {
    const anchor = window.anchor
    return marks.map((m) => fmtT(Math.max(0, m - anchor)))
  }
  return marks.map((m) => {
    const d = new Date(m * 1000)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  })
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

function fmtK(v: number): string {
  return v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v))
}

function teamTimes(race: LiveRace, teamId: string): (number | null)[] {
  return MILESTONES.map((milestone) => {
    const hit = race.milestones.find((m) => m.teamId === teamId && m.milestone === milestone)
    return hit ? hit.tSec : null
  })
}

// Greedy pin de-collision for live coordinates: the prototype's hand-tuned
// ox/lift values only fit the canned coords, and overlapping chips were the
// prototype's own recurring bug class. Sort by time; start each chip centered
// (ox 0) just above its anchor (lift 16); while its estimated rect intersects
// a placed one, raise it 22px and alternate a ±60px fan.
function layoutPins(
  pins: { label: string; villager: string; team: string; x: number; z: number }[],
): { lift: number; ox: number }[] {
  const W = 900
  const H = 420
  const CHIP_H = 17
  const placed: { x: number; y: number; w: number; h: number }[] = []
  return pins.map((pin) => {
    const sx = ((350 + (pin.x - pin.z) * 1.35) / 700) * W
    const sy = ((215 + (pin.x + pin.z) * 0.68) / 430) * H
    const w = `${pin.label} — ${pin.villager} · ${pin.team}`.length * 4.8 + 34
    let lift = 16
    let ox = 0
    let attempt = 0
    const intersects = () => {
      const rect = { x: sx + ox - w / 2, y: sy - lift - CHIP_H, w, h: CHIP_H }
      return placed.some(
        (p) => rect.x < p.x + p.w && p.x < rect.x + rect.w && rect.y < p.y + p.h && p.y < rect.y + rect.h,
      )
    }
    while (intersects() && attempt < 20) {
      attempt++
      lift += 22
      ox = attempt % 2 === 1 ? 60 : -60
    }
    placed.push({ x: sx + ox - w / 2, y: sy - lift - CHIP_H, w, h: CHIP_H })
    return { lift, ox }
  })
}

function liveMilestonePins(race: LiveRace): MapMilestone[] {
  const ordered = [...race.milestones].sort((a, b) => a.tSec - b.tSec)
  const pinnable = ordered.filter((m) => m.coord != null)
  const layout = layoutPins(
    pinnable.map((m) => ({
      label: milestoneLabel(m.milestone, race, m.teamId),
      villager: m.villager,
      team: m.teamId.toUpperCase(),
      x: m.coord!.x,
      z: m.coord!.z,
    })),
  )
  let pinIndex = 0
  return ordered.map((m) => {
    const color = TEAM_COLOR[m.teamId as TeamKey] ?? muted(60)
    const placed = m.coord ? layout[pinIndex++] : { lift: 16, ox: 0 }
    return {
      label: milestoneLabel(m.milestone, race, m.teamId),
      villager: m.villager,
      team: m.teamId.toUpperCase(),
      color,
      mt: m.tSec,
      x: m.coord?.x ?? null,
      z: m.coord?.z ?? null,
      glyph: MILESTONE_GLYPH[m.milestone] ?? 'coal',
      lift: placed.lift,
      ox: placed.ox,
      coordLabel: m.coord ? `(${Math.round(m.coord.x)}, ${Math.round(m.coord.z)})` : '—',
    }
  })
}

function milestoneLabel(milestone: string, race: LiveRace, teamId: string): string {
  const base = MILESTONE_LABELS[milestone] ?? milestone
  const isWin = milestone === 'iron_pickaxe' && race.ended?.winningTeamId === teamId
  return isWin ? `${base} · WIN` : base
}

function winTimeSub(race: LiveRace, redT: (number | null)[], blueT: (number | null)[]): string {
  const leaderOf = (i: number): TeamKey | null => {
    const r = redT[i]
    const b = blueT[i]
    if (r == null && b == null) return null
    if (r == null) return 'blue'
    if (b == null) return 'red'
    return r <= b ? 'red' : 'blue'
  }
  const first = leaderOf(0)
  const second = leaderOf(1)
  if (!race.ended?.winningTeamId || first == null || first !== second) return ''
  if (first === race.ended.winningTeamId) return `${first} led from the first rung`
  return `${first} led the first two rungs`
}

interface MergeInputs {
  demo: DashboardModel
  race: LiveRace | null
  promRace: PromRaceData | null
  promLlm: PromLlmData | null
  promPipe: PromPipeData | null
  liveTracks: MapTrack[] | null
  window: RangeWindow
  nowSec: number
}

const SERIES_COLORS = ['var(--mc-accent)', muted(40), 'oklch(0.76 0.1 150)', FAIL_RED, 'var(--mc-accent-300)']

function toNamedSeries(map: Map<string, number[]>, opts?: { area?: boolean }): NamedSeries[] {
  return [...map.entries()]
    .sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))
    .slice(0, 4)
    .map(([label, vals], i) => ({
      label: label || '—',
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      vals,
      width: i === 0 ? undefined : 1.4,
      area: i === 0 ? opts?.area : undefined,
    }))
}

export function mergeModel(inputs: MergeInputs): DashboardModel {
  const { demo, race, promRace, promLlm, promPipe, liveTracks, window, nowSec } = inputs
  const model: DashboardModel = {
    ...demo,
    race: { ...demo.race, stats: { ...demo.race.stats } },
    map: { ...demo.map },
    llm: { ...demo.llm, stats: { ...demo.llm.stats } },
    pipe: { ...demo.pipe, stats: { ...demo.pipe.stats } },
  }
  const anyProm = promRace || promLlm || promPipe

  if (race) {
    const redT = teamTimes(race, 'red')
    const blueT = teamTimes(race, 'blue')
    const running = !race.ended
    const T = race.ended ? race.ended.durationSeconds : Math.max(1, nowSec - race.startSec)
    const winTeam = race.ended?.winningTeamId ?? null
    const winPick = race.milestones.find((m) => m.milestone === 'iron_pickaxe' && (!winTeam || m.teamId === winTeam))
    const date = race.startedAt.slice(0, 10)
    const difficulty = race.difficulty ? race.difficulty[0].toUpperCase() + race.difficulty.slice(1) : '?'

    model.T = T
    model.rangeLabel = running ? `${date} · ${difficulty} · live` : `${date} · ${difficulty} · T+0 → ${fmtT(T)}`
    model.race = {
      stats: {
        winner: race.ended
          ? winTeam
            ? `${winTeam.toUpperCase()} · ${winPick?.villager ?? '?'}`
            : race.ended.outcome
          : 'in progress',
        winnerColor: winTeam ? TEAM_COLOR[winTeam as TeamKey] : 'var(--mc-text)',
        winnerSub: `difficulty: ${difficulty}`,
        winTime: race.ended ? fmtDuration(race.ended.durationSeconds) : fmtT(T),
        winTimeSub: winTimeSub(race, redT, blueT),
        attempt: race.attemptId.slice(0, 13) + '…',
        redScore: `${redT.filter((t) => t != null).length}/5`,
        blueScore: `${blueT.filter((t) => t != null).length}/5`,
        honest: model.race.stats.honest,
        honestSub: model.race.stats.honestSub,
        humanInput: '0',
      },
      redT,
      blueT,
      rateRed: model.race.rateRed,
      rateBlue: model.race.rateBlue,
      lane: model.race.lane,
      collectors: model.race.collectors,
    }
    model.map = {
      T,
      clockTotal: race.ended ? `${Math.floor(T / 60)}:${String(Math.round(T % 60)).padStart(2, '0')}` : '—:—',
      tracks: liveTracks ?? demo.map.tracks,
      trailsIllustrative: liveTracks == null,
      milestones: liveMilestonePins(race),
      spawns: demo.map.spawns,
      scrubEnabled: !running,
    }
    model.pipe.curlId = race.attemptId
  }

  if (anyProm) {
    model.timeLabels = axisLabels(window)
  }

  if (promRace) {
    const teamOf = (player: string): TeamKey | null => {
      if (race) {
        for (const team of race.teams) {
          if (team.villagerIds.some((id) => race.names[id] === player)) {
            return (team.teamId as TeamKey) in TEAM_COLOR ? (team.teamId as TeamKey) : null
          }
        }
      }
      return SEED_TEAMS[player] ?? null
    }
    const zeros = () => new Array<number>(SERIES_POINTS).fill(0)
    const byTeam: Record<TeamKey, number[]> = { red: zeros(), blue: zeros() }
    for (const [player, vals] of promRace.rateByPlayer) {
      const team = teamOf(player)
      if (!team) continue
      byTeam[team] = byTeam[team].map((v, i) => v + (vals[i] ?? 0))
    }
    model.race.rateRed = byTeam.red
    model.race.rateBlue = byTeam.blue
    model.race.lane = promRace.lane
    model.race.collectors = promRace.collectors.map(({ player, v }) => ({
      name: player,
      color: teamOf(player) ? TEAM_COLOR[teamOf(player) as TeamKey] : muted(60),
      v: Math.round(v),
    }))
    model.race.stats.honest = promRace.trips === 0 ? 'clean' : 'tripped'
    model.race.stats.honestSub = `${promRace.trips} budget trips · ${Math.round(promRace.fakeDecisions)} fake-provider decisions`
  }

  if (promLlm) {
    model.llm = {
      stats: {
        llmCalls: String(Math.round(promLlm.normalized + promLlm.malformed)),
        llmP95: `${promLlm.p95Now.toFixed(1)} s`,
        tokTotals: `${fmtK(promLlm.tokInTotal)} / ${fmtK(promLlm.tokOutTotal)}`,
        spend: `$${promLlm.spend.toFixed(4)}`,
        breaker: promLlm.trips > 0 ? 'OPEN' : 'CLOSED',
        breakerOpen: promLlm.trips > 0,
        malformed: String(Math.round(promLlm.malformed)),
        normalized: String(Math.round(promLlm.normalized)),
      },
      latSeries: toNamedSeries(promLlm.latByProvider, { area: true }),
      tokIn: promLlm.tokIn,
      tokOut: promLlm.tokOut,
      // Real outcome labels are ok|error (two lines) — the prototype's
      // completed/no-op/failed triple exists only in the demo dataset.
      ticks: [...promLlm.ticksByOutcome.entries()].map(([outcome, vals]) => ({
        label: outcome || '—',
        color: outcome === 'error' ? FAIL_RED : 'var(--mc-accent)',
        vals,
        width: outcome === 'error' ? 1.4 : undefined,
      })),
      reactive: promLlm.reactive,
      tickDur: promLlm.tickDur,
    }
  }

  if (promPipe) {
    const upCount = [...promPipe.upByJob.entries()].filter(([job, v]) => job !== 'government-service' && v >= 1).length
    const scrapeMs = (job: string) => {
      const v = promPipe.scrapeByJob.get(job)
      return v != null ? `${Math.round(v * 1000)} ms` : '—'
    }
    const services: ServiceRow[] = demo.pipe.services.map((row) => {
      const up = (promPipe.upByJob.get(row.name) ?? 0) >= 1
      const mothballed = row.name === 'government-service' && !up
      return {
        ...row,
        up,
        status: up ? 'up' : mothballed ? 'mothballed' : 'down',
        p95: up ? scrapeMs(row.name) : '—',
      }
    })
    const reflections = [...promPipe.reflections.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, v]) => ({ label: outcome || '—', v: Math.round(v) }))
    model.pipe = {
      stats: {
        evTotal: Math.round(promPipe.evTotal).toLocaleString('en-US'),
        evPeak: peakOf(promPipe.byTopic).toFixed(1),
        lagMax: String(Math.round(peakOf(promPipe.lagByClient))),
        servicesUp: `${upCount} / 4`,
        botSessions: String(Math.round(promPipe.botSessions)),
        sseClients: String(Math.round(promPipe.sseClients)),
        reconnects: `${Math.round(promPipe.reconnects)} reconnects`,
      },
      throughput: toNamedSeries(promPipe.byTopic, { area: true }),
      lag: toNamedSeries(promPipe.lagByClient),
      mem: promPipe.mem,
      services,
      reflections: reflections.length ? reflections : demo.pipe.reflections,
      fleetRows: [
        { l: 'civ_bot_reconnects_total', v: String(Math.round(promPipe.reconnects)) },
        { l: 'civ_players_tracked', v: '—' },
        { l: 'inventory polls (ok / failed)', v: '—' },
        { l: 'civ_threat_fights_active', v: '—' },
      ],
      curlId: model.pipe.curlId,
      scrapeCol: 'Scrape ms',
    }
  }

  return model
}

function peakOf(map: Map<string, number[]>): number {
  const n = SERIES_POINTS
  let peak = 0
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (const vals of map.values()) {
      sum += vals[i] ?? 0
    }
    peak = Math.max(peak, sum)
  }
  return peak
}
