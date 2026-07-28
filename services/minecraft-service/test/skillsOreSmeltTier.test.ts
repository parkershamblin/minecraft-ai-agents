// Ore + smelt tier skills — botless tests over fake primitives. The replay
// case at the bottom re-drives a REAL failure sequence from the committed
// bench windows (this repo's replay-before-GPU convention, cf.
// relocationReplay.test.ts).

import { describe, expect, it } from 'vitest'
import {
  skillFail,
  skillOk,
  type SkillFailureCode,
  type SkillInvocationContext,
  type SkillResult,
  type SkillSchemaStub,
} from '../src/skills/types.ts'
import {
  DEFAULT_COAL_ORE_COUNT,
  mineCoalOre,
  mineCoalOreSchema,
} from '../src/skills/library/mineCoalOre.ts'
import {
  DEFAULT_IRON_ORE_COUNT,
  mineIronOre,
  mineIronOreSchema,
} from '../src/skills/library/mineIronOre.ts'
import {
  COBBLESTONE_PER_FURNACE,
  craftFurnace,
  craftFurnaceSchema,
} from '../src/skills/library/craftFurnace.ts'
import {
  craftIronPickaxe,
  craftIronPickaxeSchema,
} from '../src/skills/library/craftIronPickaxe.ts'
import {
  DEFAULT_SMELT_COUNT,
  smeltIronOre,
  smeltIronOreSchema,
} from '../src/skills/library/smeltIronOre.ts'

const surfaceCtx: SkillInvocationContext = {
  biome: 'windswept_hills',
  timeOfDay: 2400,
  heldTool: 'stone_pickaxe',
  hostileCount: 0,
  position: { x: -168, y: 91, z: -38 },
}

const deepslateCtx: SkillInvocationContext = {
  ...surfaceCtx,
  position: { x: -168, y: -12, z: -38 },
}

/** Scripted fake primitive: replays a queue of results, records every call. */
function scripted<TParams, TOutcome>(queue: SkillResult<TOutcome>[]) {
  const calls: TParams[] = []
  const fn = async (params: TParams): Promise<SkillResult<TOutcome>> => {
    calls.push(params)
    const next = queue.shift()
    if (!next) throw new Error('scripted primitive exhausted — test bug')
    return next
  }
  return { fn, calls }
}

const ok = <T>(outcome: T): SkillResult<T> => skillOk(outcome, 5, surfaceCtx)
const fail = <T>(code: SkillFailureCode, detail: string): SkillResult<T> =>
  skillFail<T>(code, detail, 5, surfaceCtx)

type MineParams = { blockName: string; count?: number }
type CraftParams = { itemName: string; count?: number }
type PlaceParams = { itemName: string }
type SmeltParams = { itemName: string; fuelName: string; count?: number }

describe('mineCoalOre', () => {
  it('happy path: mines coal_ore and reports the haul', async () => {
    const mine = scripted<MineParams, { mined: number }>([ok({ mined: 4 })])
    const r = await mineCoalOre({ mineBlock: mine.fn }, { count: 4 }, surfaceCtx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ mined: 4, requested: 4, byVariant: { coal_ore: 4 } })
      expect(r.costMs).toBeGreaterThanOrEqual(0)
      expect(r.context).toBe(surfaceCtx)
    }
    expect(mine.calls).toEqual([{ blockName: 'coal_ore', count: 4 }])
  })

  it('null count falls back to the trip-budget default', async () => {
    const mine = scripted<MineParams, { mined: number }>([
      ok({ mined: DEFAULT_COAL_ORE_COUNT }),
    ])
    const r = await mineCoalOre({ mineBlock: mine.fn }, {}, surfaceCtx)
    expect(r.ok).toBe(true)
    expect(mine.calls[0]?.count).toBe(DEFAULT_COAL_ORE_COUNT)
  })

  it('propagates TOOL_REQUIRED intact without trying the other variant', async () => {
    const mine = scripted<MineParams, { mined: number }>([
      fail('TOOL_REQUIRED', 'coal_ore needs a pickaxe; you hold nothing'),
    ])
    const r = await mineCoalOre({ mineBlock: mine.fn }, { count: 3 }, surfaceCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TOOL_REQUIRED')
      expect(r.detail).toBe('coal_ore needs a pickaxe; you hold nothing')
    }
    expect(mine.calls).toHaveLength(1)
  })

  it('falls back to deepslate_coal_ore when coal_ore is absent', async () => {
    const mine = scripted<MineParams, { mined: number }>([
      fail('RESOURCE_NOT_FOUND', 'no coal_ore within 64 blocks'),
      ok({ mined: 3 }),
    ])
    const r = await mineCoalOre({ mineBlock: mine.fn }, { count: 3 }, surfaceCtx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.byVariant).toEqual({ deepslate_coal_ore: 3 })
    expect(mine.calls.map((c) => c.blockName)).toEqual([
      'coal_ore',
      'deepslate_coal_ore',
    ])
  })
})

