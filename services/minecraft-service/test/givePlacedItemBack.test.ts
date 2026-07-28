import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  GIVE_BACK_GOTO_TIMEOUT_MS,
  givePlacedItemBack,
  type GivePlacedItemBackDeps,
} from '../src/skills/primitives/givePlacedItemBack.ts'
import type { McDataLike } from '../src/skills/names.ts'
import type { SkillInvocationContext, SkillPosition } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'forest',
  timeOfDay: 1000,
  heldTool: 'iron_pickaxe',
  hostileCount: 0,
  position: { x: 10, y: 64, z: -3 },
}

const mcData: McDataLike = {
  itemsByName: {},
  blocksByName: {
    crafting_table: { id: 1, name: 'crafting_table' },
    lapis_ore: { id: 2, name: 'lapis_ore' },
  },
}

const key = (p: SkillPosition) => `${p.x},${p.y},${p.z}`

/** Structural fake: a keyed block world, scripted walk/dig outcomes, and a
 *  virtual clock so costMs is observable without wall time. */
function fakeDeps(
  opts: {
    world?: Record<string, string>
    goto?: 'arrived' | 'blocked'
    dig?: 'dug' | 'blocked'
    collected?: number
  } = {},
) {
  let clock = 0
  const gotoCalls: Array<{ pos: SkillPosition; timeoutMs: number }> = []
  const blockAtCalls: SkillPosition[] = []
  const digCalls: SkillPosition[] = []
  let collectCalls = 0
  const deps: GivePlacedItemBackDeps = {
    mcData,
    blockAt: (pos) => {
      blockAtCalls.push(pos)
      return opts.world?.[key(pos)] ?? null
    },
    dig: async (pos) => {
      digCalls.push(pos)
      clock += 1_500
      return opts.dig ?? 'dug'
    },
    collectNearbyDrops: async () => {
      collectCalls += 1
      clock += 400
      return opts.collected ?? 1
    },
    gotoBlock: async (pos, timeoutMs) => {
      gotoCalls.push({ pos, timeoutMs })
      clock += 2_000
      return opts.goto ?? 'arrived'
    },
    now: () => clock,
  }
  return { deps, gotoCalls, blockAtCalls, digCalls, collectCallCount: () => collectCalls }
}

describe('givePlacedItemBack — happy paths', () => {
  it('walks, verifies, digs the block back up, and collects the drop', async () => {
    const { deps, gotoCalls, digCalls } = fakeDeps({
      world: { '10,64,-3': 'crafting_table' },
    })
    const r = await givePlacedItemBack(
      deps,
      // fractional coordinates floor to the block cell, negatives included
      { name: 'crafting_table', position: { x: 10.4, y: 64.9, z: -2.2 } },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.recovered).toBe(true)
      expect(r.costMs).toBe(3_900)
    }
    expect(gotoCalls.at(0)?.pos).toEqual({ x: 10, y: 64, z: -3 })
    expect(gotoCalls.at(0)?.timeoutMs).toBe(GIVE_BACK_GOTO_TIMEOUT_MS)
    expect(digCalls.at(0)?.x).toBe(10)
    expect(digCalls.at(0)?.z).toBe(-3)
  })

  it('a lost drop is still ok — recovered:false, honesty over optimism', async () => {
    const { deps } = fakeDeps({
      world: { '10,64,-3': 'crafting_table' },
      collected: 0,
    })
    const r = await givePlacedItemBack(
      deps,
      { name: 'crafting_table', position: { x: 10, y: 64, z: -3 } },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.recovered).toBe(false)
  })

  it('Voyager-era aliases resolve before the world comparison', async () => {
    const { deps } = fakeDeps({ world: { '0,12,0': 'lapis_ore' } })
    const r = await givePlacedItemBack(
      deps,
      { name: 'lapis_lazuli_ore', position: { x: 0, y: 12, z: 0 } },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.recovered).toBe(true)
  })
})

describe('givePlacedItemBack — failure codes', () => {
  it('a different block at the position is TARGET_NOT_FOUND and nothing is dug', async () => {
    const { deps, digCalls } = fakeDeps({ world: { '10,64,-3': 'stone' } })
    const r = await givePlacedItemBack(
      deps,
      { name: 'crafting_table', position: { x: 10, y: 64, z: -3 } },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TARGET_NOT_FOUND')
      expect(r.detail).toContain('crafting_table')
      expect(r.detail).toContain('stone')
    }
    expect(digCalls.length).toBe(0)
  })

  it('air or an unloaded chunk is TARGET_NOT_FOUND too', async () => {
    const { deps, digCalls } = fakeDeps()
    const r = await givePlacedItemBack(
      deps,
      { name: 'crafting_table', position: { x: 10, y: 64, z: -3 } },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TARGET_NOT_FOUND')
      expect(r.detail).toContain('nothing')
    }
    expect(digCalls.length).toBe(0)
  })

  it('a refused dig is INTERNAL (not PLACE_FAILED) and nothing is collected', async () => {
    const { deps, collectCallCount } = fakeDeps({
      world: { '10,64,-3': 'crafting_table' },
      dig: 'blocked',
    })
    const r = await givePlacedItemBack(
      deps,
      { name: 'crafting_table', position: { x: 10, y: 64, z: -3 } },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.failureCode).not.toBe('PLACE_FAILED')
      expect(r.detail).toContain('still placed')
    }
    expect(collectCallCount()).toBe(0)
  })

  it('an unreachable block is PATH_NOT_FOUND before any world reads', async () => {
    const { deps, blockAtCalls, digCalls } = fakeDeps({ goto: 'blocked' })
    const r = await givePlacedItemBack(
      deps,
      { name: 'crafting_table', position: { x: 10, y: 64, z: -3 } },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('PATH_NOT_FOUND')
    expect(blockAtCalls.length).toBe(0)
    expect(digCalls.length).toBe(0)
  })

  it('an unknown block name is UNSUPPORTED_NAME with zero world touches', async () => {
    const { deps, gotoCalls, digCalls } = fakeDeps()
    const r = await givePlacedItemBack(
      deps,
      { name: 'not_a_block', position: { x: 10, y: 64, z: -3 } },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('UNSUPPORTED_NAME')
      expect(r.detail).toContain('not_a_block')
    }
    expect(gotoCalls.length).toBe(0)
    expect(digCalls.length).toBe(0)
  })
})

describe('givePlacedItemBack — no-cheat property', () => {
  it('the primitive source contains no chat-command strings', () => {
    const src = readFileSync(
      new URL('../src/skills/primitives/givePlacedItemBack.ts', import.meta.url),
      'utf8',
    )
    const banned = ['give', 'setblock', 'gamerule', 'tp ', 'teleport', 'tellraw'].map(
      (cmd) => '/' + cmd,
    )
    banned.push('bot' + '.chat')
    for (const needle of banned) {
      expect(src).not.toContain(needle)
    }
  })
})
