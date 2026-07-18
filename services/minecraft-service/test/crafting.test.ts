import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  CRAFTABLE_ITEMS,
  type CraftFlowDeps,
  type IngredientGap,
  cheapestGaps,
  craftAnnouncement,
  missingIngredientsMessage,
  noFurnaceMessage,
  noPlacementMessage,
  pickFuel,
  pickTableSpot,
  planSmeltStep,
  resolveCraftTarget,
  runCraftFlow,
  smeltShortYieldMessage,
  tablePlacedAnnouncement,
  tableRequiredMessage,
} from '../src/world/crafting.ts'
import type { Position } from '../src/world/position.ts'

const coded = (err: unknown) => err as Error & { code?: string; retryable?: boolean }

describe('contract tripwire (ajv)', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../../../packages/events/schemas/commands/ActionRequested.v1.schema.json', import.meta.url), 'utf8'),
  )

  it('the body handles exactly the CraftParams item enum — a contract commit that grows it fails HERE until the body catches up', () => {
    expect([...CRAFTABLE_ITEMS]).toEqual(schema.$defs.CraftParams.properties.item.enum)
  })

  it('craft is in the committed action enum', () => {
    expect(schema.properties.action.enum).toContain('craft')
  })

  it('craft params validate against the committed CraftParams shape', () => {
    const ajv = new Ajv2020({ allErrors: true })
    addFormats(ajv)
    const validate = ajv.compile(schema.$defs.CraftParams)
    expect(validate({ item: 'crafting_table' })).toBe(true)
    expect(validate({ item: 'diamond_sword' })).toBe(false) // the deferred iron+ tier, pointedly
    expect(validate({})).toBe(false) // item is required
    expect(validate({ item: 'planks', count: 2 })).toBe(false) // additionalProperties: false
  })
})

describe('resolveCraftTarget', () => {
  it('planks resolve to the most-carried log type (wood-family abstraction)', () => {
    expect(
      resolveCraftTarget('planks', [
        { name: 'spruce_log', count: 3 },
        { name: 'oak_log', count: 1 },
      ]),
    ).toBe('spruce_planks')
  })

  it('log counts aggregate across stacks before the most-carried pick', () => {
    expect(
      resolveCraftTarget('planks', [
        { name: 'oak_log', count: 2 },
        { name: 'spruce_log', count: 3 },
        { name: 'oak_log', count: 2 },
      ]),
    ).toBe('oak_planks')
  })

  it('planks without logs teach gathering, coded RESOURCE_NOT_FOUND', () => {
    try {
      resolveCraftTarget('planks', [{ name: 'cobblestone', count: 8 }])
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(coded(err).code).toBe('RESOURCE_NOT_FOUND')
      expect(coded(err).retryable).toBe(false)
      expect(coded(err).message).toContain('gather wood')
    }
  })

  it('sticks resolve to the registry item name', () => {
    expect(resolveCraftTarget('sticks', [])).toBe('stick')
  })

  it('concrete items pass through', () => {
    expect(resolveCraftTarget('wooden_pickaxe', [])).toBe('wooden_pickaxe')
    expect(resolveCraftTarget('furnace', [])).toBe('furnace')
  })

  it('an off-enum item is INVALID_PARAMS and names the craftable set', () => {
    try {
      resolveCraftTarget('diamond_sword', [])
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(coded(err).code).toBe('INVALID_PARAMS')
      expect(coded(err).message).toContain('crafting_table')
      expect(coded(err).message).toContain('wooden_pickaxe')
    }
  })
})

describe('cheapestGaps', () => {
  it('prefers the recipe variant with the smallest shortfall — a half-stocked pack hears about its actual gap', () => {
    const spruce: IngredientGap[] = [
      { name: 'spruce_planks', required: 3, have: 3 },
      { name: 'stick', required: 2, have: 0 },
    ]
    const oak: IngredientGap[] = [
      { name: 'oak_planks', required: 3, have: 0 },
      { name: 'stick', required: 2, have: 0 },
    ]
    expect(cheapestGaps([oak, spruce])).toEqual(spruce)
  })

  it('breaks ties toward known progression materials, not exotic variants', () => {
    const bamboo: IngredientGap[] = [{ name: 'bamboo', required: 2, have: 0 }]
    const planks: IngredientGap[] = [{ name: 'oak_planks', required: 2, have: 0 }]
    expect(cheapestGaps([bamboo, planks])).toEqual(planks)
  })

  it('breaks equal-shortfall ties toward the wood the villager can make from carried logs (live wart, 2026-07-17: Maren with 343 dark oak logs was told to find cherry planks)', () => {
    const cherry: IngredientGap[] = [
      { name: 'cherry_planks', required: 2, have: 0 },
      { name: 'stick', required: 1, have: 0 },
    ]
    const darkOak: IngredientGap[] = [
      { name: 'dark_oak_planks', required: 2, have: 0 },
      { name: 'stick', required: 1, have: 0 },
    ]
    expect(cheapestGaps([cherry, darkOak], [{ name: 'dark_oak_log', count: 343 }])).toEqual(darkOak)
  })

  it('an item with no recipes yields no gaps', () => {
    expect(cheapestGaps([])).toEqual([])
  })
})

