import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CombatBot,
  FightDriver,
  FightSlots,
  bearingAngleDeg,
  fleeBearing,
  pickWeapon,
} from '../src/bots/combat.ts'
import type { TrackedHostile } from '../src/bots/threat.ts'

const hostileAt = (x: number, z: number, over: Partial<TrackedHostile> = {}): TrackedHostile => ({
  id: over.id ?? 1,
  name: over.name ?? 'zombie',
  distance: Math.hypot(x, z),
  position: { x, y: 64, z },
  ...over,
})

describe('FightSlots (the fleet-wide cap)', () => {
  it('admits up to max and releases', () => {
    const slots = new FightSlots(2)
    expect(slots.tryAcquire()).toBe(true)
    expect(slots.tryAcquire()).toBe(true)
    expect(slots.tryAcquire()).toBe(false) // overflow downgrades, never queues
    slots.release()
    expect(slots.tryAcquire()).toBe(true)
  })

  it('max 0 is the flee-only fleet (rollout stage 1)', () => {
    expect(new FightSlots(0).tryAcquire()).toBe(false)
  })
})

describe('pickWeapon', () => {
  it('best carried tier wins; fists lose to everything', () => {
    expect(pickWeapon(['stone_sword', 'wooden_axe', 'bread'])).toBe('stone_sword')
    expect(pickWeapon(['wooden_axe'])).toBe('wooden_axe')
    expect(pickWeapon(['bread'])).toBeNull()
  })
})

describe('fleeBearing (pure geometry)', () => {
  it('points directly away from a lone hostile', () => {
    const bearing = fleeBearing({ x: 0, y: 64, z: 0 }, [hostileAt(10, 0)], [], 0)
    expect(bearing.x).toBeCloseTo(-1)
    expect(bearing.z).toBeCloseTo(0)
  })

  it('deflects ±90° when a second hostile blocks the escape line', () => {
    const origin = { x: 0, y: 64, z: 0 }
    const bearing = fleeBearing(origin, [hostileAt(10, 0), hostileAt(-8, 0, { id: 2 })], [], 0)
    // straight away is -x, but a second zombie sits there — expect a sideways turn
    expect(Math.abs(bearing.z)).toBeGreaterThan(0.9)
  })

  it('bends toward a buddy inside the 60° cone (fleeing INTO the village)', () => {
    const origin = { x: 0, y: 64, z: 0 }
    // away-vector is -x; the buddy sits at (-20, -5): inside the cone
    const bearing = fleeBearing(origin, [hostileAt(10, 0)], [{ x: -20, y: 64, z: -5 }], 32)
    expect(bearing.x).toBeLessThan(0)
    expect(bearing.z).toBeLessThan(0) // pulled toward the buddy's side
  })

  it('ignores buddies outside the cone or radius', () => {
    const origin = { x: 0, y: 64, z: 0 }
    const behindHostile = fleeBearing(origin, [hostileAt(10, 0)], [{ x: 20, y: 64, z: 0 }], 32)
    expect(behindHostile.x).toBeCloseTo(-1) // the buddy is behind the zombie — never run there
    const tooFar = fleeBearing(origin, [hostileAt(10, 0)], [{ x: -50, y: 64, z: 0 }], 32)
    expect(tooFar.x).toBeCloseTo(-1)
  })

  it('buddyRadius 0 disables the bias', () => {
    const bearing = fleeBearing({ x: 0, y: 64, z: 0 }, [hostileAt(10, 0)], [{ x: -20, y: 64, z: -5 }], 0)
    expect(bearing.z).toBeCloseTo(0)
  })

  it('bearingAngleDeg measures turn size for the repath gate', () => {
    expect(bearingAngleDeg({ x: 1, z: 0 }, { x: 0, z: 1 })).toBeCloseTo(90)
    expect(bearingAngleDeg({ x: 1, z: 0 }, { x: 1, z: 0 })).toBeCloseTo(0)
  })
})

