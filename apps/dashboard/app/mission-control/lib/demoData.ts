// Canned 2026-07-18 telemetry — an exact port of the design prototype's
// seeded generators (design_handoff_mission_control/Mission Control.dc.html,
// logic script). Same LCG, same seeds, same shaping arithmetic → the demo
// curves match the handoff bit-for-bit, and determinism keeps SSR and client
// renders identical (hydration-safe). Do not "clean up" the math.

import { BLUE, FAIL_RED, LEGEND_GREEN, muted, RED } from './types'
import type {
  CollectorRow,
  DashboardModel,
  Dataset,
  GlyphKey,
  MapMilestone,
  MapTrack,
  ServiceRow,
  TrackPoint,
} from './types'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function gauss(t: number, c: number, w: number, a: number): number {
  const d = (t - c) / w
  return a * Math.exp(-0.5 * d * d)
}

function series(n: number, seed: number, fn: (u: number, z: number) => number): number[] {
  const r = rng(seed)
  const out: number[] = []
  let z = 0
  for (let i = 0; i < n; i++) {
    z = z * 0.72 + (r() - 0.5)
    out.push(fn(i / (n - 1), z))
  }
  return out
}

type Anchor = [number, number, number] // [t, x, z]

function densify(anchors: Anchor[], seed: number): TrackPoint[] {
  const r = rng(seed)
  const pts: TrackPoint[] = []
  for (let i = 0; i < anchors.length - 1; i++) {
    const [t0, x0, z0] = anchors[i]
    const [t1, x1, z1] = anchors[i + 1]
    const amp = (r() - 0.5) * 10
    const dx = x1 - x0
    const dz = z1 - z0
    const len = Math.hypot(dx, dz) || 1
    for (let k = 0; k < 6; k++) {
      const u = k / 6
      const w = Math.sin(u * Math.PI) * amp
      pts.push({ t: t0 + (t1 - t0) * u, x: x0 + dx * u + (-dz / len) * w, z: z0 + dz * u + (dx / len) * w })
    }
  }
  const last = anchors[anchors.length - 1]
  pts.push({ t: last[0], x: last[1], z: last[2] })
  return pts
}

const ANCHORS_NORMAL: Record<string, Anchor[]> = {
  Elara: [[0, -64, 48], [60, -38, 66], [120, -46, 10], [178, -52, -38], [250, -40, -6], [330, -30, 60], [430, -44, 20], [540, -20, -8], [650, -12, -18], [760, -24, 6], [881, -14, -14]],
  Wren: [[0, -64, 48], [80, -52, -20], [170, -40, -44], [240, -6, -52], [301, 18, -64], [380, 4, -40], [455, -8, -20], [560, -2, -28], [663, -8, -20], [780, -4, -16], [881, -8, -20]],
  Bram: [[0, -64, 48], [70, -30, 68], [160, -24, 44], [270, -48, 30], [390, -34, 64], [510, -52, 8], [630, -30, -10], [750, -38, 40], [881, -22, 20]],
  Petra: [[0, 56, -44], [70, 40, 10], [142, 34, 52], [230, 52, 30], [320, 64, 4], [420, 58, 16], [512, 60, 8], [640, 70, -8], [770, 54, 18], [881, 62, 4]],
  Ansel: [[0, 56, -44], [90, 74, -6], [180, 82, 18], [267, 88, 34], [370, 72, 20], [480, 62, 10], [610, 78, 0], [750, 66, 26], [881, 72, 12]],
  Fen: [[0, 56, -44], [80, 78, -16], [210, 60, -30], [350, 84, 8], [490, 70, 40], [630, 88, -8], [770, 76, 24], [881, 80, 10]],
}

const ANCHORS_EASY: Record<string, Anchor[]> = {
  Elara: [[0, -64, 48], [45, -52, 8], [88, -44, -30], [118, -20, -46], [146, 6, -58], [180, -4, -36], [214, -12, -14], [250, -14, -10], [289, -12, -14], [325, -10, -16], [360.4, -12, -14]],
  Wren: [[0, -64, 48], [60, -36, 20], [120, -48, -16], [190, -28, -34], [260, -16, -24], [320, -18, -10], [360.4, -14, -16]],
  Bram: [[0, -64, 48], [70, -32, 62], [150, -46, 36], [230, -28, 52], [310, -40, 24], [360.4, -34, 34]],
  Petra: [[0, 56, -44], [55, 42, 6], [104, 30, 46], [170, 48, 26], [240, 60, 6], [310, 56, 14], [360.4, 58, 10]],
  Ansel: [[0, 56, -44], [80, 72, -4], [140, 80, 16], [181, 84, 30], [250, 70, 18], [320, 62, 10], [360.4, 66, 14]],
  Fen: [[0, 56, -44], [90, 76, -14], [190, 62, -26], [280, 80, 4], [360.4, 72, 18]],
}

