import { describe, expect, it } from 'vitest'
import { RESOURCE_BLOCKS, RESOURCE_YIELD, blockNamesFor } from '../src/world/resources.ts'

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
