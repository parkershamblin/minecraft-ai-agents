import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { type EatBot, type EatOutcome, EatWatcher, type EatWatcherDeps, pickFood } from '../src/bots/eat.ts'

const CONFIG = {
  foodThreshold: 14,
  criticalFood: 6,
  recoverFood: 10,
  hurtHealthThreshold: 14,
  eatTimeoutMs: 8_000,
  retryMs: 10_000,
  bannedFoods: new Set(['pufferfish', 'spider_eye', 'poisonous_potato', 'chorus_fruit']),
  desperationFoods: new Set(['rotten_flesh']),
}

describe('pickFood', () => {
  const opts = (over: Partial<Parameters<typeof pickFood>[1]> = {}) => ({
    starving: false,
    bannedFoods: CONFIG.bannedFoods,
    desperationFoods: CONFIG.desperationFoods,
    blacklist: new Map<string, number>(),
    now: 1_000,
    ...over,
  })

  it('ranks by food points, name as the tie-break', () => {
    const carried = [
      { name: 'bread', foodPoints: 5 },
      { name: 'cooked_beef', foodPoints: 8 },
      { name: 'apple', foodPoints: 4 },
    ]
    expect(pickFood(carried, opts())?.name).toBe('cooked_beef')
  })

  it('never picks banned foods', () => {
    expect(pickFood([{ name: 'pufferfish', foodPoints: 1 }], opts())).toBeNull()
  })

  it('desperation foods unlock only at the starving tier', () => {
    const carried = [{ name: 'rotten_flesh', foodPoints: 4 }]
    expect(pickFood(carried, opts({ starving: false }))).toBeNull()
    expect(pickFood(carried, opts({ starving: true }))).toMatchObject({ name: 'rotten_flesh', desperate: true })
  })

  it('recently failed items stay off the menu until their blacklist expires', () => {
    const carried = [{ name: 'bread', foodPoints: 5 }]
    const blacklist = new Map([['bread', 2_000]])
    expect(pickFood(carried, opts({ blacklist, now: 1_500 }))).toBeNull()
    expect(pickFood(carried, opts({ blacklist, now: 2_500 }))?.name).toBe('bread')
  })
})

interface Harness {
  watcher: EatWatcher
  bot: EatBot & { setFood(v: number): void; setHealth(v: number): void }
  outcomes: EatOutcome[]
  crises: Array<{ phase: string; detail: string | null }>
  busy: { value: 'action' | 'escape' | 'combat' | 'eat' | null }
  generation: { value: number }
  consumed: string[]
}

function harness(over: {
  food?: number
  health?: number
  carried?: Array<{ name: string; foodPoints: number }>
  consumeGain?: number
  consume?: () => Promise<void>
  hazardOpen?: boolean
  threatOpen?: boolean
} = {}): Harness {
  let food = over.food ?? 20
  let health = over.health ?? 20
  const outcomes: EatOutcome[] = []
  const crises: Array<{ phase: string; detail: string | null }> = []
  const busy = { value: null as Harness['busy']['value'] }
  const generation = { value: 1 }
  const consumed: string[] = []
  const bot = {
    alive: true,
    health: () => health,
    food: () => food,
    position: () => ({ x: 0, y: 64, z: 0 }),
    carriedFood: () => over.carried ?? [{ name: 'bread', foodPoints: 5 }],
    equipFood: async (name: string) => {
      consumed.push(`equip:${name}`)
    },
    consume:
      over.consume ??
      (async () => {
        consumed.push('consume')
        food = Math.min(20, food + (over.consumeGain ?? 5))
      }),
    setFood: (v: number) => {
      food = v
    },
    setHealth: (v: number) => {
      health = v
    },
  }
  const deps: EatWatcherDeps = {
    bot: () => bot,
    getBusy: () => busy.value,
    setBusy: (state) => {
      busy.value = state
    },
    hazardOpen: () => over.hazardOpen ?? false,
    threatOpen: () => over.threatOpen ?? false,
    emitCrisis: (phase, _position, detail) => crises.push({ phase, detail }),
    record: (outcome) => outcomes.push(outcome),
    generation: () => generation.value,
    log: { info: () => {}, warn: () => {} },
    config: CONFIG,
  }
  return { watcher: new EatWatcher(deps), bot, outcomes, crises, busy, generation, consumed }
}

/** run one check() and let its async attempt settle */
async function pass(h: Harness): Promise<void> {
  h.watcher.check()
  await vi.advanceTimersByTimeAsync(0)
}

