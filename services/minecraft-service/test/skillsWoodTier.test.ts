import { describe, expect, it, vi } from 'vitest'
import { WOOD_LOGS } from '../src/skills/names.ts'
import type {
  SkillFailureCode,
  SkillInvocationContext,
  SkillResult,
  SkillSchemaStub,
} from '../src/skills/types.ts'
import {
  MINE_WOOD_LOG_FAILURE_CODES,
  mineWoodLog,
  mineWoodLogSchema,
} from '../src/skills/library/mineWoodLog.ts'
import {
  CRAFT_PLANKS_FAILURE_CODES,
  craftPlanks,
  craftPlanksSchema,
  plankNameFor,
} from '../src/skills/library/craftPlanks.ts'
import {
  CRAFT_STICKS_FAILURE_CODES,
  craftSticks,
  craftSticksSchema,
} from '../src/skills/library/craftSticks.ts'
import {
  CRAFT_CRAFTING_TABLE_FAILURE_CODES,
  craftCraftingTable,
  craftCraftingTableSchema,
} from '../src/skills/library/craftCraftingTable.ts'
import {
  CRAFT_WOODEN_PICKAXE_FAILURE_CODES,
  craftWoodenPickaxe,
  craftWoodenPickaxeSchema,
} from '../src/skills/library/craftWoodenPickaxe.ts'

const ctx: SkillInvocationContext = {
  biome: 'forest',
  timeOfDay: 1000,
  heldTool: null,
  hostileCount: 0,
  position: { x: 10, y: 64, z: -5 },
}

function ok<T>(outcome: T, costMs = 10): SkillResult<T> {
  return { ok: true, outcome, costMs, context: ctx }
}

function fail(
  failureCode: SkillFailureCode,
  detail = 'boom',
  costMs = 5,
): SkillResult<never> {
  return { ok: false, failureCode, detail, costMs, context: ctx }
}

/** placeItem that always lands, for the pickaxe happy paths. */
const placeOk = () =>
  vi.fn(async (_params: { name: string; position: { x: number; y: number; z: number } }) =>
    ok({ placed: true as const }),
  )

describe('mineWoodLog', () => {
  it('happy path: first species yields', async () => {
    const mineBlock = vi.fn(async (_params: { name: string; count?: number }) =>
      ok({ collected: 2 }),
    )
    const r = await mineWoodLog({ mineBlock }, { count: 2 }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ collected: 2, log: 'oak_log' })
      expect(r.costMs).toBe(10)
    }
    expect(mineBlock).toHaveBeenCalledTimes(1)
    expect(mineBlock).toHaveBeenCalledWith({ name: 'oak_log', count: 2 })
  })

  it('1.21.6: succeeds via cherry_log when oak (and friends) are absent', async () => {
    const mineBlock = vi.fn(async ({ name }: { name: string; count?: number }) =>
      name === 'cherry_log'
        ? ok({ collected: 1 })
        : fail('RESOURCE_NOT_FOUND', `${name} not nearby`),
    )
    const r = await mineWoodLog({ mineBlock }, {}, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.log).toBe('cherry_log')
    // walked the WOOD_LOGS order up to and including cherry_log
    expect(mineBlock).toHaveBeenCalledTimes(WOOD_LOGS.indexOf('cherry_log') + 1)
    expect(mineBlock).toHaveBeenNthCalledWith(1, { name: 'oak_log', count: 1 })
  })

  it('propagates a substantive primitive failure with the same code, immediately', async () => {
    const mineBlock = vi.fn(async ({ name }: { name: string; count?: number }) =>
      name === 'oak_log'
        ? fail('RESOURCE_NOT_FOUND', 'oak not nearby')
        : fail('PATH_NOT_FOUND', 'cliff in the way'),
    )
    const r = await mineWoodLog({ mineBlock }, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PATH_NOT_FOUND')
      expect(r.detail).toContain('cliff in the way')
    }
    expect(mineBlock).toHaveBeenCalledTimes(2) // stopped at the first substantive failure
  })

  it('normalizes degenerate counts to at least one whole log', async () => {
    const mineBlock = vi.fn(async (_params: { name: string; count?: number }) =>
      ok({ collected: 1 }),
    )
    await mineWoodLog({ mineBlock }, { count: 0 }, ctx)
    expect(mineBlock).toHaveBeenLastCalledWith({ name: 'oak_log', count: 1 })
    await mineWoodLog({ mineBlock }, { count: 2.7 }, ctx)
    expect(mineBlock).toHaveBeenLastCalledWith({ name: 'oak_log', count: 2 })
  })

  it('aggregates all-species misses into RESOURCE_NOT_FOUND with summed cost', async () => {
    const mineBlock = vi.fn(async ({ name }: { name: string; count?: number }) =>
      fail('RESOURCE_NOT_FOUND', `${name} not nearby`),
    )
    const r = await mineWoodLog({ mineBlock }, {}, ctx)
    expect(mineBlock).toHaveBeenCalledTimes(WOOD_LOGS.length)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('RESOURCE_NOT_FOUND')
      expect(r.detail).toContain('pale_oak_log')
      expect(r.costMs).toBe(5 * WOOD_LOGS.length)
    }
  })
})