// [name, color, lead, nx] — nx nudges the name label off shared endpoints.
const ROSTER: [string, string, boolean, string][] = [
  ['Elara', RED, true, '-30px'],
  ['Bram', RED, false, '0px'],
  ['Wren', RED, true, '30px'],
  ['Ansel', BLUE, true, '24px'],
  ['Petra', BLUE, true, '0px'],
  ['Fen', BLUE, false, '-24px'],
]

// [label, villager, team, color, mt, x, z, glyph, lift, ox]
type Pin = [string, string, string, string, number, number, number, GlyphKey, number, number]

const MS_NORMAL: Pin[] = [
  ['first coal', 'Petra', 'BLUE', BLUE, 142, 34, 52, 'coal', 16, -30],
  ['first coal', 'Elara', 'RED', RED, 178, -52, -38, 'coal', 20, -60],
  ['first iron ore', 'Ansel', 'BLUE', BLUE, 267, 88, 34, 'ore', 16, 0],
  ['first iron ore', 'Wren', 'RED', RED, 301, 18, -64, 'ore', 14, 30],
  ['furnace placed', 'Wren', 'RED', RED, 455, -8, -20, 'furnace', 24, -60],
  ['furnace placed', 'Petra', 'BLUE', BLUE, 512, 60, 8, 'furnace', 32, 35],
  ['first ingot', 'Wren', 'RED', RED, 663, -8, -20, 'ingot', 56, 60],
  ['iron pickaxe · WIN', 'Wren', 'RED', RED, 881, -8, -20, 'pick', 88, 0],
]

const MS_EASY: Pin[] = [
  ['first coal', 'Elara', 'RED', RED, 88, -44, -30, 'coal', 20, -70],
  ['first coal', 'Petra', 'BLUE', BLUE, 104, 30, 46, 'coal', 16, -30],
  ['first iron ore', 'Elara', 'RED', RED, 146, 6, -58, 'ore', 14, 30],
  ['first iron ore', 'Ansel', 'BLUE', BLUE, 181, 84, 30, 'ore', 16, 0],
  ['furnace placed', 'Elara', 'RED', RED, 214, -12, -14, 'furnace', 24, -60],
  ['first ingot', 'Elara', 'RED', RED, 289, -12, -14, 'ingot', 56, 60],
  ['iron pickaxe · WIN', 'Elara', 'RED', RED, 360.4, -12, -14, 'pick', 88, 0],
]

const SERVICES: ServiceRow[] = [
  { name: 'event-service', stack: 'Java 21 · Spring Boot', target: ':8081 /actuator/prometheus', status: 'up', up: true, p95: '4 ms' },
  { name: 'minecraft-service', stack: 'Node 22 · TS · mineflayer', target: ':8003 /metrics', status: 'up', up: true, p95: '6 ms' },
  { name: 'agent-service', stack: 'Python · FastAPI · LangGraph', target: ':8001 /metrics', status: 'up', up: true, p95: '9 ms' },
  { name: 'memory-service', stack: 'Python · FastAPI · pgvector', target: ':8002 /metrics', status: 'up', up: true, p95: '7 ms' },
  { name: 'government-service', stack: 'Java 21 · Spring Boot', target: ':8082 /actuator/prometheus', status: 'mothballed', up: false, p95: '—' },
]

export const DEMO_ATTEMPT_IDS: Record<Dataset, string> = {
  normal_881s: '019f7352-03ae-716b-b4df-1da76bb8c9d8',
  easy_360s: '019f7337-977e-738e-8d5a-bf8e1db77439',
}

