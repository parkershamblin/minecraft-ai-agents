import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  type ThreatBot,
  type ThreatPhase,
  type ThreatResponse,
  ThreatWatcher,
  type ThreatWatcherDeps,
  type TrackedHostile,
  dangerRadius,
  decideResponse,
  threatCry,
} from '../src/bots/threat.ts'

const zombie = (over: Partial<TrackedHostile> = {}): TrackedHostile => ({
  id: 7,
  name: 'zombie',
  distance: 20,
  position: { x: 10, y: 64, z: 0 },
  ...over,
})

describe('decideResponse (the fight-or-flee table)', () => {
  const base = {
    nearest: zombie({ distance: 5 }),
    count: 1,
    health: 20,
    armed: true,
    stance: 'brave' as const,
    failedFights: 0,
  }

  it('a creeper is never fought, at any range or stance', () => {
    expect(decideResponse({ ...base, nearest: zombie({ name: 'creeper', distance: 3 }) })).toBe('flee')
    expect(decideResponse({ ...base, nearest: zombie({ name: 'creeper', distance: 20 }) })).toBe('flee')
  })

  it('low health flees regardless of stance or arms', () => {
    expect(decideResponse({ ...base, health: 10 })).toBe('flee')
  })

  it('unarmed flees', () => {
    expect(decideResponse({ ...base, armed: false })).toBe('flee')
  })

  it('outnumbered (count > 2) flees', () => {
    expect(decideResponse({ ...base, count: 3 })).toBe('flee')
  })

  it('a target that already beat you twice is fled (the gather-blacklist mirror)', () => {
    expect(decideResponse({ ...base, failedFights: 2 })).toBe('flee')
  })

  it('a skeleton is fought only at knife range', () => {
    expect(decideResponse({ ...base, nearest: zombie({ name: 'skeleton', distance: 3 }) })).toBe('fight')
    expect(decideResponse({ ...base, nearest: zombie({ name: 'skeleton', distance: 10 }) })).toBe('flee')
  })

  it('melee mobs split on stance: brave fights, cautious flees', () => {
    expect(decideResponse({ ...base, stance: 'brave' })).toBe('fight')
    expect(decideResponse({ ...base, stance: 'cautious' })).toBe('flee')
  })

  it('an unknown hostile is fled — never met, never trusted', () => {
    expect(decideResponse({ ...base, nearest: zombie({ name: 'warden' }) })).toBe('flee')
  })

  it('guard fights melee like brave', () => {
    expect(decideResponse({ ...base, stance: 'guard' })).toBe('fight')
  })

  it('guard widens the skeleton window to 8 — brave stays at 4', () => {
    expect(decideResponse({ ...base, stance: 'guard', nearest: zombie({ name: 'skeleton', distance: 7 }) })).toBe('fight')
    expect(decideResponse({ ...base, stance: 'guard', nearest: zombie({ name: 'skeleton', distance: 9 }) })).toBe('flee')
    expect(decideResponse({ ...base, stance: 'brave', nearest: zombie({ name: 'skeleton', distance: 7 }) })).toBe('flee')
  })

  it('every safety floor holds under guard', () => {
    const guard = { ...base, stance: 'guard' as const }
    expect(decideResponse({ ...guard, nearest: zombie({ name: 'creeper', distance: 3 }) })).toBe('flee')
    expect(decideResponse({ ...guard, health: 10 })).toBe('flee')
    expect(decideResponse({ ...guard, armed: false })).toBe('flee')
    expect(decideResponse({ ...guard, count: 3 })).toBe('flee')
    expect(decideResponse({ ...guard, failedFights: 2 })).toBe('flee')
    expect(decideResponse({ ...guard, nearest: zombie({ name: 'warden' }) })).toBe('flee')
  })

  it('danger radii carry the per-mob overrides', () => {
    expect(dangerRadius('creeper')).toBe(12)
    expect(dangerRadius('skeleton')).toBe(16)
    expect(dangerRadius('zombie')).toBe(10)
  })

  it('cries exist for the dramatic phases and stay quiet on spotted', () => {
    expect(threatCry('engaged', 'zombie', 'flee')).toBe('A zombie! RUN!')
    expect(threatCry('engaged', 'zombie', 'fight')).toContain("I'll deal with this zombie")
    expect(threatCry('overwhelmed', 'zombie', 'flee')).toContain('HELP')
    expect(threatCry('spotted', 'zombie', null)).toBeNull()
  })
})