describe('craftPlanks', () => {
  it('happy path: held materials satisfy the first species', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      ok({ crafted: 4 }),
    )
    const r = await craftPlanks({ mineBlock, craftItem }, {}, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome).toEqual({ crafted: 4, planks: 'oak_planks' })
    expect(craftItem).toHaveBeenCalledWith({ name: 'oak_planks', count: 4 })
    expect(mineBlock).not.toHaveBeenCalled()
  })

  it('recovers MISSING_MATERIALS by mining the log, then retries', async () => {
    let mined = false
    const mineBlock = vi.fn(async ({ name }: { name: string; count?: number }) => {
      if (name !== 'oak_log') return fail('RESOURCE_NOT_FOUND', `${name} not nearby`)
      mined = true
      return ok({ collected: 1 })
    })
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      mined ? ok({ crafted: 4 }) : fail('MISSING_MATERIALS', 'no logs held'),
    )
    const r = await craftPlanks({ mineBlock, craftItem }, { count: 4 }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.planks).toBe('oak_planks')
    // pass 1 tried every species from held materials, pass 2 mined once
    expect(craftItem).toHaveBeenCalledTimes(WOOD_LOGS.length + 1)
    expect(mineBlock).toHaveBeenCalledTimes(1)
    expect(mineBlock).toHaveBeenCalledWith({ name: 'oak_log', count: 1 })
  })

  it('pins to the requested species and sizes the mine to the plank count', async () => {
    let mined = false
    const mineBlock = vi.fn(async (_params: { name: string; count?: number }) => {
      mined = true
      return ok({ collected: 2 })
    })
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      mined ? ok({ crafted: 8 }) : fail('MISSING_MATERIALS', 'no birch held'),
    )
    const r = await craftPlanks(
      { mineBlock, craftItem },
      { count: 8, log: 'birch_log' },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.planks).toBe('birch_planks')
    expect(craftItem).toHaveBeenCalledTimes(2) // only birch, never another species
    expect(craftItem).toHaveBeenNthCalledWith(1, { name: 'birch_planks', count: 8 })
    expect(mineBlock).toHaveBeenCalledWith({ name: 'birch_log', count: 2 })
  })

  it('rejects a non-log species with UNSUPPORTED_NAME before touching primitives', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn()
    const r = await craftPlanks({ mineBlock, craftItem }, { log: 'plastic_log' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('UNSUPPORTED_NAME')
      expect(r.detail).toContain('plastic_log')
    }
    expect(craftItem).not.toHaveBeenCalled()
    expect(mineBlock).not.toHaveBeenCalled()
  })

  it('propagates a substantive craft failure with the same code', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      fail('RECIPE_UNAVAILABLE', 'no recipe for oak_planks'),
    )
    const r = await craftPlanks({ mineBlock, craftItem }, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('RECIPE_UNAVAILABLE')
    expect(craftItem).toHaveBeenCalledTimes(1) // stopped immediately
  })

  it('derives 1.21.6 plank names, including the bamboo special case', () => {
    expect(plankNameFor('oak_log')).toBe('oak_planks')
    expect(plankNameFor('pale_oak_log')).toBe('pale_oak_planks')
    expect(plankNameFor('bamboo_block')).toBe('bamboo_planks')
  })
})