describe('prescriptive prose', () => {
  it('missing ingredients name the recipe, the shortfall, and the next step up the chain', () => {
    const message = missingIngredientsMessage('wooden_pickaxe', [
      { name: 'spruce_planks', required: 3, have: 1 },
      { name: 'stick', required: 2, have: 0 },
    ])
    expect(message).toContain('3 spruce planks')
    expect(message).toContain('2 stick')
    expect(message).toContain('1 of the 3 spruce planks')
    expect(message).toContain('no stick')
    expect(message).toContain('craft planks from your logs first')
  })

  it('a sticks-only shortfall teaches sticks-from-planks', () => {
    const message = missingIngredientsMessage('wooden_sword', [
      { name: 'oak_planks', required: 2, have: 2 },
      { name: 'stick', required: 1, have: 0 },
    ])
    expect(message).toContain('craft sticks from planks first')
  })

  it('a cobblestone shortfall teaches the pickaxe requirement', () => {
    const message = missingIngredientsMessage('furnace', [{ name: 'cobblestone', required: 8, have: 2 }])
    expect(message).toContain('gather stone first')
    expect(message).toContain('pickaxe')
  })

  it('the table-required message names the fix and its cost', () => {
    const message = tableRequiredMessage('wooden_pickaxe')
    expect(message).toContain('crafting table')
    expect(message).toContain('craft a crafting_table first')
    expect(message).toContain('4 planks')
  })

  it('announcements pluralize honestly and stay silent on nothing', () => {
    expect(craftAnnouncement('crafting_table', 1)).toBe('Crafted a crafting table!')
    expect(craftAnnouncement('spruce_planks', 4)).toBe('Crafted 4 spruce planks!')
    expect(craftAnnouncement('stick', 4)).toBe('Crafted 4 sticks!')
    expect(tablePlacedAnnouncement({ x: 10.6, y: 64, z: -3.2 })).toBe('Set up a crafting table at (11, 64, -3).')
  })
})

