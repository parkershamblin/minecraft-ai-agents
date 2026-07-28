import { describe, expect, it } from 'vitest'
import {
  CRAFTING_TABLE_SEARCH_DISTANCE,
  GOTO_TABLE_TIMEOUT_MS,
  craftItem,
  type CraftItemDeps,
  type Recipe,
} from '../src/skills/primitives/craftItem.ts'
import type { SkillInvocationContext, SkillPosition } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'forest',
  timeOfDay: 6000,
  heldTool: null,
  hostileCount: 0,
  position: { x: 10, y: 64, z: -4 },
}

const STICK = { id: 2, name: 'stick' }
const PLANKS = { id: 3, name: 'oak_planks' }
const PICKAXE = { id: 4, name: 'wooden_pickaxe' }

/** stick recipe: 2 planks, no table, yields 4 */
const stickRecipe: Recipe = {
  requiresTable: false,
  ingredients: [{ itemId: PLANKS.id, name: PLANKS.name, count: 2 }],
}

/** pickaxe recipe: 3 planks + 2 sticks, table required */
const pickaxeRecipe: Recipe = {
  requiresTable: true,
  ingredients: [
    { itemId: PLANKS.id, name: PLANKS.name, count: 3 },
    { itemId: STICK.id, name: STICK.name, count: 2 },
  ],
}

interface FakeWorld {
  deps: CraftItemDeps
  inventory: Map<number, number>
  gotoCalls: Array<{ pos: SkillPosition; timeoutMs: number }>
  craftCalls: Array<{ recipe: Recipe; count: number }>
}

function makeWorld(overrides: Partial<CraftItemDeps> = {}): FakeWorld {
  const inventory = new Map<number, number>()
  const gotoCalls: FakeWorld['gotoCalls'] = []
  const craftCalls: FakeWorld['craftCalls'] = []
  let clock = 0
  const deps: CraftItemDeps = {
    resolveItem: (name) => {
      const known = [STICK, PLANKS, PICKAXE].find((item) => item.name === name)
      if (!known) {
        return { ok: false, failureCode: 'UNSUPPORTED_NAME', detail: `item "${name}" not in minecraft-data for this version` }
      }
      return { ok: true, value: known }
    },
    recipesFor: (itemId, tableNearby) => {
      const all = itemId === STICK.id ? [stickRecipe] : itemId === PICKAXE.id ? [pickaxeRecipe] : []
      return tableNearby ? all : all.filter((recipe) => !recipe.requiresTable)
    },
    craft: async (recipe, count) => {
      craftCalls.push({ recipe, count })
      // honest world mutation: consume ingredients, add yield (sticks come 4 a craft)
      for (const ingredient of recipe.ingredients) {
        const have = inventory.get(ingredient.itemId) ?? 0
        inventory.set(ingredient.itemId, have - ingredient.count * count)
      }
      const produced = recipe === stickRecipe ? STICK.id : PICKAXE.id
      const per = recipe === stickRecipe ? 4 : 1
      inventory.set(produced, (inventory.get(produced) ?? 0) + per * count)
      return 'crafted'
    },
    countInventory: (itemId) => inventory.get(itemId) ?? 0,
    findCraftingTable: () => ({ x: 12, y: 64, z: -2 }),
    gotoBlock: async (pos, timeoutMs) => {
      gotoCalls.push({ pos, timeoutMs })
      return 'arrived'
    },
    now: () => (clock += 50),
    ...overrides,
  }
  return { deps, inventory, gotoCalls, craftCalls }
}

