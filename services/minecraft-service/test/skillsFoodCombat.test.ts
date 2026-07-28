import { describe, expect, it, vi } from 'vitest'
import type {
  SkillFailureCode,
  SkillInvocationContext,
  SkillResult,
  SkillSchemaStub,
} from '../src/skills/types.ts'
import {
  KILL_ONE_PIG_DEFAULT_TIMEOUT_MS,
  killOnePig,
  killOnePigSchema,
} from '../src/skills/library/killOnePig.ts'
import {
  MEAT_NAMES,
  cookMeat,
  cookMeatSchema,
} from '../src/skills/library/cookMeat.ts'
import {
  CRAFT_STEPS,
  craftWoodenSword,
  craftWoodenSwordSchema,
} from '../src/skills/library/craftWoodenSword.ts'

const ctx: SkillInvocationContext = {
  biome: 'plains',
  timeOfDay: 6000,
  heldTool: null,
  hostileCount: 0,
  position: { x: 10, y: 64, z: -20 },
}

/** Context a fake primitive stamps on its own results — must NOT leak out. */
const primCtx: SkillInvocationContext = {
  biome: 'primitive-internal',
  timeOfDay: 0,
  heldTool: null,
  hostileCount: 0,
  position: { x: 0, y: 0, z: 0 },
}

function primOk<T>(outcome: T): SkillResult<T> {
  return { ok: true, outcome, costMs: 5, context: primCtx }
}

function primFail<T>(failureCode: SkillFailureCode, detail: string): SkillResult<T> {
  return { ok: false, failureCode, detail, costMs: 5, context: primCtx }
}

const ALL_FAILURE_CODES = [
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
] as const satisfies readonly SkillFailureCode[]

describe('killOnePig', () => {
  it('happy path: delegates to killMob and returns its outcome with the skill ctx', async () => {
    const killMob = vi
      .fn()
      .mockResolvedValue(primOk({ killed: true as const, dropsCollected: 2 }))
    const r = await killOnePig({ killMob }, {}, ctx)
    expect(killMob).toHaveBeenCalledTimes(1)
    expect(killMob).toHaveBeenCalledWith({
      mobName: 'pig',
      timeoutMs: KILL_ONE_PIG_DEFAULT_TIMEOUT_MS,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ killed: true, dropsCollected: 2 })
      expect(r.costMs).toBeGreaterThanOrEqual(0)
      expect(r.context).toBe(ctx)
    }
  })

  it('passes an explicit timeout budget through', async () => {
    const killMob = vi
      .fn()
      .mockResolvedValue(primOk({ killed: true as const, dropsCollected: 1 }))
    await killOnePig({ killMob }, { timeoutMs: 5_000 }, ctx)
    expect(killMob).toHaveBeenCalledTimes(1)
    expect(killMob).toHaveBeenCalledWith({
      mobName: 'pig',
      timeoutMs: 5_000,
    })
  })

  it('propagates TOOL_REQUIRED from the primitive intact — no inventory pre-check', async () => {
    const killMob = vi
      .fn()
      .mockResolvedValue(primFail('TOOL_REQUIRED', 'no weapon in inventory'))
    const r = await killOnePig({ killMob }, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TOOL_REQUIRED')
      expect(r.detail).toBe('no weapon in inventory')
      expect(r.context).toBe(ctx)
    }
  })

  it('propagates TARGET_NOT_FOUND intact', async () => {
    const killMob = vi
      .fn()
      .mockResolvedValue(primFail('TARGET_NOT_FOUND', 'no pig within 32 blocks'))
    const r = await killOnePig({ killMob }, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('TARGET_NOT_FOUND')
  })
})