describe('pickTableSpot', () => {
  const key = (p: Position) => `${p.x},${p.y},${p.z}`
  /** flat ground at y=63, air above — with optional overrides */
  const world = (overrides: Record<string, { air: boolean; solid: boolean }> = {}) => {
    return (p: Position) => {
      const cell = overrides[key(p)]
      if (cell) {
        return cell
      }
      if (p.y <= 63) {
        return { air: false, solid: true }
      }
      return { air: true, solid: false }
    }
  }

  it('finds solid ground with two air blocks above, adjacent to the bot', () => {
    const spot = pickTableSpot({ x: 0.5, y: 64, z: 0.5 }, world())
    expect(spot).not.toBeNull()
    expect(spot!.spot.y).toBe(64)
    expect(spot!.ground.y).toBe(63)
    expect(spot!.ground.x !== 0 || spot!.ground.z !== 0).toBe(true) // never the bot's own cell
    expect(Math.abs(spot!.ground.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(spot!.ground.z)).toBeLessThanOrEqual(2)
  })

  it('tolerates one step up or down for hillsides', () => {
    // Every neighboring column is walled up past step-up height; one column
    // sits a step down with air above it — the only legal spot.
    const blocked = (p: Position) => {
      if (p.x === 2 && p.z === 0) {
        // a step down: ground at 62, air above
        return p.y <= 62 ? { air: false, solid: true } : { air: true, solid: false }
      }
      return p.y <= 65 ? { air: false, solid: true } : { air: true, solid: false }
    }
    const spot = pickTableSpot({ x: 0.5, y: 64, z: 0.5 }, blocked)
    expect(spot).toEqual({ ground: { x: 2, y: 62, z: 0 }, spot: { x: 2, y: 63, z: 0 } })
  })

  it('returns null when nothing beside the bot is placeable', () => {
    // Solid everywhere at every level the scan probes — no air above ground.
    const spot = pickTableSpot({ x: 0, y: 64, z: 0 }, () => ({ air: false, solid: true }))
    expect(spot).toBeNull()
    expect(noPlacementMessage()).toContain('move to open ground')
  })
})

describe('runCraftFlow', () => {
  interface Harness {
    deps: CraftFlowDeps
    announced: string[]
    walked: Position[]
    crafts: Array<{ name: string; table: Position | null }>
  }

  function harness(overrides: Partial<CraftFlowDeps> = {}): Harness {
    const announced: string[] = []
    const walked: Position[] = []
    const crafts: Array<{ name: string; table: Position | null }> = []
    let count = 0
    const deps: CraftFlowDeps = {
      carried: () => [{ name: 'oak_log', count: 3 }],
      craftableNow: () => true,
      ingredientGaps: () => [],
      findTable: () => null,
      walkTo: async (p) => {
        walked.push(p)
      },
      placeTable: async () => ({ x: 1, y: 64, z: 0 }),
      findFurnace: () => null,
      placeFurnace: async () => ({ x: 2, y: 64, z: 0 }),
      smelt: async () => 0,
      craft: async (name, table) => {
        crafts.push({ name, table })
        count += 4
      },
      countItem: () => count,
      bodyStillOurs: () => true,
      announce: (line) => announced.push(line),
      position: () => ({ x: 0, y: 64, z: 0 }),
      ...overrides,
    }
    return { deps, announced, walked, crafts }
  }

  it('a 2x2 item crafts in the pack grid — no table, honest delta, one announcement', async () => {
    const h = harness()
    const result = await runCraftFlow('planks', h.deps)
    expect(result).toEqual({
      item: 'planks',
      itemName: 'oak_planks',
      crafted: 4,
      tableUsed: false,
      tablePlaced: false,
      smelted: 0,
      furnaceUsed: false,
      furnacePlaced: false,
      position: { x: 0, y: 64, z: 0 },
    })
    expect(h.crafts).toEqual([{ name: 'oak_planks', table: null }])
    expect(h.announced).toEqual(['Crafted 4 oak planks!'])
  })

  it('a 3x3 recipe walks to a standing table and crafts there', async () => {
    const table = { x: 10, y: 64, z: 5 }
    const h = harness({
      craftableNow: (_name, allowTable) => allowTable, // needs the grid
      findTable: () => table,
    })
    const result = await runCraftFlow('wooden_pickaxe', h.deps)
    expect(h.walked).toEqual([table])
    expect(h.crafts).toEqual([{ name: 'wooden_pickaxe', table }])
    expect(result.tableUsed).toBe(true)
    expect(result.tablePlaced).toBe(false)
  })

  it('with no table standing, a carried table is placed and announced', async () => {
    const placedAt = { x: 1, y: 64, z: 0 }
    const crafted: Array<{ name: string; table: Position | null }> = []
    let pickaxes = 0
    const h = harness({
      carried: () => [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
      ],
      craftableNow: (_name, allowTable) => allowTable,
      placeTable: async () => placedAt,
      craft: async (name, table) => {
        crafted.push({ name, table })
        pickaxes += 1 // a tool recipe yields one
      },
      countItem: () => pickaxes,
    })
    const result = await runCraftFlow('wooden_pickaxe', h.deps)
    expect(h.walked).toEqual([])
    expect(result.tablePlaced).toBe(true)
    expect(crafted).toEqual([{ name: 'wooden_pickaxe', table: placedAt }])
    expect(h.announced[0]).toBe('Set up a crafting table at (1, 64, 0).')
    expect(h.announced[1]).toBe('Crafted a wooden pickaxe!')
  })

  it('no table standing and none carried is TOOL_REQUIRED with the 4-planks teaching', async () => {
    const h = harness({
      carried: () => [
        { name: 'oak_planks', count: 3 },
        { name: 'stick', count: 2 },
      ],
      craftableNow: (_name, allowTable) => allowTable,
    })
    await expect(runCraftFlow('wooden_pickaxe', h.deps)).rejects.toMatchObject({
      code: 'TOOL_REQUIRED',
      retryable: false,
      message: expect.stringContaining('craft a crafting_table first'),
    })
    expect(h.crafts).toEqual([])
  })

  it('missing ingredients fail before any table business, prose from the gap', async () => {
    const findTable = { called: false }
    const h = harness({
      craftableNow: () => false,
      ingredientGaps: () => [
        { name: 'oak_planks', required: 3, have: 0 },
        { name: 'stick', required: 2, have: 0 },
      ],
      findTable: () => {
        findTable.called = true
        return null
      },
    })
    await expect(runCraftFlow('wooden_pickaxe', h.deps)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      retryable: false,
      message: expect.stringContaining('craft planks from your logs first'),
    })
    expect(findTable.called).toBe(false) // ingredients are the deeper gap — no table talk
    expect(h.crafts).toEqual([])
  })

  it('a craft that lands nothing completes with crafted: 0 and stays silent (the ghost-dig honesty rule)', async () => {
    const h = harness({
      craft: async () => {}, // resolves but the pack never changes
    })
    const result = await runCraftFlow('planks', h.deps)
    expect(result.crafted).toBe(0)
    expect(h.announced).toEqual([])
  })

  it('a watchdog-abandoned session goes silent — no craft, no chat (zombie regression)', async () => {
    const h = harness({
      craftableNow: (_name, allowTable) => allowTable,
      findTable: () => ({ x: 10, y: 64, z: 5 }),
      bodyStillOurs: () => false, // the watchdog cleared busy while we walked
    })
    await expect(runCraftFlow('wooden_pickaxe', h.deps)).rejects.toThrow('abandoned by the watchdog')
    expect(h.crafts).toEqual([])
    expect(h.announced).toEqual([])
  })

  it('an abandonment after the craft suppresses the announcement but keeps the honest result', async () => {
    let ours = true
    const h = harness({
      craft: async () => {
        ours = false // the watchdog fires mid-craft
      },
      countItem: () => (ours ? 0 : 4),
      bodyStillOurs: () => ours,
    })
    const result = await runCraftFlow('planks', h.deps)
    expect(result.crafted).toBe(4) // the items are really in the pack — report them
    expect(h.announced).toEqual([]) // but the zombie never speaks
  })

  it('placement failure (no clear ground) propagates coded and retryable', async () => {
    const h = harness({
      carried: () => [{ name: 'crafting_table', count: 1 }],
      craftableNow: (_name, allowTable) => allowTable,
      placeTable: async () => {
        const err = new Error(noPlacementMessage()) as Error & { code?: string; retryable?: boolean }
        err.code = 'PATH_NOT_FOUND'
        err.retryable = true
        throw err
      },
    })
    await expect(runCraftFlow('furnace', h.deps)).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
      retryable: true,
    })
  })
})

