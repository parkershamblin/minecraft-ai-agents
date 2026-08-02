import { describe, expect, it } from 'vitest'
import {
  STORAGE_FAMILIES,
  isRetryable,
  planItemCounts,
  resolveStorageItems,
  skillVerbError,
  storageFamilyCandidates,
  unwrapSkillResult,
} from '../src/world/skillVerbs.ts'
import { skillFail, skillOk, type SkillInvocationContext } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'forest',
  timeOfDay: 1000,
  heldTool: null,
  hostileCount: 0,
  position: { x: 0, y: 64, z: 0 },
}

/** A registry slice shaped like minecraft-data: bread and cooked_porkchop are
 *  edible, cobblestone is not. */
const registry = {
  itemsByName: {
    bread: { id: 1 },
    cooked_porkchop: { id: 2 },
    cobblestone: { id: 3 },
    oak_log: { id: 4 },
    oak_planks: { id: 5 },
  },
  foods: { 1: {}, 2: {} },
}

describe('storage families', () => {
  it('wood counts logs AND the planks they became — storage thinks in packs, not drops', () => {
    expect(STORAGE_FAMILIES.wood).toContain('oak_log')
    expect(STORAGE_FAMILIES.wood).toContain('oak_planks')
    expect(STORAGE_FAMILIES.wood).toContain('pale_oak_log')
    expect(STORAGE_FAMILIES.wood).toContain('bamboo_block')
    expect(STORAGE_FAMILIES.wood).toContain('bamboo_planks')
    expect(STORAGE_FAMILIES.wood).not.toContain('bamboo_block_planks')
  })

  it('food is absent from the static table — the edible set is version data', () => {
    expect(STORAGE_FAMILIES.food).toBeUndefined()
  })

  it('resolves food live against the registry food table', () => {
    const carried = [
      { name: 'bread', count: 2 },
      { name: 'cobblestone', count: 30 },
      { name: 'cooked_porkchop', count: 5 },
    ]
    expect(resolveStorageItems('food', carried, registry)).toEqual(['cooked_porkchop', 'bread'])
  })

  it('orders by depth so a partial deposit moves the bulk, not a stray', () => {
    const carried = [
      { name: 'oak_log', count: 3 },
      { name: 'oak_planks', count: 12 },
    ]
    expect(resolveStorageItems('wood', carried, registry)).toEqual(['oak_planks', 'oak_log'])
  })

  it('ignores empty stacks and foreign families', () => {
    const carried = [
      { name: 'oak_log', count: 0 },
      { name: 'cobblestone', count: 5 },
    ]
    expect(resolveStorageItems('wood', carried, registry)).toEqual([])
  })

  it('withdrawal candidates do not need a pack — the point is that it is empty', () => {
    expect(storageFamilyCandidates('stone', registry)).toEqual(['cobblestone', 'stone'])
    expect(storageFamilyCandidates('food', registry).sort()).toEqual(['bread', 'cooked_porkchop'])
  })

  it('an unknown family yields nothing rather than throwing', () => {
    expect(storageFamilyCandidates('diamonds', registry)).toEqual([])
    expect(resolveStorageItems('diamonds', [{ name: 'diamond', count: 1 }], registry)).toEqual([])
  })
})

describe('planItemCounts', () => {
  const carried = [
    { name: 'oak_planks', count: 12 },
    { name: 'oak_log', count: 3 },
  ]

  it('spends the deepest stack first and stops at the requested total', () => {
    expect(planItemCounts(['oak_planks', 'oak_log'], carried, 5)).toEqual({ oak_planks: 5 })
  })

  it('spills into the next stack once the first runs out', () => {
    expect(planItemCounts(['oak_planks', 'oak_log'], carried, 14)).toEqual({
      oak_planks: 12,
      oak_log: 2,
    })
  })

  it('asking for more than is carried plans what there is, never a negative', () => {
    expect(planItemCounts(['oak_planks', 'oak_log'], carried, 99)).toEqual({
      oak_planks: 12,
      oak_log: 3,
    })
  })
})

describe('failure translation', () => {
  it('world-state gaps are retryable; pack and knowledge gaps are not', () => {
    // A later tick can put a chest in range or a mob back in view...
    expect(isRetryable('CONTAINER_NOT_FOUND')).toBe(true)
    expect(isRetryable('TARGET_NOT_FOUND')).toBe(true)
    expect(isRetryable('PLACE_FAILED')).toBe(true)
    // ...but the same empty pack fails the same way until the villager acts.
    expect(isRetryable('MISSING_MATERIALS')).toBe(false)
    expect(isRetryable('INVENTORY_FULL')).toBe(false)
    expect(isRetryable('RECIPE_UNAVAILABLE')).toBe(false)
  })

  it('unwraps a success to its outcome', () => {
    expect(unwrapSkillResult(skillOk({ placed: true }, 12, ctx))).toEqual({ placed: true })
  })

  it('throws a coded error carrying the skill detail verbatim — it is the next percept', () => {
    const detail = 'no chest within 16 blocks — craft one (8 planks at a table) and place it first'
    expect(() => unwrapSkillResult(skillFail('CONTAINER_NOT_FOUND', detail, 5, ctx))).toThrow(detail)
    try {
      unwrapSkillResult(skillFail('CONTAINER_NOT_FOUND', detail, 5, ctx))
    } catch (err) {
      const e = err as Error & { code?: string; retryable?: boolean }
      expect(e.code).toBe('CONTAINER_NOT_FOUND')
      expect(e.retryable).toBe(true)
    }
  })

  it('skillVerbError derives retryability from the code, never from the caller', () => {
    const e = skillVerbError('MISSING_MATERIALS', 'you carry no stone') as Error & { retryable?: boolean }
    expect(e.retryable).toBe(false)
  })
})