describe('craftSticks', () => {
  it('happy path: held planks satisfy the craft', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      ok({ crafted: 4 }),
    )
    const r = await craftSticks({ mineBlock, craftItem }, {}, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome).toEqual({ crafted: 4 })
    expect(craftItem).toHaveBeenCalledTimes(1)
    expect(craftItem).toHaveBeenCalledWith({ name: 'stick', count: 4 })
  })

  it('recovers MISSING_MATERIALS by crafting planks, then retries', async () => {
    let stickAttempts = 0
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async ({ name, count }: { name: string; count?: number }) => {
      if (name === 'stick') {
        stickAttempts += 1
        return stickAttempts === 1
          ? fail('MISSING_MATERIALS', 'no planks held')
          : ok({ crafted: 4 })
      }
      expect(name).toBe('oak_planks')
      expect(count).toBe(2) // ceil(4 sticks / 4 per craft) * 2 planks per craft
      return ok({ crafted: 2 })
    })
    const r = await craftSticks({ mineBlock, craftItem }, { count: 4 }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.crafted).toBe(4)
    expect(stickAttempts).toBe(2)
    expect(mineBlock).not.toHaveBeenCalled()
  })

  it('propagates a substantive primitive failure with the same code', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      fail('TIMEOUT', 'craft window never opened'),
    )
    const r = await craftSticks({ mineBlock, craftItem }, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('TIMEOUT')
    expect(craftItem).toHaveBeenCalledTimes(1)
  })

  it('propagates the plank recovery failure with its code intact', async () => {
    const mineBlock = vi.fn(async ({ name }: { name: string; count?: number }) =>
      fail('RESOURCE_NOT_FOUND', `${name} not nearby`),
    )
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      fail('MISSING_MATERIALS', 'nothing held'),
    )
    const r = await craftSticks({ mineBlock, craftItem }, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('RESOURCE_NOT_FOUND') // craftPlanks aggregate, unremapped
  })
})

describe('craftCraftingTable', () => {
  it('happy path: held planks satisfy the craft', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      ok({ crafted: 1 }),
    )
    const r = await craftCraftingTable({ mineBlock, craftItem }, {}, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome).toEqual({ crafted: 1 })
    expect(craftItem).toHaveBeenCalledTimes(1)
    expect(craftItem).toHaveBeenCalledWith({ name: 'crafting_table', count: 1 })
  })

  it('recovers MISSING_MATERIALS by crafting 4 planks, then retries', async () => {
    let tableAttempts = 0
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async ({ name, count }: { name: string; count?: number }) => {
      if (name === 'crafting_table') {
        tableAttempts += 1
        return tableAttempts === 1
          ? fail('MISSING_MATERIALS', 'no planks held')
          : ok({ crafted: 1 })
      }
      expect(name).toBe('oak_planks')
      expect(count).toBe(4)
      return ok({ crafted: 4 })
    })
    const r = await craftCraftingTable({ mineBlock, craftItem }, {}, ctx)
    expect(r.ok).toBe(true)
    expect(tableAttempts).toBe(2)
  })

  it('propagates a substantive primitive failure with the same code', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      fail('INTERNAL', 'mineflayer threw'),
    )
    const r = await craftCraftingTable({ mineBlock, craftItem }, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('mineflayer threw')
    }
  })
})

