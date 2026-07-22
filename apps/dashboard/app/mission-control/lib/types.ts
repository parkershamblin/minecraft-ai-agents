// Shared types + color constants for the Mission Control route.
// Team/status colors are deliberate literals (data-viz only, never UI chrome)
// — identical to the design handoff's oklch values.

export type Dataset = 'normal_881s' | 'easy_360s'
export type Mode = 'auto' | 'live' | 'demo'
export type SourceState = 'probing' | 'live' | 'demo'
export type TeamKey = 'red' | 'blue'
export type Tab = 'race' | 'llm' | 'pipe'

export const RED = 'oklch(0.74 0.13 25)'
export const BLUE = 'oklch(0.74 0.11 245)'
export const STATUS_GREEN = 'oklch(0.78 0.1 150)'
export const LEGEND_GREEN = 'oklch(0.76 0.1 150)'
export const FAIL_RED = 'oklch(0.68 0.13 25)'

export const TEAM_COLOR: Record<TeamKey, string> = { red: RED, blue: BLUE }

export const muted = (pct: number) => `color-mix(in srgb, var(--mc-text) ${pct}%, transparent)`

export interface McConfig {
  mode: Mode
  dataset: Dataset
  povLive: boolean
  povBase: string
  showCaptions: boolean
}

export type GlyphKey = 'coal' | 'ore' | 'furnace' | 'ingot' | 'pick'

// 10×10 stroke glyphs from the prototype — coal is the only filled one.
export const GLYPHS: Record<GlyphKey, string> = {
  coal: 'M5 1.8 A3.2 3.2 0 1 0 5 8.2 A3.2 3.2 0 1 0 5 1.8',
  ore: 'M5 1 L9 5 L5 9 L1 5 Z',
  furnace: 'M2 2 H8 V8 H2 Z M3.6 5.6 H6.4',
  ingot: 'M1.5 6.5 L3.5 3.5 H8.5 L6.5 6.5 Z',
  pick: 'M2 8.5 L8.5 2 M4 1.6 Q8.4 1.8 8.4 6',
}

export const MILESTONE_ORDER = [
  'first_coal',
  'first_iron_ore',
  'furnace_placed',
  'first_ingot',
  'iron_pickaxe',
] as const

export const MILESTONE_LABELS: Record<string, string> = {
  first_coal: 'first coal',
  first_iron_ore: 'first iron ore',
  furnace_placed: 'furnace placed',
  first_ingot: 'first ingot',
  iron_pickaxe: 'iron pickaxe',
}

export const MILESTONE_GLYPH: Record<string, GlyphKey> = {
  first_coal: 'coal',
  first_iron_ore: 'ore',
  furnace_placed: 'furnace',
  first_ingot: 'ingot',
  iron_pickaxe: 'pick',
}

export interface TrackPoint {
  t: number
  x: number
  z: number
}

export interface MapTrack {
  name: string
  color: string
  lead: boolean
  nx: string // name-label x offset, e.g. '-30px'
  pts: TrackPoint[]
}

export interface MapMilestone {
  label: string
  villager: string
  team: string // display label RED | BLUE
  color: string
  mt: number // seconds since race start
  x: number | null // null → unpinnable (live coord not parseable from detail)
  z: number | null
  glyph: GlyphKey
  lift: number // stem px
  ox: number // fan x-offset px
  coordLabel: string // '(x, z)' or '—'
}

export interface MapModel {
  T: number
  clockTotal: string // '14:41'
  tracks: MapTrack[]
  trailsIllustrative: boolean
  milestones: MapMilestone[]
  spawns: { label: string; x: number; z: number }[]
  scrubEnabled: boolean
}

export interface CollectorRow {
  name: string
  color: string
  v: number
}

export interface ServiceRow {
  name: string
  stack: string
  target: string
  status: string
  up: boolean
  p95: string
}

export interface StatData {
  winner: string
  winnerColor: string
  winnerSub: string
  winTime: string
  winTimeSub: string
  attempt: string
  redScore: string
  blueScore: string
  honest: string
  honestSub: string
  humanInput: string
}

export interface LlmStats {
  llmCalls: string
  llmP95: string
  tokTotals: string
  spend: string
  breaker: string
  breakerOpen: boolean
  malformed: string
  normalized: string
}

export interface PipeStats {
  evTotal: string
  evPeak: string
  lagMax: string
  servicesUp: string
  botSessions: string
  sseClients: string
  reconnects: string
}

export interface NamedSeries {
  label: string
  color: string
  vals: number[]
  width?: number
  area?: boolean
}

export interface DashboardModel {
  dataset: Dataset
  T: number
  timeLabels: string[]
  rangeLabel: string
  race: {
    stats: StatData
    redT: (number | null)[]
    blueT: (number | null)[]
    rateRed: number[]
    rateBlue: number[]
    lane: number[]
    collectors: CollectorRow[]
  }
  map: MapModel
  llm: {
    stats: LlmStats
    latSeries: NamedSeries[]
    tokIn: number[]
    tokOut: number[]
    ticks: NamedSeries[]
    reactive: number[]
    tickDur: number[]
  }
  pipe: {
    stats: PipeStats
    throughput: NamedSeries[]
    lag: NamedSeries[]
    mem: number[]
    services: ServiceRow[]
    reflections: { label: string; v: number }[]
    fleetRows: { l: string; v: string }[]
    curlId: string
    scrapeCol: string // column header: 'HTTP p95' (demo) | 'Scrape ms' (live)
  }
}

// ——— live-mode source shapes ———

export interface LiveMilestone {
  milestone: string
  teamId: string
  villagerId: string
  villager: string
  tSec: number
  detail: string | null
  coord: { x: number; z: number } | null
}

export interface LiveRace {
  attemptId: string
  label: string | null
  difficulty: string
  startedAt: string
  startSec: number
  teams: { teamId: string; villagerIds: string[] }[]
  names: Record<string, string>
  milestones: LiveMilestone[]
  ended: { outcome: string; winningTeamId: string | null; durationSeconds: number } | null
  connected: boolean
}

export interface RangeWindow {
  start: number // unix seconds
  end: number
  anchor: number | null // attempt start (unix seconds) for T+ labels, null → wall-clock labels
}

export interface PromRaceData {
  trips: number
  malformed: number
  normalized: number
  fakeDecisions: number
  collectors: { player: string; v: number }[]
  rateByPlayer: Map<string, number[]>
  lane: number[]
}

export interface PromLlmData {
  p95Now: number
  latByProvider: Map<string, number[]>
  tokIn: number[]
  tokOut: number[]
  tokInTotal: number
  tokOutTotal: number
  spend: number
  ticksByOutcome: Map<string, number[]>
  reactive: number[]
  tickDur: number[]
  trips: number
  malformed: number
  normalized: number
  providerCounts: Map<string, number>
}

export interface PromPipeData {
  evTotal: number
  byTopic: Map<string, number[]>
  lagByClient: Map<string, number[]>
  mem: number[]
  reflections: Map<string, number>
  upByJob: Map<string, number>
  scrapeByJob: Map<string, number>
  botSessions: number
  reconnects: number
  sseClients: number
}