interface BotState {
  hostiles: TrackedHostile[]
  position: { x: number; y: number; z: number }
  food: number
  attacks: number[]
  goals: string[]
  sprint: boolean[]
}

function combatBot(state: BotState): CombatBot {
  return {
    alive: true,
    food: () => state.food,
    position: () => state.position,
    hostileById: (id) => state.hostiles.find((h) => h.id === id) ?? null,
    hostiles: () => state.hostiles,
    villagers: () => [],
    equipWeapon: async () => {},
    carried: () => ['stone_sword'],
    setGoalFollow: (id, range) => state.goals.push(`follow:${id}:${range}`),
    setGoalXZ: (x, z) => state.goals.push(`xz:${Math.round(x)},${Math.round(z)}`),
    clearGoal: () => state.goals.push('clear'),
    lookAt: () => {},
    attack: (id) => state.attacks.push(id),
    setSprint: (v) => state.sprint.push(v),
  }
}

describe('FightDriver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const config = { fightTimeoutMs: 15_000, fleeTimeoutMs: 12_000, buddyRadius: 32 }

  it('fight: swings at full-charge spacing while in reach, kill detected when the entity vanishes close-in', async () => {
    const state: BotState = {
      hostiles: [hostileAt(2, 0, { id: 9, distance: 2 })],
      position: { x: 0, y: 64, z: 0 },
      food: 20,
      attacks: [],
      goals: [],
      sprint: [],
    }
    const driver = new FightDriver(() => combatBot(state), new FightSlots(4), { info: () => {}, warn: () => {} }, config)
    const ctx = { abandoned: false }
    const fight = driver.tryFight(9, ctx)!
    await vi.advanceTimersByTimeAsync(700) // ≥1 swing in
    state.hostiles.length = 0 // it died
    await vi.advanceTimersByTimeAsync(300)
    await expect(fight).resolves.toBe('killed')
    expect(state.attacks.length).toBeGreaterThanOrEqual(1)
    expect(state.goals[0]).toBe('follow:9:2')
    expect(state.goals.at(-1)).toBe('clear')
  })

  it('fight: swing spacing never dips below 650ms (full-charge damage)', async () => {
    const state: BotState = {
      hostiles: [hostileAt(2, 0, { id: 9, distance: 2 })],
      position: { x: 0, y: 64, z: 0 },
      food: 20,
      attacks: [],
      goals: [],
      sprint: [],
    }
    const driver = new FightDriver(() => combatBot(state), new FightSlots(4), { info: () => {}, warn: () => {} }, config)
    const ctx = { abandoned: false }
    const fight = driver.tryFight(9, ctx)!
    await vi.advanceTimersByTimeAsync(1_300) // 1.3s at 250ms polls
    ctx.abandoned = true
    await vi.advanceTimersByTimeAsync(300)
    await fight
    expect(state.attacks.length).toBeLessThanOrEqual(3) // ~1.3s / 650ms ≈ 2 swings, never 5
  })

  it('fight: the timeout ends it as lost (the target beat the clock)', async () => {
    const state: BotState = {
      hostiles: [hostileAt(10, 0, { id: 9, distance: 10 })], // never in reach
      position: { x: 0, y: 64, z: 0 },
      food: 20,
      attacks: [],
      goals: [],
      sprint: [],
    }
    const driver = new FightDriver(() => combatBot(state), new FightSlots(4), { info: () => {}, warn: () => {} }, config)
    const fight = driver.tryFight(9, { abandoned: false })!
    await vi.advanceTimersByTimeAsync(15_100)
    await expect(fight).resolves.toBe('lost')
    expect(state.attacks).toEqual([])
  })

  it('flee: escapes once the nearest hostile falls beyond alert + hysteresis', async () => {
    const state: BotState = {
      hostiles: [hostileAt(10, 0, { id: 9, distance: 10 })],
      position: { x: 0, y: 64, z: 0 },
      food: 20,
      attacks: [],
      goals: [],
      sprint: [],
    }
    const driver = new FightDriver(() => combatBot(state), new FightSlots(4), { info: () => {}, warn: () => {} }, config)
    const flee = driver.flee({ abandoned: false })
    await vi.advanceTimersByTimeAsync(300)
    expect(state.goals.some((g) => g.startsWith('xz:'))).toBe(true) // a flee goal was set
    expect(state.sprint).toContain(true) // well-fed = sprint
    state.hostiles[0] = hostileAt(40, 0, { id: 9, distance: 40 }) // outran it
    await vi.advanceTimersByTimeAsync(300)
    await expect(flee).resolves.toBe('escaped')
    expect(state.sprint.at(-1)).toBe(false) // sprint released
  })

  it('flee: a starving villager flees at a walk (sprint burns food it lacks)', async () => {
    const state: BotState = {
      hostiles: [hostileAt(10, 0, { id: 9, distance: 10 })],
      position: { x: 0, y: 64, z: 0 },
      food: 4,
      attacks: [],
      goals: [],
      sprint: [],
    }
    const driver = new FightDriver(() => combatBot(state), new FightSlots(4), { info: () => {}, warn: () => {} }, config)
    const flee = driver.flee({ abandoned: false })
    await vi.advanceTimersByTimeAsync(300)
    expect(state.sprint[0]).toBe(false)
    state.hostiles.length = 0
    await vi.advanceTimersByTimeAsync(300)
    await flee
  })

  it('flee: cornered (no progress) ends with a bounded flail at whatever is in reach', async () => {
    const state: BotState = {
      hostiles: [hostileAt(2, 0, { id: 9, distance: 2 })],
      position: { x: 0, y: 64, z: 0 }, // never moves — walled in
      food: 20,
      attacks: [],
      goals: [],
      sprint: [],
    }
    const driver = new FightDriver(() => combatBot(state), new FightSlots(4), { info: () => {}, warn: () => {} }, config)
    const flee = driver.flee({ abandoned: false })
    // The window is deliberately wider than the pathfinder think budget —
    // a slow path start must never read as cornered (first-night lesson).
    await vi.advanceTimersByTimeAsync(6_000)
    expect(state.attacks).toEqual([]) // still patient
    await vi.advanceTimersByTimeAsync(1_600)
    await expect(flee).resolves.toBe('cornered')
    expect(state.attacks).toEqual([9]) // the flail — one honest swing, not a pretend escape
  })

  it('abandonment (the watchdog lever) silences either maneuver within one poll', async () => {
    const state: BotState = {
      hostiles: [hostileAt(10, 0, { id: 9, distance: 10 })],
      position: { x: 0, y: 64, z: 0 },
      food: 20,
      attacks: [],
      goals: [],
      sprint: [],
    }
    const driver = new FightDriver(() => combatBot(state), new FightSlots(4), { info: () => {}, warn: () => {} }, config)
    const ctx = { abandoned: false }
    const flee = driver.flee(ctx)
    await vi.advanceTimersByTimeAsync(300)
    ctx.abandoned = true
    await vi.advanceTimersByTimeAsync(300)
    await expect(flee).resolves.toBe('abandoned')
  })

  it('the cap releases its slot even when the fight crashes', async () => {
    const slots = new FightSlots(1)
    const state: BotState = {
      hostiles: [],
      position: { x: 0, y: 64, z: 0 },
      food: 20,
      attacks: [],
      goals: [],
      sprint: [],
    }
    const bot = combatBot(state)
    bot.equipWeapon = async () => {
      throw new Error('equip raced a death')
    }
    const driver = new FightDriver(() => bot, slots, { info: () => {}, warn: () => {} }, config)
    const fight = driver.tryFight(9, { abandoned: false })!
    await vi.advanceTimersByTimeAsync(300)
    await fight // entity gone instantly → 'lost' (no swings)
    expect(slots.tryAcquire()).toBe(true) // the slot came back
  })
})
