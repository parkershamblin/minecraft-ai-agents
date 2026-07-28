import { describe, expect, it } from 'vitest'
import {
  FURNACE_SEARCH_DISTANCE,
  SMELT_BUDGET_PER_ITEM_MS,
  SMELT_POLL_INTERVAL_MS,
  smeltItem,
  type FurnaceHandle,
  type SmeltItemDeps,
} from '../src/skills/primitives/smeltItem.ts'
import { guardedItem, type McDataLike } from '../src/skills/names.ts'
import type { SkillInvocationContext } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'plains',
  timeOfDay: 6000,
  heldTool: null,
  hostileCount: 0,
  position: { x: 0, y: 64, z: 0 },
}

const RAW_IRON = 1
const COAL = 2

const mcData: McDataLike = {
  itemsByName: {
    raw_iron: { id: RAW_IRON, name: 'raw_iron' },
    coal: { id: COAL, name: 'coal' },
  },
  blocksByName: {},
}

/** Injected time: sleep() advances the clock — no real timers anywhere. */
function fakeClock(start = 0) {
  let t = start
  let sleeps = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps += 1
      t += ms
    },
    sleepCount: () => sleeps,
  }
}

/** Villager pack: countInventory reads it, the furnace sim consumes from it. */
function fakeInventory(initial: Record<number, number>) {
  const counts = new Map<number, number>(Object.entries(initial).map(([id, n]) => [Number(id), n]))
  return {
    count: (id: number) => counts.get(id) ?? 0,
    remove: (id: number, n: number) => {
      counts.set(id, Math.max(0, (counts.get(id) ?? 0) - n))
    },
  }
}

interface FurnaceSimOptions {
  /** ms one item takes to cook (vanilla 10s) */
  cookMs?: number
  /** how many inputs EVER finish cooking — simulates the fire dying */
  maxCooked?: number
}

/** Clock-driven furnace: inputs cook serially, outputs become visible to
 *  outputCount() when their readyAt passes; indices past maxCooked never
 *  finish. putInput consumes from the villager pack like the real screen. */
function fakeFurnace(
  clk: ReturnType<typeof fakeClock>,
  inv: ReturnType<typeof fakeInventory>,
  opts: FurnaceSimOptions = {},
) {
  const cookMs = opts.cookMs ?? 10_000
  const maxCooked = opts.maxCooked ?? Number.POSITIVE_INFINITY
  const readyAt: number[] = []
  let lastReady = Number.NEGATIVE_INFINITY
  let taken = 0
  let closed = 0
  let fuelPuts = 0
  const ready = () => {
    let n = 0
    for (let i = taken; i < readyAt.length && i < maxCooked; i++) {
      if (readyAt[i]! <= clk.now()) n++
    }
    return n
  }
  const handle: FurnaceHandle = {
    putInput: async (id, count) => {
      inv.remove(id, count)
      for (let i = 0; i < count; i++) {
        const startAt = Math.max(clk.now(), lastReady)
        lastReady = startAt + cookMs
        readyAt.push(lastReady)
      }
    },
    putFuel: async (id, count) => {
      fuelPuts += 1
      inv.remove(id, count)
    },
    outputCount: ready,
    takeOutput: async () => {
      taken += ready()
    },
    close: async () => {
      closed += 1
    },
  }
  return {
    handle,
    closedCount: () => closed,
    fuelPutCount: () => fuelPuts,
  }
}

function makeDeps(
  clk: ReturnType<typeof fakeClock>,
  inv: ReturnType<typeof fakeInventory>,
  handle: FurnaceHandle,
  overrides: Partial<SmeltItemDeps> = {},
): SmeltItemDeps {
  return {
    resolveItem: (name) => guardedItem(mcData, name),
    findFurnace: () => ({ x: 10, y: 64, z: -3 }),
    gotoBlock: async () => true,
    openFurnace: async () => handle,
    countInventory: (id) => inv.count(id),
    now: clk.now,
    sleep: clk.sleep,
    ...overrides,
  }
}

