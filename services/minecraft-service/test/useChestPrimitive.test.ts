import { describe, expect, it } from 'vitest'
import {
  CHEST_SEARCH_DISTANCE,
  checkItemInsideChest,
  depositItemIntoChest,
  getItemFromChest,
  type ChestHandle,
  type UseChestDeps,
} from '../src/skills/primitives/useChest.ts'
import { guardedItem, type McDataLike } from '../src/skills/names.ts'
import type { SkillInvocationContext, SkillPosition } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'plains',
  timeOfDay: 6000,
  heldTool: null,
  hostileCount: 0,
  position: { x: 0, y: 64, z: 0 },
}

const STICK = 1
const COAL = 2
const BREAD = 3
const LEATHER_HELMET = 4

const mcData: McDataLike = {
  itemsByName: {
    stick: { id: STICK, name: 'stick' },
    coal: { id: COAL, name: 'coal' },
    bread: { id: BREAD, name: 'bread' },
    leather_helmet: { id: LEATHER_HELMET, name: 'leather_helmet' },
  },
  blocksByName: {},
}

const chestPosition: SkillPosition = { x: 5, y: 64, z: 5 }

interface ChestSimOptions {
  /** the villager pack the sim deposits FROM, keyed by item id */
  pack?: Record<number, number>
  /** free space in the chest for deposits (Infinity by default) */
  chestRoom?: number
}

/** Structural chest: withdraw/deposit resolve the count actually moved, the
 *  way the real adapter reports honest transfers. */
function fakeChest(initial: Array<{ id: number; name: string; count: number }>, opts: ChestSimOptions = {}) {
  const slots = new Map<number, { name: string; count: number }>()
  for (const stack of initial) {
    slots.set(stack.id, { name: stack.name, count: stack.count })
  }
  const pack = new Map<number, number>(Object.entries(opts.pack ?? {}).map(([id, n]) => [Number(id), n]))
  let room = opts.chestRoom ?? Number.POSITIVE_INFINITY
  let closed = 0
  const handle: ChestHandle = {
    items: () => [...slots.values()].filter((s) => s.count > 0).map((s) => ({ name: s.name, count: s.count })),
    withdraw: async (id, count) => {
      const slot = slots.get(id)
      const moved = Math.min(count, slot?.count ?? 0)
      if (slot) slot.count -= moved
      return moved
    },
    deposit: async (id, count) => {
      const carried = pack.get(id) ?? 0
      const moved = Math.min(count, carried, room)
      pack.set(id, carried - moved)
      room -= moved
      return moved
    },
    close: async () => {
      closed += 1
    },
  }
  return { handle, closedCount: () => closed }
}

function makeDeps(handle: ChestHandle, overrides: Partial<UseChestDeps> = {}): UseChestDeps {
  let t = 0
  return {
    findChest: () => null,
    gotoBlock: async () => true,
    openChest: async () => handle,
    resolveItem: (name) => guardedItem(mcData, name),
    inventoryFull: () => false,
    now: () => t++,
    ...overrides,
  }
}