describe('pickFuel (the chain-resolution fuel ranking)', () => {
  it('prefers coal over wood products and sizes the burn to the ask', () => {
    const carried = [
      { name: 'oak_planks', count: 20 },
      { name: 'coal', count: 3 },
    ]
    expect(pickFuel(carried, 3)).toEqual({ name: 'coal', count: 1 }) // 8 smelts per coal
    expect(pickFuel(carried, 9)).toEqual({ name: 'coal', count: 2 })
  })

  it('falls back to planks then logs when no coal is carried', () => {
    expect(pickFuel([{ name: 'spruce_planks', count: 4 }], 3)).toEqual({ name: 'spruce_planks', count: 2 })
    expect(pickFuel([{ name: 'oak_log', count: 5 }], 3)).toEqual({ name: 'oak_log', count: 2 })
  })

  it('never burns sticks and returns null when nothing carried covers the ask', () => {
    expect(pickFuel([{ name: 'stick', count: 64 }], 1)).toBeNull()
    expect(pickFuel([{ name: 'oak_planks', count: 1 }], 3)).toBeNull() // 1 plank = 1.5 smelts < 3
    expect(pickFuel([], 1)).toBeNull()
  })
})

describe('planSmeltStep (when the craft chain smelts before crafting)', () => {
  const IRON_GAPS: IngredientGap[] = [
    { name: 'iron_ingot', required: 3, have: 0 },
    { name: 'stick', required: 2, have: 2 },
  ]

  it('plans the smelt when the only unmet gap is smeltable and the raw input is carried', () => {
    const step = planSmeltStep(IRON_GAPS, [
      { name: 'raw_iron', count: 5 },
      { name: 'coal', count: 2 },
      { name: 'stick', count: 2 },
    ])
    expect(step).toEqual({ input: 'raw_iron', output: 'iron_ingot', count: 3, fuel: { name: 'coal', count: 1 } })
  })

  it('a partial ingot stock smelts only the shortfall', () => {
    const step = planSmeltStep(
      [
        { name: 'iron_ingot', required: 3, have: 2 },
        { name: 'stick', required: 2, have: 2 },
      ],
      [
        { name: 'raw_iron', count: 5 },
        { name: 'coal', count: 2 },
      ],
    )
    expect(step?.count).toBe(1)
  })

  it('returns null when a NON-smeltable gap is also unmet — sticks first, no wasted furnace time', () => {
    const step = planSmeltStep(
      [
        { name: 'iron_ingot', required: 3, have: 0 },
        { name: 'stick', required: 2, have: 0 },
      ],
      [
        { name: 'raw_iron', count: 5 },
        { name: 'coal', count: 2 },
      ],
    )
    expect(step).toBeNull()
  })

  it('returns null when the raw input is short — that is a mining problem, taught by the gap prose', () => {
    expect(planSmeltStep(IRON_GAPS, [{ name: 'raw_iron', count: 2 }, { name: 'coal', count: 2 }])).toBeNull()
  })

  it('returns null when nothing in the gaps is smeltable', () => {
    expect(
      planSmeltStep(
        [{ name: 'oak_planks', required: 3, have: 0 }],
        [{ name: 'raw_iron', count: 5 }],
      ),
    ).toBeNull()
  })

  it('raw iron with no fuel is SMELT_FAILED with the fuel teaching', () => {
    try {
      planSmeltStep(IRON_GAPS, [{ name: 'raw_iron', count: 5 }])
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(coded(err).code).toBe('SMELT_FAILED')
      expect(coded(err).retryable).toBe(false)
      expect(coded(err).message).toContain('coal, planks, or logs')
    }
  })
})