interface Emitted {
  phase: ThreatPhase
  threatType: string
  response: ThreatResponse | null
  count: number
}

interface Harness {
  watcher: ThreatWatcher
  hostiles: TrackedHostile[]
  farHostiles: TrackedHostile[]
  health: { value: number }
  emitted: Emitted[]
  cries: string[]
  busy: { value: 'action' | 'escape' | 'combat' | 'eat' | null }
  generation: { value: number }
  episodes: string[]
  responses: Array<{ response: string; outcome: string }>
  fight: ReturnType<typeof vi.fn>
  flee: ReturnType<typeof vi.fn>
}

function harness(over: {
  health?: number
  armed?: boolean
  stance?: 'brave' | 'cautious' | 'guard'
  fightOutcome?: 'killed' | 'lost' | 'abandoned' | null
  fleeOutcome?: 'escaped' | 'cornered' | 'abandoned'
  maneuverCooldownMs?: number
} = {}): Harness {
  const hostiles: TrackedHostile[] = []
  const emitted: Emitted[] = []
  const cries: string[] = []
  const busy = { value: null as Harness['busy']['value'] }
  const generation = { value: 1 }
  const episodes: string[] = []
  const responses: Array<{ response: string; outcome: string }> = []
  const health = { value: over.health ?? 20 }
  const farHostiles: TrackedHostile[] = []
  const bot: ThreatBot = {
    alive: true,
    health: () => health.value,
    position: () => ({ x: 0, y: 64, z: 0 }),
    hostiles: () => hostiles,
    allHostiles: () => [...hostiles, ...farHostiles],
    armed: () => over.armed ?? true,
  }
  const fight = vi.fn(async (_targetId: number, _ctx: { abandoned: boolean }) => over.fightOutcome ?? ('killed' as const))
  const flee = vi.fn(async (_ctx: { abandoned: boolean }) => over.fleeOutcome ?? ('escaped' as const))
  const deps: ThreatWatcherDeps = {
    bot: () => bot,
    getBusy: () => busy.value,
    setBusy: (state) => {
      busy.value = state
    },
    hazardOpen: () => false,
    emit: (phase, threatType, response, count) => emitted.push({ phase, threatType, response, count }),
    driver: {
      tryFight: (targetId, ctx) => (over.fightOutcome === null ? null : fight(targetId, ctx)),
      flee: (ctx) => flee(ctx),
    },
    stance: () => over.stance ?? 'cautious',
    cry: (line) => cries.push(line),
    recordEpisode: (outcome) => episodes.push(outcome),
    recordResponse: (response, outcome) => responses.push({ response, outcome }),
    generation: () => generation.value,
    log: { info: () => {}, warn: () => {} },
    // cooldown 0 in the base harness: maneuver-cadence tests drive passes
    // explicitly; the cooldown has its own test below
    config: { alertRadius: 24, maneuverCooldownMs: over.maneuverCooldownMs ?? 0 },
  }
  return { watcher: new ThreatWatcher(deps), hostiles, farHostiles, health, emitted, cries, busy, generation, episodes, responses, fight, flee }
}

async function pass(h: Harness): Promise<void> {
  h.watcher.check()
  await vi.advanceTimersByTimeAsync(0)
}