describe('getItemFromChest', () => {
  it('withdraws everything asked for (happy path)', async () => {
    const chest = fakeChest([
      { id: STICK, name: 'stick', count: 10 },
      { id: COAL, name: 'coal', count: 4 },
    ])
    const deps = makeDeps(chest.handle)

    const r = await getItemFromChest(deps, { chestPosition, items: { stick: 5, coal: 2 } }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.taken).toEqual({ stick: 5, coal: 2 })
      expect(r.outcome.missing).toEqual({})
    }
    expect(chest.closedCount()).toBe(1)
  })

  it('reports partial withdrawals in the outcome (some found, some not)', async () => {
    const chest = fakeChest([{ id: STICK, name: 'stick', count: 3 }])
    const deps = makeDeps(chest.handle)

    const r = await getItemFromChest(deps, { chestPosition, items: { stick: 8, bread: 1 } }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.taken).toEqual({ stick: 3 })
      expect(r.outcome.missing).toEqual({ stick: 5, bread: 1 })
    }
  })

  it('resolves Voyager-era aliases through the guard layer', async () => {
    const chest = fakeChest([{ id: LEATHER_HELMET, name: 'leather_helmet', count: 1 }])
    const deps = makeDeps(chest.handle)

    const r = await getItemFromChest(deps, { chestPosition, items: { leather_cap: 1 } }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.taken).toEqual({ leather_helmet: 1 })
  })

  it('every requested item absent is TARGET_NOT_FOUND', async () => {
    const chest = fakeChest([{ id: STICK, name: 'stick', count: 10 }])
    const deps = makeDeps(chest.handle)

    const r = await getItemFromChest(deps, { chestPosition, items: { bread: 2 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TARGET_NOT_FOUND')
      expect(r.detail).toContain('bread')
    }
    expect(chest.closedCount()).toBe(1)
  })

  it('a chest that will not open is CONTAINER_NOT_FOUND, naming the nearest real chest', async () => {
    const chest = fakeChest([])
    const deps = makeDeps(chest.handle, {
      openChest: async () => null,
      findChest: () => ({ x: 9, y: 64, z: -2 }),
    })

    const r = await getItemFromChest(deps, { chestPosition, items: { stick: 1 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('CONTAINER_NOT_FOUND')
      expect(r.detail).toContain('(5, 64, 5)')
      expect(r.detail).toContain('(9, 64, -2)')
    }
  })

  it('CONTAINER_NOT_FOUND says so when no chest stands anywhere in range', async () => {
    const chest = fakeChest([])
    const deps = makeDeps(chest.handle, { openChest: async () => null, findChest: () => null })

    const r = await getItemFromChest(deps, { chestPosition, items: { stick: 1 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('CONTAINER_NOT_FOUND')
      expect(r.detail).toContain(String(CHEST_SEARCH_DISTANCE))
    }
  })

  it('no path to the chest is PATH_NOT_FOUND', async () => {
    const chest = fakeChest([])
    const deps = makeDeps(chest.handle, { gotoBlock: async () => false })

    const r = await getItemFromChest(deps, { chestPosition, items: { stick: 1 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('PATH_NOT_FOUND')
  })

  it('a pack already full is INVENTORY_FULL before walking anywhere', async () => {
    const chest = fakeChest([{ id: STICK, name: 'stick', count: 10 }])
    let walked = false
    const deps = makeDeps(chest.handle, {
      inventoryFull: () => true,
      gotoBlock: async () => {
        walked = true
        return true
      },
    })

    const r = await getItemFromChest(deps, { chestPosition, items: { stick: 1 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('INVENTORY_FULL')
    expect(walked).toBe(false)
  })

  it('a pack that fills mid-withdraw is INVENTORY_FULL with what was taken', async () => {
    const chest = fakeChest([
      { id: STICK, name: 'stick', count: 10 },
      { id: COAL, name: 'coal', count: 4 },
    ])
    // precheck + first loop check pass, second loop check trips
    let calls = 0
    const deps = makeDeps(chest.handle, {
      inventoryFull: () => {
        calls += 1
        return calls > 2
      },
    })

    const r = await getItemFromChest(deps, { chestPosition, items: { stick: 5, coal: 2 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INVENTORY_FULL')
      expect(r.detail).toContain('5 stick')
    }
    expect(chest.closedCount()).toBe(1)
  })

  it('an unknown item name is UNSUPPORTED_NAME before the body moves', async () => {
    const chest = fakeChest([])
    let walked = false
    const deps = makeDeps(chest.handle, {
      gotoBlock: async () => {
        walked = true
        return true
      },
    })

    const r = await getItemFromChest(deps, { chestPosition, items: { unobtanium: 1 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('UNSUPPORTED_NAME')
      expect(r.detail).toContain('unobtanium')
    }
    expect(walked).toBe(false)
  })

  it('an empty request is an ok no-op', async () => {
    const chest = fakeChest([{ id: STICK, name: 'stick', count: 10 }])
    const deps = makeDeps(chest.handle)

    const r = await getItemFromChest(deps, { chestPosition, items: {} }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.taken).toEqual({})
      expect(r.outcome.missing).toEqual({})
    }
  })
})

describe('depositItemIntoChest', () => {
  it('deposits everything asked for (happy path)', async () => {
    const chest = fakeChest([], { pack: { [STICK]: 10, [COAL]: 4 } })
    const deps = makeDeps(chest.handle)

    const r = await depositItemIntoChest(deps, { chestPosition, items: { stick: 4, coal: 2 } }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.deposited).toEqual({ stick: 4, coal: 2 })
      expect(r.outcome.kept).toEqual({})
    }
    expect(chest.closedCount()).toBe(1)
  })

  it('reports partial deposits in the outcome (short pack, absent item)', async () => {
    const chest = fakeChest([], { pack: { [STICK]: 2 } })
    const deps = makeDeps(chest.handle)

    const r = await depositItemIntoChest(deps, { chestPosition, items: { stick: 5, bread: 1 } }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.deposited).toEqual({ stick: 2 })
      expect(r.outcome.kept).toEqual({ stick: 3, bread: 1 })
    }
  })

  it('depositing nothing at all is MISSING_MATERIALS', async () => {
    const chest = fakeChest([], { pack: {} })
    const deps = makeDeps(chest.handle)

    const r = await depositItemIntoChest(deps, { chestPosition, items: { stick: 5 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toContain('stick')
    }
    expect(chest.closedCount()).toBe(1)
  })

  it('a full chest that accepts nothing is MISSING_MATERIALS too (seam reports moved=0)', async () => {
    const chest = fakeChest([], { pack: { [STICK]: 10 }, chestRoom: 0 })
    const deps = makeDeps(chest.handle)

    const r = await depositItemIntoChest(deps, { chestPosition, items: { stick: 5 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toContain('room')
    }
  })

  it('a chest that will not open is CONTAINER_NOT_FOUND', async () => {
    const chest = fakeChest([])
    const deps = makeDeps(chest.handle, { openChest: async () => null })

    const r = await depositItemIntoChest(deps, { chestPosition, items: { stick: 1 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('CONTAINER_NOT_FOUND')
  })

  it('no path to the chest is PATH_NOT_FOUND', async () => {
    const chest = fakeChest([])
    const deps = makeDeps(chest.handle, { gotoBlock: async () => false })

    const r = await depositItemIntoChest(deps, { chestPosition, items: { stick: 1 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('PATH_NOT_FOUND')
  })

  it('an unknown item name is UNSUPPORTED_NAME before the body moves', async () => {
    const chest = fakeChest([])
    let walked = false
    const deps = makeDeps(chest.handle, {
      gotoBlock: async () => {
        walked = true
        return true
      },
    })

    const r = await depositItemIntoChest(deps, { chestPosition, items: { unobtanium: 1 } }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('UNSUPPORTED_NAME')
    expect(walked).toBe(false)
  })
})

describe('checkItemInsideChest', () => {
  it('lists the chest contents (happy path)', async () => {
    const chest = fakeChest([
      { id: STICK, name: 'stick', count: 10 },
      { id: COAL, name: 'coal', count: 4 },
    ])
    const deps = makeDeps(chest.handle)

    const r = await checkItemInsideChest(deps, { chestPosition }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.contents).toEqual([
        { name: 'stick', count: 10 },
        { name: 'coal', count: 4 },
      ])
    }
    expect(chest.closedCount()).toBe(1)
  })

  it('aggregates repeated stacks of the same item into one entry', async () => {
    const handle: ChestHandle = {
      items: () => [
        { name: 'stick', count: 64 },
        { name: 'coal', count: 4 },
        { name: 'stick', count: 30 },
      ],
      withdraw: async () => 0,
      deposit: async () => 0,
      close: async () => {},
    }
    const deps = makeDeps(handle)

    const r = await checkItemInsideChest(deps, { chestPosition }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.contents).toEqual([
        { name: 'stick', count: 94 },
        { name: 'coal', count: 4 },
      ])
    }
  })

  it('a chest that will not open is CONTAINER_NOT_FOUND', async () => {
    const chest = fakeChest([])
    const deps = makeDeps(chest.handle, { openChest: async () => null })

    const r = await checkItemInsideChest(deps, { chestPosition }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('CONTAINER_NOT_FOUND')
  })

  it('no path to the chest is PATH_NOT_FOUND', async () => {
    const chest = fakeChest([])
    const deps = makeDeps(chest.handle, { gotoBlock: async () => false })

    const r = await checkItemInsideChest(deps, { chestPosition }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('PATH_NOT_FOUND')
  })
})
