import { describe, expect, it } from 'vitest'
import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
} from '../src/skills/types.ts'
import {
  NAME_ALIASES,
  WOOD_LOGS,
  guardedBlock,
  guardedItem,
  type McDataLike,
} from '../src/skills/names.ts'

const ctx: SkillInvocationContext = {
  biome: 'forest',
  timeOfDay: 1000,
  heldTool: 'wooden_axe',
  hostileCount: 0,
  position: { x: 0, y: 64, z: 0 },
}

const mcData: McDataLike = {
  itemsByName: {
    leather_helmet: { id: 1, name: 'leather_helmet' },
    stick: { id: 2, name: 'stick' },
  },
  blocksByName: {
    cherry_log: { id: 10, name: 'cherry_log' },
    pale_oak_log: { id: 11, name: 'pale_oak_log' },
    lapis_ore: { id: 12, name: 'lapis_ore' },
  },
}

describe('skill result helpers', () => {
  it('skillOk carries outcome, cost, and context', () => {
    const r = skillOk({ collected: 3 }, 1200, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.collected).toBe(3)
      expect(r.costMs).toBe(1200)
      expect(r.context.biome).toBe('forest')
    }
  })

  it('skillFail carries a closed-vocabulary code, never a free string', () => {
    const r = skillFail('RESOURCE_NOT_FOUND', 'no iron_ore within 64 blocks', 800, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('RESOURCE_NOT_FOUND')
      expect(r.detail).toContain('iron_ore')
    }
  })
})

describe('guarded name lookups (1.21.6)', () => {
  it('resolves Voyager-era aliases instead of throwing', () => {
    const r = guardedItem(mcData, 'leather_cap')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.name).toBe('leather_helmet')
  })

  it('lapis_lazuli_ore alias reaches lapis_ore', () => {
    const r = guardedBlock(mcData, 'lapis_lazuli_ore')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.name).toBe('lapis_ore')
  })

  it('unknown names return UNSUPPORTED_NAME, never throw', () => {
    const r = guardedBlock(mcData, 'nonexistent_block')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('UNSUPPORTED_NAME')
      expect(r.detail).toContain('nonexistent_block')
    }
  })

  it('post-1.19 logs are present: cherry, pale oak, bamboo', () => {
    expect(WOOD_LOGS).toContain('cherry_log')
    expect(WOOD_LOGS).toContain('pale_oak_log')
    expect(WOOD_LOGS).toContain('bamboo_block')
    // and the 1.21.6 world actually resolves the 1.20+ names
    expect(guardedBlock(mcData, 'cherry_log').ok).toBe(true)
    expect(guardedBlock(mcData, 'pale_oak_log').ok).toBe(true)
  })

  it('alias table stays alias -> canonical (no identity churn except boots)', () => {
    for (const [from, to] of Object.entries(NAME_ALIASES)) {
      if (from !== 'leather_boots') expect(from).not.toBe(to)
    }
  })
})