export function buildDemoModel(dataset: Dataset): DashboardModel {
  const normal = dataset !== 'easy_360s'
  const T = normal ? 881 : 360.4
  const n = normal ? 90 : 40
  const redT: (number | null)[] = normal ? [178, 301, 455, 663, 881] : [88, 146, 214, 289, 360.4]
  const blueT: (number | null)[] = normal ? [142, 267, 512, null, null] : [104, 181, null, null, null]
  const allT = redT.concat(blueT).filter((t): t is number => t != null)
  const blueStall = (normal ? 512 : 181) + 60

  const rateRed = series(n, 7, (u, z) => {
    const t = u * T
    let v = 4 + z * 2.5
    const a = [8, 13, 18, 15, 22]
    redT.forEach((c, i) => {
      if (c != null) v += gauss(t, c - T / 15, T / 18, a[i])
    })
    return Math.max(0.2, v)
  })
  const rateBlue = series(n, 13, (u, z) => {
    const t = u * T
    let v = 4 + z * 2.5
    const a = [10, 16, 12]
    blueT.forEach((c, i) => {
      if (c != null) v += gauss(t, c - T / 15, T / 18, a[i] || 0)
    })
    if (t > blueStall) v *= 0.45
    return Math.max(0.2, v)
  })
  const lane = series(n, 21, (u, z) => {
    const t = u * T
    let v = Math.max(0, z * 0.8 + 0.35)
    allT.forEach((c) => {
      v += gauss(t, c, T / 60, 2.6)
    })
    v += gauss(t, (redT[3] as number) - T / 25, T / 40, 3.2)
    return v
  })
  const lat = series(n, 31, (u, z) => {
    const t = u * T
    return Math.max(7, 11 + z * 1.2 + gauss(t, T * 0.34, T / 12, 2) + gauss(t, T * 0.8, T / 10, 2.6))
  })
  const tokIn = series(n, 41, (u, z) => {
    const t = u * T
    return Math.max(2500, 5200 + z * 700 + gauss(t, T * 0.25, T / 9, 1400) + gauss(t, T * 0.72, T / 9, 1700))
  })
  const tokOut = tokIn.map((v, i) => v * 0.118 + (i % 3) * 25)
  const ticksC = series(n, 51, (u, z) => Math.max(14, 21 + z * 2.2))
  const ticksN = series(n, 53, (u, z) => Math.max(0.5, 4 + z * 1.4))
  const ticksF = series(n, 57, (u, z) => Math.max(0, 0.25 + z * 0.5 - 0.2))
  const reactive = series(n, 61, (u, z) => {
    const t = u * T
    return Math.min(
      0.55,
      Math.max(0.04, 0.17 + z * 0.05 + gauss(t, blueT[0] ?? T * 0.2, T / 15, 0.14) + gauss(t, redT[3] ?? T * 0.7, T / 14, 0.18)),
    )
  })
  const tickDur = series(n, 63, (u, z) => {
    const t = u * T
    return Math.max(8, 12 + z * 1.1 + gauss(t, T * 0.5, T / 10, 2.2))
  })
  const evWorld = series(n, 71, (u, z) => {
    const t = u * T
    let v = 11 + z * 2.6
    allT.forEach((c) => {
      v += gauss(t, c, T / 40, 5)
    })
    return Math.max(2, v)
  })
  const evCmd = series(n, 73, (u, z) => Math.max(0.2, 1.3 + z * 0.35))
  const evMile = series(n, 79, (u, z) => {
    const t = u * T
    let v = Math.max(0, z * 0.04)
    allT.forEach((c) => {
      v += gauss(t, c, T / 110, 0.9)
    })
    return v
  })
  const lagEvt = series(n, 83, (u, z) => {
    const t = u * T
    return Math.max(0, z * 0.5 - 0.1) + gauss(t, T * 0.49, T / 80, 2.2) + gauss(t, T * 0.8, T / 90, 1.6)
  })
  const lagAgt = series(n, 89, (u, z) => Math.max(0, z * 0.4 - 0.15))
  const mem = series(n, 97, (u, z) => {
    const t = u * T
    return Math.max(28, 48 + z * 9 + gauss(t, T * 0.57, T / 12, 18))
  })

  const collectors: CollectorRow[] = (normal
    ? [['Wren', RED, 214], ['Elara', RED, 187], ['Petra', BLUE, 176], ['Bram', RED, 149], ['Ansel', BLUE, 138], ['Fen', BLUE, 117]]
    : [['Elara', RED, 128], ['Wren', RED, 96], ['Petra', BLUE, 91], ['Bram', RED, 84], ['Ansel', BLUE, 77], ['Fen', BLUE, 63]]
  ).map(([name, color, v]) => ({ name: name as string, color: color as string, v: v as number }))

  const anchors = normal ? ANCHORS_NORMAL : ANCHORS_EASY
  const tracks: MapTrack[] = ROSTER.map(([name, color, lead, nx], i) => ({
    name,
    color,
    lead,
    nx,
    pts: densify(anchors[name], 101 + i * 7),
  }))

  const milestones: MapMilestone[] = (normal ? MS_NORMAL : MS_EASY).map(
    ([label, villager, team, color, mt, x, z, glyph, lift, ox]) => ({
      label,
      villager,
      team,
      color,
      mt,
      x,
      z,
      glyph,
      lift,
      ox,
      coordLabel: `(${x}, ${z})`,
    }),
  )

  const refl = normal ? [41, 9, 0] : [17, 4, 0]

  return {
    dataset,
    T,
    timeLabels: normal ? ['T+0', 'T+3:40', 'T+7:20', 'T+11:00', 'T+14:41'] : ['T+0', 'T+1:30', 'T+3:00', 'T+4:30', 'T+6:00'],
    rangeLabel: normal ? '2026-07-18 · Normal · T+0 → T+14:41' : '2026-07-18 · Easy · T+0 → T+6:00',
    race: {
      stats: {
        winner: normal ? 'RED · Wren' : 'RED · Elara',
        winnerColor: RED,
        winnerSub: normal ? 'difficulty: Normal — the ADR’s flagship' : 'difficulty: Easy — first honest 3v3',
        winTime: normal ? '14m 41s' : '6m 00.4s',
        winTimeSub: normal ? 'blue led the first two rungs' : 'win event 019f733d-14dd',
        attempt: normal ? '019f7352-03ae…' : '019f7337-977e…',
        redScore: '5/5',
        blueScore: normal ? '3/5' : '2/5',
        honest: 'clean',
        honestSub: '0 budget trips · 0 fake-provider decisions',
        humanInput: '0',
      },
      redT,
      blueT,
      rateRed,
      rateBlue,
      lane,
      collectors,
    },
    map: {
      T,
      clockTotal: normal ? '14:41' : '6:00',
      tracks,
      trailsIllustrative: false,
      milestones,
      spawns: [
        { label: 'RED spawn', x: -64, z: 48 },
        { label: 'BLUE spawn', x: 56, z: -44 },
      ],
      scrubEnabled: true,
    },
    llm: {
      stats: {
        llmCalls: normal ? '352' : '144',
        llmP95: normal ? '12.4 s' : '11.8 s',
        tokTotals: normal ? '631k / 77k' : '259k / 31k',
        spend: '$0.0000',
        breaker: 'CLOSED',
        breakerOpen: false,
        malformed: normal ? '3' : '1',
        normalized: normal ? '349' : '143',
      },
      latSeries: [{ label: 'ollama', color: 'var(--mc-accent)', vals: lat, area: true }],
      tokIn,
      tokOut,
      ticks: [
        { label: 'completed', color: 'var(--mc-accent)', vals: ticksC },
        { label: 'no-op', color: muted(40), vals: ticksN, width: 1.4 },
        { label: 'failed', color: FAIL_RED, vals: ticksF, width: 1.4 },
      ],
      reactive,
      tickDur,
    },
    pipe: {
      stats: {
        evTotal: normal ? '14,832' : '6,904',
        evPeak: normal ? '21.4' : '18.2',
        lagMax: normal ? '3' : '2',
        servicesUp: '4 / 4',
        botSessions: '6',
        sseClients: '2',
        reconnects: '0 reconnects needed',
      },
      throughput: [
        { label: 'world facts', color: 'var(--mc-accent)', vals: evWorld, area: true },
        { label: 'commands', color: muted(40), vals: evCmd, width: 1.4 },
        { label: 'milestones', color: LEGEND_GREEN, vals: evMile, width: 1.4 },
      ],
      lag: [
        { label: 'event-service', color: 'var(--mc-accent)', vals: lagEvt },
        { label: 'agent-service', color: muted(40), vals: lagAgt, width: 1.4 },
      ],
      mem,
      services: SERVICES,
      reflections: [
        { label: 'stored', v: refl[0] },
        { label: 'skipped — no novelty', v: refl[1] },
        { label: 'failed', v: refl[2] },
      ],
      fleetRows: [
        { l: 'civ_bot_reconnects_total', v: '0' },
        { l: 'civ_players_tracked', v: '6' },
        { l: 'inventory polls (ok / failed)', v: normal ? '5,286 / 0' : '2,162 / 0' },
        { l: 'civ_threat_fights_active', v: '0 — no slot leaks' },
      ],
      curlId: DEMO_ATTEMPT_IDS.easy_360s,
      scrapeCol: 'HTTP p95',
    },
  }
}