describe('craftItem primitive', () => {
  it('crafts a table-free recipe without walking anywhere', async () => {
    const world = makeWorld()
    world.inventory.set(PLANKS.id, 2)
    const r = await craftItem(world.deps, { name: 'stick' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.crafted).toBe(4) // honest delta: one craft yields 4 sticks
      expect(r.costMs).toBeGreaterThan(0)
      expect(r.context).toBe(ctx)
    }
    expect(world.gotoCalls).toHaveLength(0)
    expect(world.craftCalls).toEqual([{ recipe: stickRecipe, count: 1 }])
  })

  it('walks to the table for a table recipe, with the search radius and walk budget pinned', async () => {
    const world = makeWorld()
    world.inventory.set(PLANKS.id, 3)
    world.inventory.set(STICK.id, 2)
    let searchedDistance = 0
    world.deps.findCraftingTable = (maxDistance) => {
      searchedDistance = maxDistance
      return { x: 12, y: 64, z: -2 }
    }
    const r = await craftItem(world.deps, { name: 'wooden_pickaxe' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.crafted).toBe(1)
    expect(searchedDistance).toBe(CRAFTING_TABLE_SEARCH_DISTANCE)
    expect(world.gotoCalls).toEqual([{ pos: { x: 12, y: 64, z: -2 }, timeoutMs: GOTO_TABLE_TIMEOUT_MS }])
  })

  it('scales the materials check by count', async () => {
    const world = makeWorld()
    world.inventory.set(PLANKS.id, 3) // enough for one stick craft, not two
    const r = await craftItem(world.deps, { name: 'stick', count: 2 }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toContain('1 more oak_planks')
    }
  })

  it('a non-finite count collapses to 1 instead of sailing past the materials check', async () => {
    const world = makeWorld()
    world.inventory.set(PLANKS.id, 2)
    const r = await craftItem(world.deps, { name: 'stick', count: Number.NaN }, ctx)
    expect(r.ok).toBe(true)
    expect(world.craftCalls).toEqual([{ recipe: stickRecipe, count: 1 }])
  })

  it('prefers a satisfiable table-free recipe over an equally satisfiable table recipe', async () => {
    const tableVariant: Recipe = {
      requiresTable: true,
      ingredients: [{ itemId: PLANKS.id, name: PLANKS.name, count: 2 }],
    }
    const freeVariant: Recipe = {
      requiresTable: false,
      ingredients: [{ itemId: PLANKS.id, name: PLANKS.name, count: 2 }],
    }
    const world = makeWorld({ recipesFor: () => [tableVariant, freeVariant] })
    world.inventory.set(PLANKS.id, 2)
    const r = await craftItem(world.deps, { name: 'stick' }, ctx)
    expect(r.ok).toBe(true)
    expect(world.gotoCalls).toHaveLength(0) // no pointless walk to the table
    expect(world.craftCalls).toEqual([{ recipe: freeVariant, count: 1 }])
  })

  it('unknown names fail UNSUPPORTED_NAME straight from the guarded lookup', async () => {
    const world = makeWorld()
    const r = await craftItem(world.deps, { name: 'chunkium_ingot' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('UNSUPPORTED_NAME')
      expect(r.detail).toContain('chunkium_ingot')
    }
    expect(world.craftCalls).toHaveLength(0)
  })

  it('empty recipesFor is guarded: RECIPE_UNAVAILABLE, never a TypeError (Voyager indexed [0] unguarded)', async () => {
    const world = makeWorld({ recipesFor: () => [] })
    const r = await craftItem(world.deps, { name: 'oak_planks' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('RECIPE_UNAVAILABLE')
      expect(r.detail).toContain('oak_planks')
    }
  })

  it('recipe exists only at a table and none is near: RESOURCE_NOT_FOUND naming crafting_table', async () => {
    const world = makeWorld({ findCraftingTable: () => null })
    world.inventory.set(PLANKS.id, 3)
    world.inventory.set(STICK.id, 2)
    const r = await craftItem(world.deps, { name: 'wooden_pickaxe' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('RESOURCE_NOT_FOUND')
      expect(r.detail).toContain('crafting_table')
    }
  })

  it('short materials fail MISSING_MATERIALS with the shortfall named', async () => {
    const world = makeWorld()
    world.inventory.set(PLANKS.id, 3)
    world.inventory.set(STICK.id, 1)
    const r = await craftItem(world.deps, { name: 'wooden_pickaxe' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toContain('1 more stick')
      expect(r.detail).not.toContain('oak_planks') // only the actual gap is taught
    }
    expect(world.craftCalls).toHaveLength(0)
  })

  it('diagnoses from the fewest-missing recipe variant (craftHelper logic)', async () => {
    const expensive: Recipe = {
      requiresTable: false,
      ingredients: [{ itemId: PLANKS.id, name: PLANKS.name, count: 8 }],
    }
    const cheap: Recipe = {
      requiresTable: false,
      ingredients: [{ itemId: STICK.id, name: STICK.name, count: 2 }],
    }
    const world = makeWorld({ recipesFor: () => [expensive, cheap] })
    world.inventory.set(STICK.id, 1)
    const r = await craftItem(world.deps, { name: 'wooden_pickaxe' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toContain('1 more stick')
      expect(r.detail).not.toContain('oak_planks')
    }
  })

  it('an unreachable table fails PATH_NOT_FOUND', async () => {
    const world = makeWorld({ gotoBlock: async () => 'failed' })
    world.inventory.set(PLANKS.id, 3)
    world.inventory.set(STICK.id, 2)
    const r = await craftItem(world.deps, { name: 'wooden_pickaxe' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PATH_NOT_FOUND')
      expect(r.detail).toContain('(12, 64, -2)')
    }
    expect(world.craftCalls).toHaveLength(0)
  })

  it('a craft that reports failed maps to INTERNAL', async () => {
    const world = makeWorld({ craft: async () => 'failed' })
    world.inventory.set(PLANKS.id, 2)
    const r = await craftItem(world.deps, { name: 'stick' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('INTERNAL')
  })

  it('a throwing dep maps to INTERNAL with the message carried, never an escaped exception', async () => {
    const world = makeWorld({
      craft: async () => {
        throw new Error('kaboom in the adapter')
      },
    })
    world.inventory.set(PLANKS.id, 2)
    const r = await craftItem(world.deps, { name: 'stick' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('kaboom in the adapter')
    }
  })
})
