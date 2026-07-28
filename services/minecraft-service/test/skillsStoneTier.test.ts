import { describe, expect, it, vi } from 'vitest'
import {
  skillFail,
  skillOk,
  type SkillFailureCode,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
  type SkillSchemaStub,
} from '../src/skills/types.ts'
import {
  DEFAULT_COBBLESTONE_COUNT,
  collectCobblestone,
  collectCobblestoneSchema,
  type CollectCobblestonePrimitives,
} from '../src/skills/library/collectCobblestone.ts'
import {
  craftStonePickaxe,
  craftStonePickaxeSchema,
  type CraftStonePickaxePrimitives,
} from '../src/skills/library/craftStonePickaxe.ts'
import {
  craftStoneAxe,
  craftStoneAxeSchema,
} from '../src/skills/library/craftStoneAxe.ts'
import {
  craftStoneSword,
  craftStoneSwordSchema,
} from '../src/skills/library/craftStoneSword.ts'

const ctx: SkillInvocationContext = {
  biome: 'plains',
  timeOfDay: 6000,
  heldTool: 'wooden_pickaxe',
  hostileCount: 0,
  position: { x: 10, y: 64, z: -20 },
}

const pos: SkillPosition = { x: 11, y: 64, z: -20 }

function ok<T>(outcome: T): SkillResult<T> {
  return skillOk(outcome, 5, ctx)
}

function fail<T>(code: SkillFailureCode, detail: string): SkillResult<T> {
  return skillFail<T>(code, detail, 5, ctx)
}

/** All three craft skills compose the same primitive slice, structurally. */
function craftPrims(
  overrides: Partial<CraftStonePickaxePrimitives> = {},
  inventory: Record<string, number> = {},
): CraftStonePickaxePrimitives {
  return {
    countItem: vi.fn(async ({ name }: { name: string }) =>
      ok({ count: inventory[name] ?? 0 }),
    ),
    mineBlock: vi.fn(async ({ count }: { name: string; count?: number }) =>
      ok({ collected: count ?? 1 }),
    ),
    craftItem: vi.fn(async ({ count }: { name: string; count?: number }) =>
      ok({ crafted: count ?? 1 }),
    ),
    findBlock: vi.fn(async () => ok({ position: pos })),
    placeItem: vi.fn(async () => ok({ position: pos })),
    ...overrides,
  }
}

function collectPrims(
  overrides: Partial<CollectCobblestonePrimitives> = {},
): CollectCobblestonePrimitives {
  return {
    equipBestTool: vi.fn(async () => ok({ tool: 'wooden_pickaxe' })),
    mineBlock: vi.fn(async ({ count }: { name: string; count?: number }) =>
      ok({ collected: count ?? 1 }),
    ),
    ...overrides,
  }
}

describe('collectCobblestone', () => {
  it('equips a pickaxe then mines stone, default count 5', async () => {
    const primitives = collectPrims()
    const r = await collectCobblestone(primitives, { count: null }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.collected).toBe(DEFAULT_COBBLESTONE_COUNT)
    expect(primitives.equipBestTool).toHaveBeenCalledWith({ block: 'stone' })
    expect(primitives.mineBlock).toHaveBeenCalledWith({
      name: 'stone',
      count: DEFAULT_COBBLESTONE_COUNT,
    })
    if (r.ok) expect(r.context).toEqual(ctx)
  })

  it('honors an explicit count', async () => {
    const primitives = collectPrims()
    const r = await collectCobblestone(primitives, { count: 12 }, ctx)
    expect(r.ok).toBe(true)
    expect(primitives.mineBlock).toHaveBeenCalledWith({ name: 'stone', count: 12 })
  })

  it('sanitizes a hostile count: fractions floor, non-positive clamps to 1', async () => {
    const fractional = collectPrims()
    await collectCobblestone(fractional, { count: 2.9 }, ctx)
    expect(fractional.mineBlock).toHaveBeenCalledWith({ name: 'stone', count: 2 })

    const nonPositive = collectPrims()
    await collectCobblestone(nonPositive, { count: 0 }, ctx)
    expect(nonPositive.mineBlock).toHaveBeenCalledWith({ name: 'stone', count: 1 })

    const nonFinite = collectPrims()
    await collectCobblestone(nonFinite, { count: Number.NaN }, ctx)
    expect(nonFinite.mineBlock).toHaveBeenCalledWith({
      name: 'stone',
      count: DEFAULT_COBBLESTONE_COUNT,
    })
  })

  it('refuses TOOL_REQUIRED before mining when no pickaxe qualifies', async () => {
    const primitives = collectPrims({
      equipBestTool: vi.fn(async () =>
        fail<{ tool: string }>('TOOL_REQUIRED', 'no pickaxe in inventory'),
      ),
    })
    const r = await collectCobblestone(primitives, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TOOL_REQUIRED')
      expect(r.detail).toBe('no pickaxe in inventory')
    }
    expect(primitives.mineBlock).not.toHaveBeenCalled()
  })

  it.each(collectCobblestoneSchema.failureCodes)(
    'propagates mineBlock %s intact (code and detail)',
    async (code) => {
      const primitives = collectPrims({
        mineBlock: vi.fn(async () =>
          fail<{ collected: number }>(code, `primitive said ${code}`),
        ),
      })
      const r = await collectCobblestone(primitives, {}, ctx)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.failureCode).toBe(code)
        expect(r.detail).toBe(`primitive said ${code}`)
      }
    },
  )
})