describe('EatWatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a full villager never eats', async () => {
    const h = harness({ food: 20 })
    await pass(h)
    expect(h.consumed).toEqual([])
    expect(h.outcomes).toEqual([])
  })

  it('peckish (food ≤ threshold) eats the best carried food and records ate', async () => {
    const h = harness({ food: 12 })
    await pass(h)
    expect(h.consumed).toEqual(['equip:bread', 'consume'])
    expect(h.outcomes).toEqual(['ate'])
    expect(h.busy.value).toBeNull() // claim released
  })

  it('hurt below the regen gate eats even when not peckish (the not-slain loop)', async () => {
    const h = harness({ food: 16, health: 8 })
    await pass(h)
    expect(h.outcomes).toEqual(['ate'])
  })

  it('hurt but food at the regen gate does not eat (nothing to restart)', async () => {
    const h = harness({ food: 18, health: 8 })
    await pass(h)
    expect(h.outcomes).toEqual([])
  })

  it('never claims the body while a command runs, a hazard episode is open, or a threat episode is open', async () => {
    const busyH = harness({ food: 5 })
    busyH.busy.value = 'action'
    await pass(busyH)
    expect(busyH.consumed).toEqual([])

    const hazardH = harness({ food: 5, hazardOpen: true })
    await pass(hazardH)
    expect(hazardH.consumed).toEqual([])

    const threatH = harness({ food: 5, threatOpen: true })
    await pass(threatH)
    expect(threatH.consumed).toEqual([])
  })

  it('starving with rotten flesh chokes it down and records ate_desperate', async () => {
    const h = harness({ food: 4, carried: [{ name: 'rotten_flesh', foodPoints: 4 }] })
    await pass(h)
    expect(h.outcomes).toEqual(['ate_desperate'])
  })

  it('a consume that moves nothing is no_effect and blacklists the item (ghost-dig honesty)', async () => {
    const h = harness({ food: 12, consumeGain: 0 })
    await pass(h)
    expect(h.outcomes).toEqual(['no_effect'])
    // next pass: bread is blacklisted, nothing else carried → no new attempt
    await pass(h)
    expect(h.outcomes).toEqual(['no_effect'])
  })

  it('a consume that never settles times out, releases the claim, and the wedge never freezes the watcher', async () => {
    const h = harness({ food: 12, consume: () => new Promise<never>(() => {}) })
    h.watcher.check()
    await vi.advanceTimersByTimeAsync(8_001)
    expect(h.outcomes).toEqual(['timeout'])
    expect(h.busy.value).toBeNull()
  })

  it('starving with an empty pantry opens the crisis ONCE (trapped), and recovery closes it (escaped)', async () => {
    const h = harness({ food: 4, carried: [] })
    await pass(h)
    await pass(h)
    expect(h.crises).toHaveLength(1)
    expect(h.crises[0]).toMatchObject({ phase: 'trapped' })
    expect(h.crises[0]!.detail).toContain('nothing edible carried')
    // food recovers past the hysteresis point (someone shared bread, say)
    h.bot.setFood(12)
    await pass(h)
    expect(h.crises).toHaveLength(2)
    expect(h.crises[1]).toMatchObject({ phase: 'escaped' })
  })

  it('merely peckish with an empty pantry does NOT open a crisis (the directive owns acquisition)', async () => {
    const h = harness({ food: 12, carried: [] })
    await pass(h)
    expect(h.crises).toEqual([])
  })

  it('a death mid-crisis drops the episode silently — no lying recovery emit', async () => {
    const h = harness({ food: 4, carried: [] })
    await pass(h)
    expect(h.crises).toHaveLength(1)
    h.generation.value += 1 // death-respawn: fresh body, food 20
    h.bot.setFood(20)
    await pass(h)
    expect(h.crises).toHaveLength(1) // no 'escaped' — the recovery never happened
  })

  it('the starvation crisis payload matches the committed HazardEncountered contract', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../../packages/events/schemas/world/HazardEncountered.v1.schema.json', import.meta.url), 'utf8'),
    )
    const ajv = new Ajv2020({ allErrors: true })
    addFormats(ajv)
    const validate = ajv.compile(schema)
    const payload = {
      villagerId: '019f8e2a-0000-7000-8000-0000000d0004',
      hazardType: 'starvation',
      phase: 'trapped',
      position: { x: -98, y: 95, z: -71 },
      detail: 'food 4/20 and nothing edible carried — the eat reflex is helpless until food is acquired',
    }
    expect(validate(payload)).toBe(true)
  })
})