describe('smeltItem primitive', () => {
  it('smelts the full count and reports honest output (happy path)', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 5, [COAL]: 3 })
    const furnace = fakeFurnace(clk, inv)
    const deps = makeDeps(clk, inv, furnace.handle)

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal', count: 3 }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.smelted).toBe(3)
      // serial cooking: 3 items x 10s, found by the ~1s poll
      expect(r.costMs).toBeGreaterThanOrEqual(30_000)
      expect(r.costMs).toBeLessThan(3 * SMELT_BUDGET_PER_ITEM_MS)
    }
    expect(furnace.closedCount()).toBe(1)
    expect(furnace.fuelPutCount()).toBeGreaterThanOrEqual(1)
  })

  it('POLLS the output slot instead of Voyager 12s-per-item hard wait', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 1, [COAL]: 1 })
    // cooks in 2s — a hard 12s wait would sit on a done item for 10 more
    const furnace = fakeFurnace(clk, inv, { cookMs: 2_000 })
    const deps = makeDeps(clk, inv, furnace.handle)

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.smelted).toBe(1)
      // taken within a poll interval of readiness, far under the 12s hard wait
      expect(r.costMs).toBeLessThanOrEqual(2_000 + 2 * SMELT_POLL_INTERVAL_MS)
      expect(r.costMs).toBeLessThan(12_000)
    }
    // and it actually polled (slept in ~1s steps) rather than one long wait
    expect(clk.sleepCount()).toBeGreaterThanOrEqual(2)
  })

  it('timeout with partial output is ok:true with smelted < count', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 5, [COAL]: 3 })
    // the fire dies after one item — the other inputs never finish
    const furnace = fakeFurnace(clk, inv, { maxCooked: 1 })
    const deps = makeDeps(clk, inv, furnace.handle)

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal', count: 3 }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.smelted).toBe(1)
      // it held on until the overall budget before settling for the partial
      expect(r.costMs).toBeGreaterThanOrEqual(3 * SMELT_BUDGET_PER_ITEM_MS)
    }
    expect(furnace.closedCount()).toBe(1)
  })

  it('timeout with zero output is TIMEOUT, and the furnace still closes', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 2, [COAL]: 2 })
    const furnace = fakeFurnace(clk, inv, { maxCooked: 0 })
    const deps = makeDeps(clk, inv, furnace.handle)

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TIMEOUT')
      expect(r.detail).toContain('raw_iron')
      expect(r.costMs).toBeGreaterThanOrEqual(SMELT_BUDGET_PER_ITEM_MS)
    }
    expect(furnace.closedCount()).toBe(1)
  })

  it('returns the early honest partial when input runs out before the count', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 2, [COAL]: 3 })
    const furnace = fakeFurnace(clk, inv)
    const deps = makeDeps(clk, inv, furnace.handle)

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal', count: 5 }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.smelted).toBe(2)
      // early exit: nothing cooking + nothing loadable, well before the 75s budget
      expect(r.costMs).toBeLessThan(5 * SMELT_BUDGET_PER_ITEM_MS)
    }
  })

  it('no furnace in range is RESOURCE_NOT_FOUND naming the furnace', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 1, [COAL]: 1 })
    const furnace = fakeFurnace(clk, inv)
    const deps = makeDeps(clk, inv, furnace.handle, { findFurnace: () => null })

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('RESOURCE_NOT_FOUND')
      expect(r.detail).toContain('furnace')
      expect(r.detail).toContain(String(FURNACE_SEARCH_DISTANCE))
    }
  })

  it('a furnace that will not open is RESOURCE_NOT_FOUND too', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 1, [COAL]: 1 })
    const furnace = fakeFurnace(clk, inv)
    const deps = makeDeps(clk, inv, furnace.handle, { openFurnace: async () => null })

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('RESOURCE_NOT_FOUND')
      expect(r.detail).toContain('furnace')
    }
  })

  it('no path to the furnace is PATH_NOT_FOUND', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 1, [COAL]: 1 })
    const furnace = fakeFurnace(clk, inv)
    const deps = makeDeps(clk, inv, furnace.handle, { gotoBlock: async () => false })

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('PATH_NOT_FOUND')
  })

  it('no input in the pack is MISSING_MATERIALS before the body moves', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [COAL]: 3 })
    const furnace = fakeFurnace(clk, inv)
    let walked = false
    const deps = makeDeps(clk, inv, furnace.handle, {
      gotoBlock: async () => {
        walked = true
        return true
      },
    })

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toContain('raw_iron')
    }
    expect(walked).toBe(false)
  })

  it('no fuel in the pack is MISSING_MATERIALS naming the fuel', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 3 })
    const furnace = fakeFurnace(clk, inv)
    const deps = makeDeps(clk, inv, furnace.handle)

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toContain('coal')
    }
  })

  it('input vanishing between the pre-check and the furnace opening is MISSING_MATERIALS, not TIMEOUT', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 1, [COAL]: 1 })
    const furnace = fakeFurnace(clk, inv)
    const deps = makeDeps(clk, inv, furnace.handle, {
      // the world shifts during the walk: the raw iron is gone on arrival
      gotoBlock: async () => {
        inv.remove(RAW_IRON, 1)
        return true
      },
    })

    const r = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'coal' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toContain('raw_iron')
    }
    expect(furnace.closedCount()).toBe(1)
  })

  it('unknown item and fuel names are UNSUPPORTED_NAME, never a throw', async () => {
    const clk = fakeClock()
    const inv = fakeInventory({ [RAW_IRON]: 1, [COAL]: 1 })
    const furnace = fakeFurnace(clk, inv)
    const deps = makeDeps(clk, inv, furnace.handle)

    const badItem = await smeltItem(deps, { itemName: 'unobtanium', fuelName: 'coal' }, ctx)
    expect(badItem.ok).toBe(false)
    if (!badItem.ok) {
      expect(badItem.failureCode).toBe('UNSUPPORTED_NAME')
      expect(badItem.detail).toContain('unobtanium')
    }

    const badFuel = await smeltItem(deps, { itemName: 'raw_iron', fuelName: 'phlogiston' }, ctx)
    expect(badFuel.ok).toBe(false)
    if (!badFuel.ok) {
      expect(badFuel.failureCode).toBe('UNSUPPORTED_NAME')
      expect(badFuel.detail).toContain('phlogiston')
    }
  })
})