type CraftSkill = (
  primitives: CraftStonePickaxePrimitives,
  params: Record<string, never>,
  ctx: SkillInvocationContext,
) => Promise<SkillResult<{ crafted: number }>>

const craftCases: Array<{
  skill: CraftSkill
  schema: SkillSchemaStub
  item: string
  cobble: number
  sticks: number
}> = [
  {
    skill: craftStonePickaxe,
    schema: craftStonePickaxeSchema,
    item: 'stone_pickaxe',
    cobble: 3,
    sticks: 2,
  },
  {
    skill: craftStoneAxe,
    schema: craftStoneAxeSchema,
    item: 'stone_axe',
    cobble: 3,
    sticks: 2,
  },
  {
    skill: craftStoneSword,
    schema: craftStoneSwordSchema,
    item: 'stone_sword',
    cobble: 2,
    sticks: 1,
  },
]

describe.each(craftCases)('$schema.name', ({ skill, schema, item, cobble, sticks }) => {
  it('crafts directly when materials and a table are already at hand', async () => {
    const primitives = craftPrims({}, { cobblestone: cobble, stick: sticks })
    const r = await skill(primitives, {}, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.crafted).toBe(1)
    expect(primitives.mineBlock).not.toHaveBeenCalled()
    expect(primitives.placeItem).not.toHaveBeenCalled()
    expect(primitives.craftItem).toHaveBeenCalledTimes(1)
    expect(primitives.craftItem).toHaveBeenCalledWith({ name: item, count: 1 })
  })

  it('mines the cobblestone deficit and crafts the stick deficit first', async () => {
    const primitives = craftPrims({}, { cobblestone: 1, stick: 0 })
    const r = await skill(primitives, {}, ctx)
    expect(r.ok).toBe(true)
    expect(primitives.mineBlock).toHaveBeenCalledWith({
      name: 'stone',
      count: cobble - 1,
    })
    expect(primitives.craftItem).toHaveBeenNthCalledWith(1, {
      name: 'stick',
      count: sticks,
    })
    expect(primitives.craftItem).toHaveBeenNthCalledWith(2, { name: item, count: 1 })
  })

  it('places a crafting table only when none is nearby (TARGET_NOT_FOUND handled)', async () => {
    const primitives = craftPrims(
      {
        findBlock: vi.fn(async () =>
          fail<{ position: SkillPosition }>('TARGET_NOT_FOUND', 'no table within 32'),
        ),
      },
      { cobblestone: cobble, stick: sticks },
    )
    const r = await skill(primitives, {}, ctx)
    expect(r.ok).toBe(true)
    expect(primitives.placeItem).toHaveBeenCalledWith({ name: 'crafting_table' })
  })

  it('TARGET_NOT_FOUND never escapes: it is not in the schema stub', () => {
    expect(schema.failureCodes).not.toContain('TARGET_NOT_FOUND')
  })

  it('propagates the FIRST failure and stops (mineBlock PATH_NOT_FOUND)', async () => {
    const primitives = craftPrims(
      {
        mineBlock: vi.fn(async () =>
          fail<{ collected: number }>('PATH_NOT_FOUND', 'stone unreachable'),
        ),
      },
      { cobblestone: 0, stick: sticks },
    )
    const r = await skill(primitives, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PATH_NOT_FOUND')
      expect(r.detail).toBe('stone unreachable')
    }
    expect(primitives.craftItem).not.toHaveBeenCalled()
    expect(primitives.findBlock).not.toHaveBeenCalled()
  })

  it('propagates a table placement failure intact', async () => {
    const primitives = craftPrims(
      {
        findBlock: vi.fn(async () =>
          fail<{ position: SkillPosition }>('TARGET_NOT_FOUND', 'no table within 32'),
        ),
        placeItem: vi.fn(async () =>
          fail<{ position: SkillPosition }>('PLACE_FAILED', 'no solid ground'),
        ),
      },
      { cobblestone: cobble, stick: sticks },
    )
    const r = await skill(primitives, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PLACE_FAILED')
      expect(r.detail).toBe('no solid ground')
    }
    expect(primitives.craftItem).not.toHaveBeenCalled()
  })

  it('propagates a non-TARGET_NOT_FOUND findBlock failure without placing', async () => {
    const primitives = craftPrims(
      {
        findBlock: vi.fn(async () =>
          fail<{ position: SkillPosition }>('INTERNAL', 'world not loaded'),
        ),
      },
      { cobblestone: cobble, stick: sticks },
    )
    const r = await skill(primitives, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('INTERNAL')
    expect(primitives.placeItem).not.toHaveBeenCalled()
  })

  it.each(schema.failureCodes)(
    'final craft failing with %s propagates intact',
    async (code) => {
      const primitives = craftPrims(
        {
          craftItem: vi.fn(async ({ name }: { name: string; count?: number }) =>
            name === item
              ? fail<{ crafted: number }>(code, `primitive said ${code}`)
              : ok({ crafted: 1 }),
          ),
        },
        { cobblestone: cobble, stick: sticks },
      )
      const r = await skill(primitives, {}, ctx)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.failureCode).toBe(code)
        expect(r.detail).toBe(`primitive said ${code}`)
      }
    },
  )
})