describe('cookMeat', () => {
  it('happy path: smelts the raw meat (any fuel) and reports cooked count', async () => {
    const smeltItem = vi.fn().mockResolvedValue(primOk({ smelted: 3 }))
    const r = await cookMeat({ smeltItem }, { meat: 'porkchop', count: 3 }, ctx)
    expect(smeltItem).toHaveBeenCalledTimes(1)
    expect(smeltItem).toHaveBeenCalledWith({
      itemName: 'porkchop',
      count: 3,
    })
    // fuelName omitted = primitive picks any fuel
    expect(smeltItem.mock.calls[0]?.[0]).not.toHaveProperty('fuelName')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ cooked: 3 })
      expect(r.context).toBe(ctx)
    }
  })

  it('defaults count to 1', async () => {
    const smeltItem = vi.fn().mockResolvedValue(primOk({ smelted: 1 }))
    await cookMeat({ smeltItem }, { meat: 'beef' }, ctx)
    expect(smeltItem).toHaveBeenCalledTimes(1)
    expect(smeltItem).toHaveBeenCalledWith({
      itemName: 'beef',
      count: 1,
    })
  })

  it('every enum member maps to its 1.21.6 raw item name (no raw_ prefix)', async () => {
    for (const meat of MEAT_NAMES) {
      const smeltItem = vi.fn().mockResolvedValue(primOk({ smelted: 1 }))
      const r = await cookMeat({ smeltItem }, { meat }, ctx)
      expect(r.ok).toBe(true)
      expect(smeltItem).toHaveBeenCalledTimes(1)
      expect(smeltItem).toHaveBeenCalledWith({
        itemName: meat,
        count: 1,
      })
    }
  })

  it('the enum is closed: exactly the four meats, mirrored in the schema stub', () => {
    expect([...MEAT_NAMES]).toEqual(['porkchop', 'beef', 'chicken', 'mutton'])
    const params = cookMeatSchema.params as {
      properties: { meat: { enum: string[] } }
    }
    expect(params.properties.meat.enum).toEqual([...MEAT_NAMES])
  })

  it('reports the primitive smelted count, not the requested count (partial smelt)', async () => {
    const smeltItem = vi.fn().mockResolvedValue(primOk({ smelted: 2 }))
    const r = await cookMeat({ smeltItem }, { meat: 'chicken', count: 3 }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome).toEqual({ cooked: 2 })
  })

  it('clamps a zero/negative count to 1 (wire schema carries no bounds)', async () => {
    const smeltItem = vi.fn().mockResolvedValue(primOk({ smelted: 1 }))
    await cookMeat({ smeltItem }, { meat: 'beef', count: -3 }, ctx)
    expect(smeltItem).toHaveBeenCalledWith({ itemName: 'beef', count: 1 })
  })

  it('propagates the smelt failure intact', async () => {
    const smeltItem = vi
      .fn()
      .mockResolvedValue(primFail('CONTAINER_NOT_FOUND', 'no furnace and no cobblestone'))
    const r = await cookMeat({ smeltItem }, { meat: 'mutton' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('CONTAINER_NOT_FOUND')
      expect(r.detail).toBe('no furnace and no cobblestone')
      expect(r.context).toBe(ctx)
    }
  })
})

describe('craftWoodenSword', () => {
  it('happy path: crafts planks, sticks, table, sword — in that order', async () => {
    const craftItem = vi.fn().mockResolvedValue(primOk({ crafted: 1 }))
    const r = await craftWoodenSword({ craftItem }, {}, ctx)
    expect(craftItem.mock.calls.map((c) => c[0]?.itemName)).toEqual([
      'oak_planks',
      'stick',
      'crafting_table',
      'wooden_sword',
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ crafted: true, item: 'wooden_sword' })
      expect(r.context).toBe(ctx)
    }
  })

  it('propagates the FIRST failure intact and stops the chain', async () => {
    const craftItem = vi
      .fn()
      .mockResolvedValueOnce(primOk({ crafted: 8 }))
      .mockResolvedValueOnce(primFail('MISSING_MATERIALS', 'not enough oak_planks for stick'))
    const r = await craftWoodenSword({ craftItem }, {}, ctx)
    expect(craftItem).toHaveBeenCalledTimes(2) // table + sword never attempted
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toBe('not enough oak_planks for stick')
    }
  })

  it('a first-step failure short-circuits immediately', async () => {
    const craftItem = vi
      .fn()
      .mockResolvedValue(primFail('RECIPE_UNAVAILABLE', 'oak_planks recipe missing'))
    const r = await craftWoodenSword({ craftItem }, {}, ctx)
    expect(craftItem).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('RECIPE_UNAVAILABLE')
  })

  it('the plank budget covers the whole chain (table 4 + sticks 2 + sword 2)', () => {
    expect(CRAFT_STEPS[0]).toEqual({ itemName: 'oak_planks', count: 8 })
  })
})

describe('schema stubs', () => {
  const stubs: SkillSchemaStub[] = [
    killOnePigSchema,
    cookMeatSchema,
    craftWoodenSwordSchema,
  ]

  it('names match the skill files', () => {
    expect(stubs.map((s) => s.name)).toEqual([
      'killOnePig',
      'cookMeat',
      'craftWoodenSword',
    ])
  })

  it('params are strict-safe: object, additionalProperties false, all properties required', () => {
    for (const stub of stubs) {
      const p = stub.params as {
        type: string
        properties: Record<string, unknown>
        required: string[]
        additionalProperties: boolean
      }
      expect(p.type).toBe('object')
      expect(p.additionalProperties).toBe(false)
      expect([...p.required].sort()).toEqual(Object.keys(p.properties).sort())
    }
  })

  it('failureCodes stay inside the closed vocabulary, non-empty, no duplicates', () => {
    for (const stub of stubs) {
      expect(stub.failureCodes.length).toBeGreaterThan(0)
      expect(new Set(stub.failureCodes).size).toBe(stub.failureCodes.length)
      for (const code of stub.failureCodes) {
        expect(ALL_FAILURE_CODES).toContain(code)
      }
    }
  })

  it('nullable fields are required-nullable (strict mode rejects optional properties)', () => {
    const kill = killOnePigSchema.params as {
      properties: { timeoutMs: { type: string[] } }
      required: string[]
    }
    expect(kill.properties.timeoutMs.type).toEqual(['integer', 'null'])
    expect(kill.required).toContain('timeoutMs')
    const cook = cookMeatSchema.params as {
      properties: { count: { type: string[] }; meat: { type: string } }
      required: string[]
    }
    expect(cook.properties.count.type).toEqual(['integer', 'null'])
    expect(cook.required).toEqual(['meat', 'count'])
    // the meat enum itself is non-nullable — a proper enum, not anyOf
    expect(cook.properties.meat.type).toBe('string')
  })
})
