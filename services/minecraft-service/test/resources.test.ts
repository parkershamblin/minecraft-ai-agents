import { describe, expect, it } from 'vitest'
import {
  RESOURCE_BLOCKS,
  RESOURCE_YIELD,
  blockNamesFor,
  allTargetsBlacklistedMessage,
  gatherAnnouncement,
  gatherFailureMessage,
  gatherStartAnnouncement,
  pickGatherTarget,
  planHarvest,
  targetKey,
  scanNearbyResources,
  shouldRescan,
  type DiggableBlock,
  type ScannableBot,
} from '../src/world/resources.ts'

describe('pickGatherTarget', () => {
  const origin = { x: 0, y: 64, z: 0 }
  const near = { x: 2, y: 64, z: 0 }
  const far = { x: 10, y: 64, z: 0 }

  it('picks the nearest candidate when nothing is blacklisted', () => {
    expect(pickGatherTarget([far, near], origin, new Map(), 1_000)).toBe(near)
  })

  it('skips a blacklisted nearest and falls through to the next', () => {
    const blacklist = new Map([[targetKey(near), 5_000]])
    expect(pickGatherTarget([near, far], origin, blacklist, 1_000)).toBe(far)
  })

  it('an expired mark no longer blocks its target — the world may have shifted', () => {
    const blacklist = new Map([[targetKey(near), 5_000]])
    expect(pickGatherTarget([near, far], origin, blacklist, 5_000)).toBe(near)
  })

  it('returns null when every candidate is blacklisted (caller says: move)', () => {
    const blacklist = new Map([
      [targetKey(near), 5_000],
      [targetKey(far), 5_000],
    ])
    expect(pickGatherTarget([near, far], origin, blacklist, 1_000)).toBeNull()
  })

  it('returns null on no candidates at all (plain RESOURCE_NOT_FOUND)', () => {
    expect(pickGatherTarget([], origin, new Map(), 1_000)).toBeNull()
  })
})

describe('allTargetsBlacklistedMessage', () => {
  it('tells the truth — the resource exists, the spot is the problem', () => {
    expect(allTargetsBlacklistedMessage('wood')).toBe(
      'the wood in sight keeps defeating you from this spot — move somewhere new before trying again',
    )
  })
})

describe('gatherStartAnnouncement', () => {
  it('names the resource, the block, and the coordinates a watcher can visit', () => {
    expect(gatherStartAnnouncement('wood', 'spruce_log', { x: -16, y: 145, z: -16 })).toBe(
      'Heading to gather wood — spruce log at (-16, 145, -16).',
    )
  })

  it('rounds fractional target coordinates to whole blocks', () => {
    expect(gatherStartAnnouncement('stone', 'stone', { x: 1.6, y: 64.2, z: -0.4 })).toBe(
      'Heading to gather stone — stone at (2, 64, 0).',
    )
  })
})

describe('gatherAnnouncement', () => {
  it('speaks a plural haul in plain words', () => {
    expect(gatherAnnouncement('spruce_log', 2)).toBe('Gathered 2 spruce logs!')
  })

  it('speaks a single item without the plural s', () => {
    expect(gatherAnnouncement('stone', 1)).toBe('Gathered 1 stone!')
  })

  it('stays silent on an empty haul — announcing a zero would be a lie', () => {
    expect(gatherAnnouncement('spruce_log', 0)).toBeNull()
  })
})

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

/** A fake world: findBlocks behaves like mineflayer's (matcher-filtered, nearest-first, count-capped). */
function botAt(origin: { x: number; y: number; z: number }, blocks: Array<{ name: string; x: number; y: number; z: number }>): ScannableBot & { calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    entity: { position: origin },
    findBlocks: ({ matching, count }) => {
      calls.push(count)
      return blocks
        .filter((b) => matching({ name: b.name }))
        .map((b) => ({ x: b.x, y: b.y, z: b.z }))
        .sort(
          (a, b) =>
            Math.hypot(a.x - origin.x, a.y - origin.y, a.z - origin.z) -
            Math.hypot(b.x - origin.x, b.y - origin.y, b.z - origin.z),
        )
        .slice(0, count)
    },
  }
}

const SCAN = { maxDistance: 48, countCap: 32, yBand: 16 }

describe('scanNearbyResources (the snapshot survey)', () => {
  const origin = { x: 0, y: 120, z: 0 }

  it('reports each sighted family with nearest distance and count', () => {
    const bot = botAt(origin, [
      { name: 'oak_log', x: 3, y: 121, z: 4 }, // distance ~5.1
      { name: 'spruce_log', x: 10, y: 120, z: 0 },
      { name: 'grass_block', x: 0, y: 119, z: 1 },
    ])
    expect(scanNearbyResources(bot, SCAN)).toEqual([
      { family: 'wood', nearestDistance: 5.1, count: 2 },
      { family: 'dirt', nearestDistance: 1.4, count: 1 },
    ])
  })

  it('drops out-of-band sightings and recomputes the nearest from what remains (the cliff-face spruce)', () => {
    const bot = botAt(origin, [
      { name: 'spruce_log', x: 2, y: 140, z: 0 }, // 20 up a rock face — the M2-1 unreachable target
      { name: 'spruce_log', x: 30, y: 122, z: 0 }, // farther but walkable
    ])
    expect(scanNearbyResources(bot, SCAN)).toEqual([{ family: 'wood', nearestDistance: 30.1, count: 1 }])
  })

  it('omits a family whose every match is out of band', () => {
    const bot = botAt(origin, [{ name: 'stone', x: 0, y: 60, z: 0 }]) // the world below
    expect(scanNearbyResources(bot, SCAN)).toEqual([])
  })

  it('returns [] for a scanned-but-empty world (distinct from null = no scan)', () => {
    expect(scanNearbyResources(botAt(origin, []), SCAN)).toEqual([])
  })

  it('returns null before the bot has an entity', () => {
    const bot = botAt(origin, [])
    expect(scanNearbyResources({ ...bot, entity: undefined }, SCAN)).toBeNull()
  })

  it('caps the reported count but asks findBlocks for headroom (the Y-band filter runs after the cap)', () => {
    const everywhere = Array.from({ length: 80 }, (_, i) => ({ name: 'dirt', x: i + 1, y: 120, z: 0 }))
    const bot = botAt(origin, everywhere)
    const [dirt] = scanNearbyResources(bot, SCAN)!
    expect(dirt).toEqual({ family: 'dirt', nearestDistance: 1, count: 32 })
    expect(bot.calls).toEqual([64, 64, 64]) // countCap * 2, once per family
  })
})

describe('shouldRescan (the CPU gate — sweeps are ~175ms each at 20 bots)', () => {
  const GATE = { moveBlocks: 8, maxAgeMs: 60_000 }
  const at = (x: number) => ({ x, y: 120, z: 0 })

  it('always scans when no survey exists yet', () => {
    expect(shouldRescan(null, at(0), 0, GATE)).toBe(true)
  })

  it('skips while the bot stands still and the survey is fresh', () => {
    expect(shouldRescan({ position: at(0), at: 0 }, at(3), 5_000, GATE)).toBe(false)
  })

  it('rescans after real movement', () => {
    expect(shouldRescan({ position: at(0), at: 0 }, at(8), 5_000, GATE)).toBe(true)
  })

  it('rescans a stale survey even without movement (neighbors dig)', () => {
    expect(shouldRescan({ position: at(0), at: 0 }, at(0), 60_000, GATE)).toBe(true)
  })
})