describe('runCraftFlow chain-resolution (mine→smelt→craft inside one action)', () => {
  interface ChainHarness {
    deps: CraftFlowDeps
    announced: string[]
    walked: Position[]
    crafts: Array<{ name: string; table: Position | null }>
    smelts: Array<{ input: string; count: number; fuel: { name: string; count: number } }>
  }

  /** iron_pickaxe pack: raw iron + coal + sticks + a table and furnace in the
   *  pack; craftableNow flips true once the smelt lands (ingots exist). */
  function chainHarness(overrides: Partial<CraftFlowDeps> = {}): ChainHarness {
    const announced: string[] = []
    const walked: Position[] = []
    const crafts: Array<{ name: string; table: Position | null }> = []
    const smelts: ChainHarness['smelts'] = []
    let ingots = 0
    let pickaxes = 0
    const deps: CraftFlowDeps = {
      carried: () => [
        { name: 'raw_iron', count: 3 },
        { name: 'coal', count: 2 },
        { name: 'stick', count: 2 },
        { name: 'crafting_table', count: 1 },
        { name: 'furnace', count: 1 },
      ],
      craftableNow: (_name, allowTable) => allowTable && ingots >= 3,
      ingredientGaps: () => [
        { name: 'iron_ingot', required: 3, have: ingots },
        { name: 'stick', required: 2, have: 2 },
      ],
      findTable: () => null,
      walkTo: async (p) => {
        walked.push(p)
      },
      placeTable: async () => ({ x: 1, y: 64, z: 0 }),
      findFurnace: () => null,
      placeFurnace: async () => ({ x: 2, y: 64, z: 0 }),
      smelt: async (step) => {
        smelts.push({ input: step.input, count: step.count, fuel: step.fuel })
        ingots += step.count
        return step.count
      },
      craft: async (name, table) => {
        crafts.push({ name, table })
        pickaxes += 1
      },
      countItem: () => pickaxes,
      bodyStillOurs: () => true,
      announce: (line) => announced.push(line),
      position: () => ({ x: 0, y: 64, z: 0 }),
      ...overrides,
    }
    return { deps, announced, walked, crafts, smelts }
  }

  it('the full chain: place furnace → smelt → place table → craft, every beat announced', async () => {
    const h = chainHarness()
    const result = await runCraftFlow('iron_pickaxe', h.deps)
    expect(h.smelts).toEqual([{ input: 'raw_iron', count: 3, fuel: { name: 'coal', count: 1 } }])
    expect(h.crafts).toEqual([{ name: 'iron_pickaxe', table: { x: 1, y: 64, z: 0 } }])
    expect(result).toMatchObject({
      crafted: 1,
      smelted: 3,
      furnaceUsed: true,
      furnacePlaced: true,
      tableUsed: true,
      tablePlaced: true,
    })
    expect(h.announced).toEqual([
      'Set up a furnace at (2, 64, 0).',
      'Smelted 3 iron ingots!',
      'Set up a crafting table at (1, 64, 0).',
      'Crafted a iron pickaxe!', // craftAnnouncement's article is uniform — cosmetic, not worth a grammar engine
    ])
  })

  it('iron_sword rides the same smelt-inside-craft chain (2 ingots + 1 stick)', async () => {
    let ingots = 0
    const smelts: ChainHarness['smelts'] = []
    const h = chainHarness({
      craftableNow: (_name, allowTable) => allowTable && ingots >= 2,
      ingredientGaps: () => [
        { name: 'iron_ingot', required: 2, have: ingots },
        { name: 'stick', required: 1, have: 2 },
      ],
      smelt: async (step) => {
        smelts.push({ input: step.input, count: step.count, fuel: step.fuel })
        ingots += step.count
        return step.count
      },
    })
    const result = await runCraftFlow('iron_sword', h.deps)
    expect(smelts).toEqual([{ input: 'raw_iron', count: 2, fuel: { name: 'coal', count: 1 } }])
    expect(h.crafts).toEqual([{ name: 'iron_sword', table: { x: 1, y: 64, z: 0 } }])
    expect(result).toMatchObject({ crafted: 1, smelted: 2, furnaceUsed: true, tableUsed: true })
  })

  it('a standing furnace is walked to, not re-placed', async () => {
    const furnace = { x: 9, y: 64, z: 9 }
    const h = chainHarness({ findFurnace: () => furnace })
    const result = await runCraftFlow('iron_pickaxe', h.deps)
    expect(h.walked).toContainEqual(furnace)
    expect(result.furnacePlaced).toBe(false)
    expect(result.furnaceUsed).toBe(true)
  })

  it('no furnace standing or carried is SMELT_FAILED with the 8-cobblestone teaching', async () => {
    const h = chainHarness({
      carried: () => [
        { name: 'raw_iron', count: 3 },
        { name: 'coal', count: 2 },
        { name: 'stick', count: 2 },
      ],
    })
    await expect(runCraftFlow('iron_pickaxe', h.deps)).rejects.toMatchObject({
      code: 'SMELT_FAILED',
      retryable: false,
      message: noFurnaceMessage(),
    })
    expect(h.smelts).toEqual([])
  })

  it('a short smelt (fuel died) is SMELT_FAILED but retryable — the partial yield is in the pack', async () => {
    const h = chainHarness({
      smelt: async (step) => {
        h.smelts.push({ input: step.input, count: step.count, fuel: step.fuel })
        return 1 // the fire died after one ingot
      },
    })
    await expect(runCraftFlow('iron_pickaxe', h.deps)).rejects.toMatchObject({
      code: 'SMELT_FAILED',
      retryable: true,
      message: smeltShortYieldMessage({ input: 'raw_iron', output: 'iron_ingot', count: 3, fuel: { name: 'coal', count: 1 } }, 1),
    })
    expect(h.crafts).toEqual([])
  })

  it('missing raw iron falls through to the gap prose with the mining hint, never the furnace', async () => {
    let furnaceLookups = 0
    const h = chainHarness({
      carried: () => [
        { name: 'coal', count: 2 },
        { name: 'stick', count: 2 },
        { name: 'furnace', count: 1 },
      ],
      findFurnace: () => {
        furnaceLookups++
        return null
      },
    })
    await expect(runCraftFlow('iron_pickaxe', h.deps)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      message: expect.stringContaining('smelted from raw iron'),
    })
    expect(furnaceLookups).toBe(0)
  })

  it('a watchdog abandonment between furnace and smelt goes silent', async () => {
    let ours = true
    const h = chainHarness({
      findFurnace: () => ({ x: 9, y: 64, z: 9 }),
      walkTo: async () => {
        ours = false // the watchdog fires during the walk
      },
      bodyStillOurs: () => ours,
    })
    await expect(runCraftFlow('iron_pickaxe', h.deps)).rejects.toThrow('abandoned by the watchdog')
    expect(h.smelts).toEqual([])
    expect(h.announced).toEqual([])
  })
})