describe('mineIronOre', () => {
  it('happy path: mines iron_ore surface-first', async () => {
    const mine = scripted<MineParams, { mined: number }>([ok({ mined: 3 })])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: 3 }, surfaceCtx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ mined: 3, requested: 3, byVariant: { iron_ore: 3 } })
    }
    expect(mine.calls).toEqual([{ blockName: 'iron_ore', count: 3 }])
  })

  it('null count falls back to the trip-budget default', async () => {
    const mine = scripted<MineParams, { mined: number }>([
      ok({ mined: DEFAULT_IRON_ORE_COUNT }),
    ])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: null }, surfaceCtx)
    expect(r.ok).toBe(true)
    expect(mine.calls[0]?.count).toBe(DEFAULT_IRON_ORE_COUNT)
  })

  it('TOOL_TIER_REQUIRED propagates INTACT and never burns a deepslate trip', async () => {
    // The top live failure code in this repo's ledger (1,618 occurrences):
    // a wooden pickaxe cannot harvest iron. The tier applies to BOTH
    // variants, so exactly ONE primitive call is allowed.
    const detail = 'iron_ore requires a stone pickaxe or better; you hold wooden_pickaxe'
    const mine = scripted<MineParams, { mined: number }>([
      fail('TOOL_TIER_REQUIRED', detail),
    ])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: 3 }, surfaceCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TOOL_TIER_REQUIRED')
      expect(r.detail).toBe(detail) // intact, never remapped or rephrased
    }
    expect(mine.calls).toHaveLength(1)
  })

  it('falls back to deepslate_iron_ore when iron_ore is absent', async () => {
    const mine = scripted<MineParams, { mined: number }>([
      fail('RESOURCE_NOT_FOUND', 'no iron_ore within 64 blocks'),
      ok({ mined: 2 }),
    ])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: 2 }, surfaceCtx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.byVariant).toEqual({ deepslate_iron_ore: 2 })
    }
    expect(mine.calls.map((c) => c.blockName)).toEqual([
      'iron_ore',
      'deepslate_iron_ore',
    ])
  })

  it('searches deepslate first below y=0', async () => {
    const mine = scripted<MineParams, { mined: number }>([ok({ mined: 3 })])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: 3 }, deepslateCtx)
    expect(r.ok).toBe(true)
    expect(mine.calls[0]?.blockName).toBe('deepslate_iron_ore')
  })

  it('refuses a non-positive count without inventing a RESOURCE_NOT_FOUND', async () => {
    // Bounds are stripped from the strict-safe stub, so count: 0 CAN arrive.
    const mine = scripted<MineParams, { mined: number }>([])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: 0 }, surfaceCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('positive integer')
    }
    expect(mine.calls).toHaveLength(0) // no trip spent on a bad request
  })

  it('both variants absent -> RESOURCE_NOT_FOUND naming both', async () => {
    const mine = scripted<MineParams, { mined: number }>([
      fail('RESOURCE_NOT_FOUND', 'no iron_ore within 64 blocks'),
      fail('RESOURCE_NOT_FOUND', 'no deepslate_iron_ore within 64 blocks'),
    ])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: 3 }, surfaceCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('RESOURCE_NOT_FOUND')
      expect(r.detail).toContain('iron_ore')
      expect(r.detail).toContain('deepslate_iron_ore')
    }
  })

  it('keeps a partial haul when the deepslate top-up times out', async () => {
    // Partial gathers complete in the live executor (stoppedEarly), so a
    // 2-of-3 haul is a success, not a TIMEOUT.
    const mine = scripted<MineParams, { mined: number }>([
      ok({ mined: 2 }),
      fail('TIMEOUT', 'trip budget exhausted en route'),
    ])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: 3 }, surfaceCtx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.mined).toBe(2)
      expect(r.outcome.requested).toBe(3)
    }
    expect(mine.calls[1]).toEqual({ blockName: 'deepslate_iron_ore', count: 1 })
  })
})

