import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ARMOR_FAILURE_BLACKLIST_MS,
  type ArmorBot,
  type ArmorSlot,
  ArmorWatcher,
  type ArmorWatcherDeps,
  armorRank,
  planArmorUpgrade,
} from '../src/bots/armor.ts'

const noBlacklist = new Map<string, number>()

describe('armorRank + planArmorUpgrade (the pure dressing table)', () => {
  it('ranks tiers best-first and rejects armor it has never met', () => {
    expect(armorRank('netherite_helmet', 'head')).toBe(0)
    expect(armorRank('iron_chestplate', 'torso')).toBe(2)
    expect(armorRank('leather_boots', 'feet')).toBe(5)
    expect(armorRank('turtle_helmet', 'head')).toBeNull() // never met, never worn
    expect(armorRank('iron_chestplate', 'head')).toBeNull() // wrong slot
    expect(armorRank('iron_sword', 'torso')).toBeNull()
  })

  it('picks the single best upgrade in head→feet order', () => {
    const upgrade = planArmorUpgrade(
      ['iron_boots', 'iron_helmet', 'diamond_helmet'],
      () => null,
      noBlacklist,
      0,
    )
    expect(upgrade).toEqual({ slot: 'head', item: 'diamond_helmet' })
  })

  it('skips equal-or-better equipped (the dedupe)', () => {
    const equipped = (slot: ArmorSlot) => (slot === 'torso' ? 'iron_chestplate' : null)
    expect(planArmorUpgrade(['iron_chestplate'], equipped, noBlacklist, 0)).toBeNull()
    expect(planArmorUpgrade(['leather_chestplate'], equipped, noBlacklist, 0)).toBeNull()
    expect(planArmorUpgrade(['diamond_chestplate'], equipped, noBlacklist, 0)).toEqual({
      slot: 'torso',
      item: 'diamond_chestplate',
    })
  })

  it('respects the failure blacklist until it expires', () => {
    const blacklist = new Map([['iron_helmet', 5000]])
    expect(planArmorUpgrade(['iron_helmet'], () => null, blacklist, 4999)).toBeNull()
    expect(planArmorUpgrade(['iron_helmet'], () => null, blacklist, 5000)).toEqual({
      slot: 'head',
      item: 'iron_helmet',
    })
  })
})

describe('ArmorWatcher (the reflex)', () => {
  interface Rig {
    watcher: ArmorWatcher
    state: {
      carried: string[]
      equipped: Map<ArmorSlot, string>
      busy: string | null
      generation: number
      equips: Array<{ item: string; dest: string }>
      equipBehavior: 'ok' | 'throw' | 'hang'
      recorded: Array<{ slot: string; outcome: string }>
    }
  }

  function rig(over: Partial<Rig['state']> = {}): Rig {
    const state: Rig['state'] = {
      carried: [],
      equipped: new Map(),
      busy: null,
      generation: 1,
      equips: [],
      equipBehavior: 'ok',
      recorded: [],
      ...over,
    }
    const bot: ArmorBot = {
      alive: true,
      carried: () => state.carried,
      equipped: (slot) => state.equipped.get(slot) ?? null,
      equip: async (item, dest) => {
        state.equips.push({ item, dest })
        if (state.equipBehavior === 'throw') {
          throw new Error('inventory transaction rejected')
        }
        if (state.equipBehavior === 'hang') {
          await new Promise(() => {}) // never settles — the raced-timeout case
        }
        state.equipped.set(dest, item)
      },
    }
    const deps: ArmorWatcherDeps = {
      bot: () => bot,
      getBusy: () => state.busy,
      generation: () => state.generation,
      recordEquip: (slot, outcome) => state.recorded.push({ slot, outcome }),
      log: { info: () => {}, warn: () => {} },
      config: { equipTimeoutMs: 5000 },
    }
    return { watcher: new ArmorWatcher(deps), state }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('equips one piece per pass and records it', async () => {
    const { watcher, state } = rig({ carried: ['iron_helmet', 'iron_boots'] })
    watcher.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.equips).toEqual([{ item: 'iron_helmet', dest: 'head' }])
    expect(state.recorded).toEqual([{ slot: 'head', outcome: 'equipped' }])
    watcher.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.equips).toHaveLength(2) // the boots follow on the next pass
  })

  it('stays out of a claimed body but dresses through open episodes', async () => {
    // Busy-gate ONLY (drill lesson: a 17-minute siege held the old
    // threatOpen gate closed at 1 HP with a helmet in the bag — an open
    // episode is exactly when armor matters; maneuvers hold busy='combat').
    const claimed = rig({ carried: ['iron_helmet'], busy: 'action' })
    claimed.watcher.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(claimed.state.equips).toEqual([])

    const fighting = rig({ carried: ['iron_helmet'], busy: 'combat' })
    fighting.watcher.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(fighting.state.equips).toEqual([]) // a maneuver owns the body

    const betweenManeuvers = rig({ carried: ['iron_helmet'] }) // episode open, busy null
    betweenManeuvers.watcher.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(betweenManeuvers.state.equips).toEqual([{ item: 'iron_helmet', dest: 'head' }])
  })

  it('a hung equip times out, records timeout, and blacklists the piece', async () => {
    const { watcher, state } = rig({ carried: ['iron_helmet'], equipBehavior: 'hang' })
    watcher.check()
    await vi.advanceTimersByTimeAsync(5001)
    expect(state.recorded).toEqual([{ slot: 'head', outcome: 'timeout' }])
    // blacklisted: the next pass plans nothing
    watcher.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.equips).toHaveLength(1)
    // expiry: the piece is tried again
    await vi.advanceTimersByTimeAsync(ARMOR_FAILURE_BLACKLIST_MS)
    watcher.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.equips).toHaveLength(2)
  })

  it('a throwing equip records failed and blacklists', async () => {
    const { watcher, state } = rig({ carried: ['iron_helmet'], equipBehavior: 'throw' })
    watcher.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.recorded).toEqual([{ slot: 'head', outcome: 'failed' }])
  })

  it('a death mid-equip records nothing (the spawn-generation honesty rule)', async () => {
    const { watcher, state } = rig({ carried: ['iron_helmet'], equipBehavior: 'hang' })
    watcher.check()
    state.generation = 2 // died and respawned while the equip hung
    await vi.advanceTimersByTimeAsync(5001)
    expect(state.recorded).toEqual([])
  })
})
