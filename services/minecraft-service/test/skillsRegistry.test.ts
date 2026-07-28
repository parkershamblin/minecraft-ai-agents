import { describe, expect, it, vi } from 'vitest'
import { createSkillRegistry } from '../src/skills/registry.ts'
import type { SkillFailureCode } from '../src/skills/types.ts'

// Structural fake bot: enough surface for registry construction and the
// no-world paths (unknown skill, guarded-name failures, empty-world lookups).
function fakeBot(): any {
  const listeners = new Map<string, Function[]>()
  return {
    entity: { id: 1, position: { distanceTo: () => 99, clone: () => ({ distanceTo: () => 0 }), offset: () => ({ x: 0, z: 0 }), x: 0, y: 64, z: 0 } },
    entities: {},
    time: { timeOfDay: 1000 },
    heldItem: null,
    inventory: { count: () => 0, items: () => [], emptySlotCount: () => 36 },
    world: {},
    on: (ev: string, fn: Function) => { listeners.set(ev, [...(listeners.get(ev) ?? []), fn]) },
    blockAt: () => null,
    findBlock: () => null,
    findBlocks: () => [],
    nearestEntity: () => null,
    recipesAll: () => [],
    lookAt: async () => {},
    pathfinder: { stop: () => {}, goto: async () => {} },
  }
}

const mcData: any = {
  itemsByName: { stick: { id: 1, name: 'stick' }, oak_planks: { id: 2, name: 'oak_planks' } },
  blocksByName: { crafting_table: { id: 10, name: 'crafting_table' }, furnace: { id: 11, name: 'furnace' }, chest: { id: 12, name: 'chest' }, stone: { id: 13, name: 'stone' } },
  items: {},
  biomes: {},
}

const ALL_LIBRARY_SKILLS = [
  'mineWoodLog', 'craftPlanks', 'craftSticks', 'craftCraftingTable', 'craftWoodenPickaxe',
  'collectCobblestone', 'craftStonePickaxe', 'craftStoneAxe', 'craftStoneSword',
  'mineIronOre', 'mineCoalOre', 'craftFurnace', 'smeltIronOre', 'craftIronPickaxe',
  'killOnePig', 'cookMeat', 'craftWoodenSword',
]
const ALL_PRIMITIVES = [
  'mineBlock', 'craftItem', 'placeItem', 'smeltItem',
  'getItemFromChest', 'depositItemIntoChest', 'checkItemInsideChest',
  'killMob', 'exploreUntil', 'givePlacedItemBack',
]

describe('skill registry (assembly)', () => {
  it('registers every library skill and every primitive', () => {
    const reg = createSkillRegistry(fakeBot(), mcData)
    for (const name of [...ALL_LIBRARY_SKILLS, ...ALL_PRIMITIVES]) {
      expect(reg.entries.has(name), `missing: ${name}`).toBe(true)
    }
    expect(reg.entries.size).toBe(ALL_LIBRARY_SKILLS.length + ALL_PRIMITIVES.length)
  })

  it('every library entry carries a schema stub whose name matches its key', () => {
    const reg = createSkillRegistry(fakeBot(), mcData)
    for (const name of ALL_LIBRARY_SKILLS) {
      const entry = reg.entries.get(name)!
      expect(entry.schema, `${name} has no stub`).not.toBeNull()
      expect(entry.schema!.name).toBe(name)
      expect(entry.schema!.failureCodes.length).toBeGreaterThan(0)
    }
  })

  it('unknown skill fails closed with UNSUPPORTED_NAME (never throws)', async () => {
    const reg = createSkillRegistry(fakeBot(), mcData)
    const r = await reg.invoke('growWings')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('UNSUPPORTED_NAME' satisfies SkillFailureCode)
  })

  it('records one SkillInvocationRecord per invoke, drainable, with context', async () => {
    const onRecord = vi.fn()
    const reg = createSkillRegistry(fakeBot(), mcData, onRecord)
    // Empty world: mineWoodLog walks the log family and aggregates honestly.
    const r = await reg.invoke('mineWoodLog', { count: 1 })
    expect(r.ok).toBe(false)
    const drained = reg.drainRecords()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.skill).toBe('mineWoodLog')
    expect(drained[0]!.ok).toBe(false)
    expect(drained[0]!.context?.timeOfDay).toBe(1000)
    expect(onRecord).toHaveBeenCalledTimes(1)
    expect(reg.drainRecords()).toHaveLength(0) // drained means drained
  })

  it('empty-world mineIronOre fails with an actionable substantive code', async () => {
    const reg = createSkillRegistry(fakeBot(), mcData)
    const r = await reg.invoke('mineIronOre', { count: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // Whichever leg fails first, it must be a closed-vocabulary code with prose.
      expect(['RESOURCE_NOT_FOUND', 'UNSUPPORTED_NAME', 'TOOL_REQUIRED']).toContain(r.failureCode)
      expect(r.detail.length).toBeGreaterThan(10)
    }
  })
})