describe('craftFurnace', () => {
  it('happy path: crafts on the first attempt', async () => {
    const craft = scripted<CraftParams, { crafted: number }>([ok({ crafted: 1 })])
    const mine = scripted<MineParams, { mined: number }>([])
    const place = scripted<PlaceParams, { placed: boolean }>([])
    const r = await craftFurnace(
      { craftItem: craft.fn, mineBlock: mine.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ crafted: 1, tablePlaced: false, stoneMined: false })
    }
    expect(craft.calls).toEqual([{ itemName: 'furnace', count: 1 }])
    expect(mine.calls).toHaveLength(0)
    expect(place.calls).toHaveLength(0)
  })

  it('recovers from missing cobblestone by mining stone, then retries', async () => {
    const craft = scripted<CraftParams, { crafted: number }>([
      fail('MISSING_MATERIALS', 'furnace needs 8 cobblestone; you have 2'),
      ok({ crafted: 1 }),
    ])
    const mine = scripted<MineParams, { mined: number }>([ok({ mined: 8 })])
    const place = scripted<PlaceParams, { placed: boolean }>([])
    const r = await craftFurnace(
      { craftItem: craft.fn, mineBlock: mine.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.stoneMined).toBe(true)
    expect(mine.calls).toEqual([
      { blockName: 'stone', count: COBBLESTONE_PER_FURNACE },
    ])
  })

  it('recovers from no table in reach by placing one, then retries', async () => {
    const craft = scripted<CraftParams, { crafted: number }>([
      fail('RECIPE_UNAVAILABLE', 'furnace needs a crafting table in reach'),
      ok({ crafted: 1 }),
    ])
    const mine = scripted<MineParams, { mined: number }>([])
    const place = scripted<PlaceParams, { placed: boolean }>([ok({ placed: true })])
    const r = await craftFurnace(
      { craftItem: craft.fn, mineBlock: mine.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.tablePlaced).toBe(true)
    expect(place.calls).toEqual([{ itemName: 'crafting_table' }])
  })

  it('propagates a failed recovery intact (stone trip PATH_NOT_FOUND)', async () => {
    const craft = scripted<CraftParams, { crafted: number }>([
      fail('MISSING_MATERIALS', 'furnace needs 8 cobblestone; you have 0'),
    ])
    const mine = scripted<MineParams, { mined: number }>([
      fail('PATH_NOT_FOUND', 'stone unreachable from here'),
    ])
    const place = scripted<PlaceParams, { placed: boolean }>([])
    const r = await craftFurnace(
      { craftItem: craft.fn, mineBlock: mine.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PATH_NOT_FOUND')
      expect(r.detail).toBe('stone unreachable from here')
    }
  })

  it('each recovery runs at most once — a second MISSING_MATERIALS propagates', async () => {
    const craft = scripted<CraftParams, { crafted: number }>([
      fail('MISSING_MATERIALS', 'furnace needs 8 cobblestone; you have 0'),
      fail('MISSING_MATERIALS', 'still short of cobblestone'),
    ])
    const mine = scripted<MineParams, { mined: number }>([ok({ mined: 3 })])
    const place = scripted<PlaceParams, { placed: boolean }>([])
    const r = await craftFurnace(
      { craftItem: craft.fn, mineBlock: mine.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toBe('still short of cobblestone')
    }
    expect(mine.calls).toHaveLength(1) // no second provisioning loop
  })
})

describe('craftIronPickaxe', () => {
  it('happy path: crafts at a reachable table', async () => {
    const craft = scripted<CraftParams, { crafted: number }>([ok({ crafted: 1 })])
    const place = scripted<PlaceParams, { placed: boolean }>([])
    const r = await craftIronPickaxe(
      { craftItem: craft.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome).toEqual({ crafted: 1, tablePlaced: false })
    expect(craft.calls).toEqual([{ itemName: 'iron_pickaxe', count: 1 }])
  })

  it('MISSING_MATERIALS propagates INTACT with zero recovery attempts', async () => {
    const detail = 'iron_pickaxe needs 3 iron_ingot; you have 0'
    const craft = scripted<CraftParams, { crafted: number }>([
      fail('MISSING_MATERIALS', detail),
    ])
    const place = scripted<PlaceParams, { placed: boolean }>([])
    const r = await craftIronPickaxe(
      { craftItem: craft.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toBe(detail) // FIRST failure code, intact
    }
    expect(craft.calls).toHaveLength(1)
    expect(place.calls).toHaveLength(0) // provisioning is the caller's job
  })

  it('places a table once on RECIPE_UNAVAILABLE, then crafts', async () => {
    const craft = scripted<CraftParams, { crafted: number }>([
      fail('RECIPE_UNAVAILABLE', 'iron_pickaxe needs a crafting table in reach'),
      ok({ crafted: 1 }),
    ])
    const place = scripted<PlaceParams, { placed: boolean }>([ok({ placed: true })])
    const r = await craftIronPickaxe(
      { craftItem: craft.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.tablePlaced).toBe(true)
    expect(place.calls).toEqual([{ itemName: 'crafting_table' }])
  })

  it('a failed table placement propagates the place failure intact', async () => {
    const craft = scripted<CraftParams, { crafted: number }>([
      fail('RECIPE_UNAVAILABLE', 'iron_pickaxe needs a crafting table in reach'),
    ])
    const place = scripted<PlaceParams, { placed: boolean }>([
      fail('PLACE_FAILED', 'no solid face to place against'),
    ])
    const r = await craftIronPickaxe(
      { craftItem: craft.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PLACE_FAILED')
      expect(r.detail).toBe('no solid face to place against')
    }
  })
})

describe('smeltIronOre', () => {
  it('happy path: smelts raw_iron (never the ore block) with coal', async () => {
    const smelt = scripted<SmeltParams, { smelted: number }>([ok({ smelted: 5 })])
    const place = scripted<PlaceParams, { placed: boolean }>([])
    const r = await smeltIronOre(
      { smeltItem: smelt.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({
        smelted: 5,
        requested: DEFAULT_SMELT_COUNT,
        fuelName: 'coal',
        furnacePlaced: false,
      })
    }
    // The 1.17+ input: raw_iron. Smelting iron_ore is the Voyager-era bug.
    expect(smelt.calls).toEqual([
      { itemName: 'raw_iron', fuelName: 'coal', count: DEFAULT_SMELT_COUNT },
    ])
  })

  it('honors explicit count and charcoal fuel', async () => {
    const smelt = scripted<SmeltParams, { smelted: number }>([ok({ smelted: 3 })])
    const place = scripted<PlaceParams, { placed: boolean }>([])
    const r = await smeltIronOre(
      { smeltItem: smelt.fn, placeItem: place.fn },
      { count: 3, fuelName: 'charcoal' },
      surfaceCtx,
    )
    expect(r.ok).toBe(true)
    expect(smelt.calls).toEqual([
      { itemName: 'raw_iron', fuelName: 'charcoal', count: 3 },
    ])
  })

  it('places a furnace once on CONTAINER_NOT_FOUND, then retries', async () => {
    const smelt = scripted<SmeltParams, { smelted: number }>([
      fail('CONTAINER_NOT_FOUND', 'no furnace within reach'),
      ok({ smelted: 5 }),
    ])
    const place = scripted<PlaceParams, { placed: boolean }>([ok({ placed: true })])
    const r = await smeltIronOre(
      { smeltItem: smelt.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.furnacePlaced).toBe(true)
    expect(place.calls).toEqual([{ itemName: 'furnace' }])
    expect(smelt.calls).toHaveLength(2)
  })

  it('propagates MISSING_MATERIALS (no raw_iron) intact', async () => {
    const detail = 'nothing to smelt: 0 raw_iron in inventory'
    const smelt = scripted<SmeltParams, { smelted: number }>([
      fail('MISSING_MATERIALS', detail),
    ])
    const place = scripted<PlaceParams, { placed: boolean }>([])
    const r = await smeltIronOre(
      { smeltItem: smelt.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toBe(detail)
    }
    expect(place.calls).toHaveLength(0)
  })

  it('a missing furnace ITEM propagates the place failure for craftFurnace to fix', async () => {
    const smelt = scripted<SmeltParams, { smelted: number }>([
      fail('CONTAINER_NOT_FOUND', 'no furnace within reach'),
    ])
    const place = scripted<PlaceParams, { placed: boolean }>([
      fail('MISSING_MATERIALS', 'no furnace item in inventory'),
    ])
    const r = await smeltIronOre(
      { smeltItem: smelt.fn, placeItem: place.fn },
      {},
      surfaceCtx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toBe('no furnace item in inventory')
    }
  })
})

describe('replay: real iron_ore TIMEOUT-then-success sequence', () => {
  // Replay seed — bench/results/sweep/slices/bench-gemma3-12b-r2.window.json
  // (committed on main; this branch's tree carries only the manifest),
  // villager 019f8e2a-0000-7000-8000-0000000b2a44, run bench-gemma3-12b-r2:
  //
  //   15:05:02.485Z ActionRequested gather {count:3, resource:iron_ore}  cmd …4dcf37ce
  //   15:06:02.493Z ActionFailed    TIMEOUT                              cmd …4dcf37ce
  //     "you did not arrive within 30s and stopped where you stood — the
  //      destination may be unreachable from here; pick a nearer or
  //      different spot and try again"  (the 60s trip budget, the top
  //      timeout source for iron across ALL SIX villagers)
  //   15:05:34.736Z ActionRequested gather {count:3, resource:iron_ore}  cmd …fcc86e70
  //   15:06:45.384Z ActionCompleted gather {byType:{iron_ore:5},
  //      attempts:3, collected:5, requested:3}  at (-191, 104, -65)
  //
  // Two invocations, exactly as the ledger saw them: the first trip blows
  // the budget and MUST surface TIMEOUT intact (and must NOT burn a second
  // trip on deepslate — the budget is already spent); the second trip lands
  // a 5-for-3 vein bonus.
  const timeoutDetail =
    'you did not arrive within 30s and stopped where you stood — the ' +
    'destination may be unreachable from here; pick a nearer or different ' +
    'spot and try again'
  const replayCtx: SkillInvocationContext = {
    biome: 'windswept_hills',
    timeOfDay: 4500,
    heldTool: 'stone_pickaxe',
    hostileCount: 0,
    position: { x: -191, y: 104, z: -65 },
  }

  it('first invocation surfaces the trip-budget TIMEOUT intact, single trip', async () => {
    const mine = scripted<MineParams, { mined: number }>([
      skillFail('TIMEOUT', timeoutDetail, 60_008, replayCtx),
    ])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: 3 }, replayCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TIMEOUT')
      expect(r.detail).toBe(timeoutDetail)
    }
    // No deepslate fallback on TIMEOUT: one mineBlock call only.
    expect(mine.calls).toEqual([{ blockName: 'iron_ore', count: 3 }])
  })

  it('second invocation completes with the 5-for-3 vein bonus', async () => {
    const mine = scripted<MineParams, { mined: number }>([
      skillOk({ mined: 5 }, 70_648, replayCtx),
    ])
    const r = await mineIronOre({ mineBlock: mine.fn }, { count: 3 }, replayCtx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.mined).toBe(5)
      expect(r.outcome.requested).toBe(3)
      expect(r.outcome.byVariant).toEqual({ iron_ore: 5 })
    }
    // Over-delivery must not trigger a deepslate top-up (remaining <= 0).
    expect(mine.calls).toHaveLength(1)
  })
})

describe('schema stubs', () => {
  const stubs: SkillSchemaStub[] = [
    mineCoalOreSchema,
    mineIronOreSchema,
    craftFurnaceSchema,
    craftIronPickaxeSchema,
    smeltIronOreSchema,
  ]

  const isNullable = (prop: Record<string, unknown>): boolean => {
    const t = prop['type']
    if (Array.isArray(t) && t.includes('null')) return true
    const anyOf = prop['anyOf']
    return (
      Array.isArray(anyOf) &&
      anyOf.some((v) => (v as Record<string, unknown>)['type'] === 'null')
    )
  }

  it('every stub is strict-safe: closed object, required-nullable params', () => {
    for (const stub of stubs) {
      expect(stub.name.length).toBeGreaterThan(0)
      expect(stub.description.length).toBeGreaterThan(0)
      const params = stub.params as {
        type: string
        properties: Record<string, Record<string, unknown>>
        required: string[]
        additionalProperties: boolean
      }
      expect(params.type).toBe('object')
      expect(params.additionalProperties).toBe(false)
      // Strict mode rejects optional properties: every property is required
      // and therefore must be nullable.
      expect([...params.required].sort()).toEqual(
        Object.keys(params.properties).sort(),
      )
      for (const [key, prop] of Object.entries(params.properties)) {
        expect(isNullable(prop), `${stub.name}.${key} must be nullable`).toBe(true)
      }
    }
  })

  it('failure vocabularies are closed, deduplicated, and skill-accurate', () => {
    for (const stub of stubs) {
      expect(stub.failureCodes.length).toBeGreaterThan(0)
      expect(new Set(stub.failureCodes).size).toBe(stub.failureCodes.length)
    }
    expect(mineIronOreSchema.failureCodes).toContain('TOOL_TIER_REQUIRED')
    expect(mineCoalOreSchema.failureCodes).not.toContain('TOOL_TIER_REQUIRED')
    expect(smeltIronOreSchema.failureCodes).toContain('CONTAINER_NOT_FOUND')
    expect(craftIronPickaxeSchema.failureCodes).toContain('MISSING_MATERIALS')
    expect(craftFurnaceSchema.failureCodes).toContain('RECIPE_UNAVAILABLE')
  })

  it('stub names match their exported skills', () => {
    expect(mineCoalOreSchema.name).toBe('mineCoalOre')
    expect(mineIronOreSchema.name).toBe('mineIronOre')
    expect(craftFurnaceSchema.name).toBe('craftFurnace')
    expect(craftIronPickaxeSchema.name).toBe('craftIronPickaxe')
    expect(smeltIronOreSchema.name).toBe('smeltIronOre')
  })
})