describe('schema stubs', () => {
  const FAILURE_CODE_UNION: SkillFailureCode[] = [
    'RESOURCE_NOT_FOUND',
    'PATH_NOT_FOUND',
    'TOOL_REQUIRED',
    'TOOL_TIER_REQUIRED',
    'TIMEOUT',
    'INTERNAL',
    'UNSUPPORTED_NAME',
    'RECIPE_UNAVAILABLE',
    'MISSING_MATERIALS',
    'PLACE_FAILED',
    'CONTAINER_NOT_FOUND',
    'TARGET_NOT_FOUND',
    'INVENTORY_FULL',
    'ABORTED',
  ]

  const stubs: SkillSchemaStub[] = [
    collectCobblestoneSchema,
    craftStonePickaxeSchema,
    craftStoneAxeSchema,
    craftStoneSwordSchema,
  ]

  it.each(stubs.map((s) => [s.name, s] as const))(
    '%s: codes are unique and within the closed union',
    (_name, stub) => {
      expect(new Set(stub.failureCodes).size).toBe(stub.failureCodes.length)
      for (const code of stub.failureCodes) {
        expect(FAILURE_CODE_UNION).toContain(code)
      }
    },
  )

  it.each(stubs.map((s) => [s.name, s] as const))(
    '%s: params are strict-safe (closed object, required-nullable)',
    (_name, stub) => {
      expect(stub.params['type']).toBe('object')
      expect(stub.params['additionalProperties']).toBe(false)
      const properties = stub.params['properties'] as Record<string, unknown>
      const required = stub.params['required'] as string[]
      // strict mode: every property is required (nullability carries optionality)
      expect([...required].sort()).toEqual(Object.keys(properties).sort())
    },
  )

  it('collectCobblestone declares exactly its composed-primitive surface', () => {
    expect([...collectCobblestoneSchema.failureCodes].sort()).toEqual(
      [
        'RESOURCE_NOT_FOUND',
        'PATH_NOT_FOUND',
        'TOOL_REQUIRED',
        'TOOL_TIER_REQUIRED',
        'TIMEOUT',
        'INVENTORY_FULL',
        'UNSUPPORTED_NAME',
        'ABORTED',
        'INTERNAL',
      ].sort(),
    )
  })

  it('craft skills declare the same surface: everything except the two unreachable codes', () => {
    const expected = FAILURE_CODE_UNION.filter(
      (c) => c !== 'TARGET_NOT_FOUND' && c !== 'CONTAINER_NOT_FOUND',
    ).sort()
    for (const stub of [craftStonePickaxeSchema, craftStoneAxeSchema, craftStoneSwordSchema]) {
      expect([...stub.failureCodes].sort()).toEqual(expected)
    }
  })

  it('collectCobblestone count is required-nullable integer', () => {
    const properties = collectCobblestoneSchema.params['properties'] as Record<
      string,
      { type?: unknown }
    >
    expect(collectCobblestoneSchema.params['required']).toEqual(['count'])
    expect(properties['count']?.type).toEqual(['integer', 'null'])
  })
})