describe('craftWoodenPickaxe', () => {
  it('happy path: planks -> sticks -> table -> place -> craft, in order', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async ({ count }: { name: string; count?: number }) =>
      ok({ crafted: count ?? 1 }),
    )
    const placeItem = placeOk()
    const r = await craftWoodenPickaxe({ mineBlock, craftItem, placeItem }, {}, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.crafted).toBe(1)
      // Voyager's offset(1, 0, 0) from the bot position
      expect(r.outcome.tablePosition).toEqual({ x: 11, y: 64, z: -5 })
    }
    const craftedNames = craftItem.mock.calls.map(([params]) => params.name)
    expect(craftedNames[0]).toBe('oak_planks') // material step ran first
    expect(craftedNames).toContain('stick')
    expect(craftedNames).toContain('crafting_table')
    expect(craftedNames[craftedNames.length - 1]).toBe('wooden_pickaxe')
    expect(placeItem).toHaveBeenCalledTimes(1)
    expect(placeItem).toHaveBeenCalledWith({
      name: 'crafting_table',
      position: { x: 11, y: 64, z: -5 },
    })
  })

  it('honors an explicit table position', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      ok({ crafted: 1 }),
    )
    const placeItem = placeOk()
    const tablePosition = { x: 0, y: 70, z: 0 }
    const r = await craftWoodenPickaxe(
      { mineBlock, craftItem, placeItem },
      { tablePosition },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.tablePosition).toEqual(tablePosition)
    expect(placeItem).toHaveBeenCalledWith({ name: 'crafting_table', position: tablePosition })
  })

  it('propagates PLACE_FAILED from the placement primitive', async () => {
    const mineBlock = vi.fn()
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      ok({ crafted: 1 }),
    )
    const placeItem = vi.fn(
      async (_params: { name: string; position: { x: number; y: number; z: number } }) =>
        fail('PLACE_FAILED', 'no solid ground'),
    )
    const r = await craftWoodenPickaxe({ mineBlock, craftItem, placeItem }, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PLACE_FAILED')
      expect(r.detail).toContain('no solid ground')
    }
  })

  it('propagates the first material-step failure and stops the sequence', async () => {
    const mineBlock = vi.fn(async ({ name }: { name: string; count?: number }) =>
      fail('RESOURCE_NOT_FOUND', `${name} not nearby`),
    )
    const craftItem = vi.fn(async (_params: { name: string; count?: number }) =>
      fail('MISSING_MATERIALS', 'nothing held'),
    )
    const placeItem = placeOk()
    const r = await craftWoodenPickaxe({ mineBlock, craftItem, placeItem }, {}, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('RESOURCE_NOT_FOUND') // plank step aggregate, unremapped
    expect(placeItem).not.toHaveBeenCalled()
  })
})

describe('schema stubs', () => {
  const stubs: Array<[SkillSchemaStub, readonly SkillFailureCode[]]> = [
    [mineWoodLogSchema, MINE_WOOD_LOG_FAILURE_CODES],
    [craftPlanksSchema, CRAFT_PLANKS_FAILURE_CODES],
    [craftSticksSchema, CRAFT_STICKS_FAILURE_CODES],
    [craftCraftingTableSchema, CRAFT_CRAFTING_TABLE_FAILURE_CODES],
    [craftWoodenPickaxeSchema, CRAFT_WOODEN_PICKAXE_FAILURE_CODES],
  ]

  it('every declared failureCode appears in the stub list, with no duplicates', () => {
    for (const [stub, declared] of stubs) {
      for (const code of declared) {
        expect(stub.failureCodes, `${stub.name} is missing ${code}`).toContain(code)
      }
      expect(new Set(stub.failureCodes).size).toBe(stub.failureCodes.length)
    }
  })

  it('params fragments are strict-safe: closed, with every property required', () => {
    for (const [stub] of stubs) {
      const params = stub.params as {
        type: string
        properties: Record<string, unknown>
        required: string[]
        additionalProperties: boolean
      }
      expect(params.type).toBe('object')
      expect(params.additionalProperties).toBe(false)
      expect([...params.required].sort()).toEqual(Object.keys(params.properties).sort())
    }
  })

  it('stub names are unique and match their skill', () => {
    const names = stubs.map(([stub]) => stub.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      'mineWoodLog',
      'craftPlanks',
      'craftSticks',
      'craftCraftingTable',
      'craftWoodenPickaxe',
    ])
  })
})