describe('ThreatWatcher episodes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a quiet world opens nothing', async () => {
    const h = harness()
    await pass(h)
    expect(h.emitted).toEqual([])
    expect(h.watcher.episodeOpen).toBe(false)
  })

  it('alert-range contact needs two passes (debounce); the episode opens with spotted', async () => {
    const h = harness()
    h.hostiles.push(zombie({ distance: 20 }))
    await pass(h)
    expect(h.emitted).toEqual([]) // one pass can be a clipped corner
    await pass(h)
    expect(h.emitted[0]).toMatchObject({ phase: 'spotted', threatType: 'zombie', response: null })
    expect(h.watcher.episodeOpen).toBe(true)
  })

  it('danger-radius contact opens INSTANTLY (a creeper fuse is ~1.5s)', async () => {
    const h = harness()
    h.hostiles.push(zombie({ name: 'creeper', distance: 11 }))
    await pass(h)
    expect(h.emitted[0]).toMatchObject({ phase: 'spotted', threatType: 'creeper' })
  })

  it('cautious default flees a zombie: engaged{flee} emitted, the cry raised, flee driver run', async () => {
    const h = harness({ stance: 'cautious' })
    h.hostiles.push(zombie({ distance: 8 }))
    await pass(h) // spotted (instant — danger radius)
    await pass(h) // maneuver
    expect(h.emitted.map((e) => e.phase)).toEqual(['spotted', 'engaged'])
    expect(h.emitted[1]).toMatchObject({ response: 'flee' })
    expect(h.cries).toContain('A zombie! RUN!')
    expect(h.flee).toHaveBeenCalled()
    expect(h.responses).toEqual([{ response: 'flee', outcome: 'escaped' }])
  })

  it('brave + armed fights: the fight driver runs and a kill closes the episode as killed', async () => {
    const h = harness({ stance: 'brave', fightOutcome: 'killed' })
    h.hostiles.push(zombie({ distance: 8 }))
    await pass(h) // spotted
    await pass(h) // fight maneuver (killed)
    h.hostiles.length = 0 // the corpse is gone
    await pass(h)
    await pass(h)
    await pass(h) // 3 clear passes close
    const phases = h.emitted.map((e) => e.phase)
    expect(phases).toEqual(['spotted', 'engaged', 'killed'])
    expect(h.episodes).toEqual(['killed'])
    expect(h.busy.value).toBeNull()
  })

  it('a guard fights a zombie through the same episode machinery', async () => {
    const h = harness({ stance: 'guard', fightOutcome: 'killed' })
    h.hostiles.push(zombie({ distance: 8 }))
    await pass(h) // spotted
    await pass(h) // fight maneuver (killed)
    h.hostiles.length = 0
    await pass(h)
    await pass(h)
    await pass(h)
    expect(h.emitted.map((e) => e.phase)).toEqual(['spotted', 'engaged', 'killed'])
    expect(h.fight).toHaveBeenCalledTimes(1)
    expect(h.busy.value).toBeNull()
  })

  it('the fleet fight cap downgrades to flee — never queues', async () => {
    const h = harness({ stance: 'brave', fightOutcome: null }) // tryFight returns null = cap full
    h.hostiles.push(zombie({ distance: 8 }))
    await pass(h)
    await pass(h)
    expect(h.flee).toHaveBeenCalled()
    expect(h.responses).toContainEqual({ response: 'fight', outcome: 'cap_downgraded' })
  })

  it('a cornered flee emits overwhelmed once per rate window, episode stays open', async () => {
    const h = harness({ fleeOutcome: 'cornered' })
    h.hostiles.push(zombie({ distance: 8 }))
    await pass(h) // spotted
    await pass(h) // flee → cornered → overwhelmed
    await pass(h) // flee again → cornered → rate-limited, no second overwhelmed
    const phases = h.emitted.map((e) => e.phase)
    expect(phases.filter((p) => p === 'overwhelmed')).toHaveLength(1)
    expect(h.watcher.episodeOpen).toBe(true)
    expect(h.cries.filter((c) => c.includes('HELP'))).toHaveLength(1)
  })

  it('the episode closes escaped after three clear passes with hysteresis', async () => {
    const h = harness()
    h.hostiles.push(zombie({ distance: 8 }))
    await pass(h) // spotted
    h.hostiles.length = 0
    await pass(h)
    await pass(h)
    expect(h.watcher.episodeOpen).toBe(true) // two clear passes are not enough
    await pass(h)
    expect(h.watcher.episodeOpen).toBe(false)
    expect(h.emitted.at(-1)).toMatchObject({ phase: 'escaped' })
    expect(h.episodes).toEqual(['escaped'])
  })

  it('taking damage promotes instantly — even when the vertical band hides the shooter', async () => {
    const h = harness()
    h.farHostiles.push(zombie({ id: 44, name: 'skeleton', distance: 14 })) // a cliff sniper, outside the band
    await pass(h) // baseline health recorded, nothing in the banded view
    expect(h.watcher.episodeOpen).toBe(false)
    h.health.value = 16 // an arrow lands
    await pass(h)
    expect(h.watcher.episodeOpen).toBe(true)
    expect(h.emitted[0]).toMatchObject({ phase: 'spotted', threatType: 'skeleton' })
  })

  it('regen upticks never promote', async () => {
    const h = harness({ health: 16 })
    await pass(h)
    h.health.value = 17 // healing
    await pass(h)
    expect(h.watcher.episodeOpen).toBe(false)
  })

  it('a failed maneuver waits out the cooldown before the next attempt (event-loop economy)', async () => {
    const h = harness({ fleeOutcome: 'cornered', maneuverCooldownMs: 10_000 })
    h.hostiles.push(zombie({ distance: 8 }))
    await pass(h) // spotted
    await pass(h) // first maneuver runs immediately
    expect(h.flee).toHaveBeenCalledTimes(1)
    await pass(h) // inside the cooldown — no new maneuver
    await pass(h)
    expect(h.flee).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_001)
    await pass(h)
    expect(h.flee).toHaveBeenCalledTimes(2) // cooldown over — retry
  })

  it('never claims the body while a command runs — v1 has no preemption', async () => {
    const h = harness()
    h.hostiles.push(zombie({ distance: 8 }))
    await pass(h) // spotted
    h.busy.value = 'action'
    await pass(h)
    expect(h.flee).not.toHaveBeenCalled()
    expect(h.fight).not.toHaveBeenCalled()
  })

  it('a death mid-episode drops it silently (no lying escaped emit)', async () => {
    const h = harness()
    h.hostiles.push(zombie({ distance: 8 }))
    await pass(h) // spotted
    h.generation.value += 1 // death-respawn
    h.hostiles.length = 0
    await pass(h)
    expect(h.watcher.episodeOpen).toBe(false)
    expect(h.emitted.map((e) => e.phase)).toEqual(['spotted']) // no escaped/killed
    expect(h.episodes).toEqual([])
  })

  it('nearbyHostiles caches the last pass grouped by type (the snapshot input)', async () => {
    const h = harness()
    h.hostiles.push(zombie({ id: 1, distance: 12 }), zombie({ id: 2, distance: 18 }), zombie({ id: 3, name: 'skeleton', distance: 20 }))
    await pass(h)
    expect(h.watcher.nearbyHostiles()).toEqual([
      { type: 'zombie', count: 2, nearestDistance: 12 },
      { type: 'skeleton', count: 1, nearestDistance: 20 },
    ])
  })

  it('ThreatEncountered payloads match the committed contract (ajv tripwire)', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../../packages/events/schemas/world/ThreatEncountered.v1.schema.json', import.meta.url), 'utf8'),
    )
    const ajv = new Ajv2020({ allErrors: true })
    addFormats(ajv)
    const validate = ajv.compile(schema)
    for (const [phase, response] of [
      ['spotted', null],
      ['engaged', 'flee'],
      ['killed', 'fight'],
      ['escaped', 'flee'],
      ['overwhelmed', 'flee'],
    ] as const) {
      const payload = {
        villagerId: '019f8e2a-0000-7000-8000-0000000d0007',
        threatType: 'zombie',
        phase,
        response,
        count: 1,
        distance: 9.4,
        position: { x: -131, y: 92, z: 18 },
        detail: null,
      }
      expect(validate(payload), JSON.stringify(validate.errors)).toBe(true)
    }
  })
})
