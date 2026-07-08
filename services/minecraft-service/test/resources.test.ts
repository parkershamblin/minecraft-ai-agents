import { describe, expect, it } from 'vitest'
import {
  RESOURCE_BLOCKS,
  RESOURCE_YIELD,
  blockNamesFor,
  gatherFailureMessage,
  planHarvest,
  type DiggableBlock,
} from '../src/world/resources.ts'

describe('resource families', () => {
  it('every contract enum value maps to concrete blocks', () => {
    for (const family of ['wood', 'stone', 'dirt']) {
      expect(blockNamesFor(family)!.length).toBeGreaterThan(0)
      expect(RESOURCE_YIELD[family]!.length).toBeGreaterThan(0)
    }
  })

  it('unknown families resolve to undefined (executor maps to INVALID input)', () => {
    expect(blockNamesFor('diamonds')).toBeUndefined()
  })

  it('stone yields cobblestone (what actually drops without silk touch)', () => {
    expect(RESOURCE_YIELD.stone).toContain('cobblestone')
  })

  it('grass_block is harvestable dirt', () => {
    expect(RESOURCE_BLOCKS.dirt).toContain('grass_block')
  })
})

// Item ids for the fakes below (arbitrary — only identity matters).
const STONE_PICKAXE = 700
const WOODEN_PICKAXE = 701
const IRON_AXE = 702
const IRON_SHOVEL = 703
const itemName = (id: number): string | undefined =>
  ({
    [STONE_PICKAXE]: 'stone_pickaxe',
    [WOODEN_PICKAXE]: 'wooden_pickaxe',
    [IRON_AXE]: 'iron_axe',
    [IRON_SHOVEL]: 'iron_shovel',
  })[id]

/** Wood-like: bare hands harvest it; an axe is strictly faster; anything else is hand-speed. */
const log: DiggableBlock = {
  name: 'oak_log',
  canHarvest: () => true,
  digTime: (held) => (held === IRON_AXE ? 400 : 3_000),
}

/** Stone-like: only pickaxes make it drop; better pickaxes dig faster. */
const stone: DiggableBlock = {
  name: 'stone',
  harvestTools: { [STONE_PICKAXE]: true, [WOODEN_PICKAXE]: true },
  canHarvest: (held) => held === STONE_PICKAXE || held === WOODEN_PICKAXE,
  digTime: (held) => (held === STONE_PICKAXE ? 600 : held === WOODEN_PICKAXE ? 1_150 : 7_500),
}

describe('planHarvest (equip the best tool before the dig)', () => {
  it('bare hands suffice when the inventory is empty and the block drops anyway', () => {
    expect(planHarvest(log, [], itemName)).toEqual({ kind: 'dig' })
  })

  it('equips the strictly faster tool for a bare-hand-harvestable block', () => {
    const axe = { type: IRON_AXE, name: 'iron_axe' }
    expect(planHarvest(log, [{ type: STONE_PICKAXE, name: 'stone_pickaxe' }, axe], itemName)).toEqual({
      kind: 'equip',
      item: axe,
    })
  })

  it('does not wave around a tool that is no faster than bare hands', () => {
    expect(planHarvest(log, [{ type: IRON_SHOVEL, name: 'iron_shovel' }], itemName)).toEqual({ kind: 'dig' })
  })

  it('equips the fastest qualifying tool when drops require one', () => {
    const better = { type: STONE_PICKAXE, name: 'stone_pickaxe' }
    expect(planHarvest(stone, [{ type: WOODEN_PICKAXE, name: 'wooden_pickaxe' }, better], itemName)).toEqual({
      kind: 'equip',
      item: better,
    })
  })

  it('blocks a doomed dig (stone, no pickaxe) and names the missing tool class', () => {
    const plan = planHarvest(stone, [{ type: IRON_AXE, name: 'iron_axe' }], itemName)
    expect(plan).toEqual({ kind: 'blocked', toolHint: 'a pickaxe' })
  })

  it('falls back to a generic hint when the registry cannot name the tools', () => {
    const plan = planHarvest({ ...stone, harvestTools: { 999: true } }, [], itemName)
    expect(plan).toEqual({ kind: 'blocked', toolHint: 'a proper tool' })
  })
})

describe('gatherFailureMessage (the percept must teach, not just report)', () => {
  const center = { x: 312.4, y: 120.1, z: -87.2 }

  it('a starved small radius prescribes the contract default 48 and names the search origin', () => {
    const msg = gatherFailureMessage('wood', 10, center)
    expect(msg).toBe('no wood within 10 blocks of (312, 120, -87) — try maxDistance 48 (the cap is 64), or move somewhere new first')
  })

  it('a starved default radius prescribes the cap', () => {
    expect(gatherFailureMessage('wood', 48, center)).toContain('try maxDistance 64')
  })

  it('a starved cap radius prescribes moving, not widening', () => {
    const msg = gatherFailureMessage('stone', 64, center)
    expect(msg).toContain('that is the search cap')
    expect(msg).toContain('move somewhere new')
  })

  it('survives an unknown search origin', () => {
    expect(gatherFailureMessage('dirt', 10, null)).toBe(
      'no dirt within 10 blocks — try maxDistance 48 (the cap is 64), or move somewhere new first',
    )
  })
})
