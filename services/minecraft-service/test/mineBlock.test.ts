import { describe, expect, it } from 'vitest'
import { guardedBlock, type McDataLike } from '../src/skills/names.ts'
import {
  MINE_BLOCK_BASE_BUDGET_MS,
  MINE_BLOCK_MAX_DISTANCE,
  MINE_BLOCK_PER_BLOCK_BUDGET_MS,
  mineBlock,
  type MineBlockDeps,
} from '../src/skills/primitives/mineBlock.ts'
import type { SkillInvocationContext, SkillPosition } from '../src/skills/types.ts'

// Structural fakes only — no mineflayer, no bot (the executor.test.ts /
// relocationReplay.test.ts convention). Name resolution runs the REAL
// guardedBlock over a 1.21.6-shaped mcData slice.

const MC_DATA: McDataLike = {
  itemsByName: {},
  blocksByName: {
    stone: { id: 1, name: 'stone' },
    iron_ore: { id: 4, name: 'iron_ore' },
    // 1.21.6 registry entries Voyager's 1.19-era lists predate
    cherry_log: { id: 2, name: 'cherry_log' },
    pale_oak_log: { id: 3, name: 'pale_oak_log' },
  },
}

const CTX: SkillInvocationContext = {
  biome: 'forest',
  timeOfDay: 6000,
  heldTool: 'iron_pickaxe',
  hostileCount: 0,
  position: { x: 0, y: 64, z: 0 },
}

function posAt(n: number): SkillPosition {
  return { x: n, y: 64, z: -n }
}

/** Deterministic clock owned by the test; deps advance it explicitly. */
function makeClock() {
  let t = 0
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}
type Clock = ReturnType<typeof makeClock>

/** Happy-path deps: every candidate reachable, diggable, one drop each. */
function happyDeps(clock: Clock, positions: SkillPosition[]): MineBlockDeps {
  return {
    resolveBlock: (name) => guardedBlock(MC_DATA, name),
    findBlocks: () => positions,
    gotoBlock: async () => {
      clock.advance(1_000)
      return 'arrived'
    },
    equipBestToolFor: async () => 'equipped',
    dig: async () => {
      clock.advance(500)
      return 'dug'
    },
    collectNearbyDrops: async () => 1,
    now: clock.now,
  }
}

describe('mineBlock — happy path', () => {
  it('collects count blocks and reports honest costMs from deps.now()', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1), posAt(2), posAt(3), posAt(4)])
    const result = await mineBlock(deps, { name: 'stone', count: 3 }, CTX)
    expect(result).toEqual({
      ok: true,
      outcome: { collected: 3 },
      costMs: 3 * 1_500, // three walk+dig cycles on the fake clock
      context: CTX,
    })
  })

  it('defaults count to 1 and stops at the first collected block', async () => {
    const clock = makeClock()
    let digs = 0
    const deps = happyDeps(clock, [posAt(1), posAt(2)])
    const inner = deps.dig
    deps.dig = async (pos) => {
      digs += 1
      return inner(pos)
    }
    const result = await mineBlock(deps, { name: 'stone' }, CTX)
    expect(result.ok).toBe(true)
    expect(digs).toBe(1)
  })

  it('asks the world for candidates by resolved id within the Voyager radius', async () => {
    const clock = makeClock()
    const calls: Array<[number, number, number]> = []
    const deps = happyDeps(clock, [posAt(1)])
    deps.findBlocks = (blockId, maxDistance, count) => {
      calls.push([blockId, maxDistance, count])
      return [posAt(1)]
    }
    await mineBlock(deps, { name: 'iron_ore' }, CTX)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call[0]).toBe(4) // iron_ore id from mcData, not a hardcode
    expect(call[1]).toBe(MINE_BLOCK_MAX_DISTANCE)
    expect(call[2]).toBeGreaterThanOrEqual(1) // over-fetch pool >= target
  })

  it('skips an unreachable candidate and succeeds on the next (ignoreNoPath port)', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1), posAt(2)])
    const walks: Array<'path_not_found' | 'arrived'> = ['path_not_found', 'arrived']
    deps.gotoBlock = async () => walks.shift() ?? 'arrived'
    const result = await mineBlock(deps, { name: 'stone', count: 1 }, CTX)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.outcome.collected).toBe(1)
  })

  it('skips a blocked dig and succeeds on the next candidate', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1), posAt(2)])
    const digs: Array<'blocked' | 'dug'> = ['blocked', 'dug']
    deps.dig = async () => digs.shift() ?? 'dug'
    const result = await mineBlock(deps, { name: 'stone', count: 1 }, CTX)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.outcome.collected).toBe(1)
  })
})

describe('mineBlock — 1.21.6 names', () => {
  it('resolves cherry_log and pale_oak_log (post-Voyager registry entries)', async () => {
    for (const name of ['cherry_log', 'pale_oak_log']) {
      const clock = makeClock()
      const result = await mineBlock(happyDeps(clock, [posAt(1)]), { name }, CTX)
      expect(result.ok).toBe(true)
    }
  })

  it('fails a bogus name with UNSUPPORTED_NAME before touching the world', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1)])
    deps.findBlocks = () => {
      throw new Error('world must not be searched for an unresolvable name')
    }
    const result = await mineBlock(deps, { name: 'chery_log' }, CTX)
    expect(result).toMatchObject({ ok: false, failureCode: 'UNSUPPORTED_NAME' })
  })
})

describe('mineBlock — failure codes', () => {
  it('RESOURCE_NOT_FOUND when the world has no matching blocks', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [])
    const result = await mineBlock(deps, { name: 'iron_ore', count: 2 }, CTX)
    expect(result).toMatchObject({ ok: false, failureCode: 'RESOURCE_NOT_FOUND' })
    if (!result.ok) expect(result.detail).toContain('explore')
  })

  it('RESOURCE_NOT_FOUND when the pool runs dry below target (no budget stop)', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1), posAt(2)])
    const result = await mineBlock(deps, { name: 'stone', count: 5 }, CTX)
    // 2 collected of 5, but the world — not the clock — stopped the run:
    // partial success is reserved for timeout stops, so this is a failure.
    expect(result).toMatchObject({ ok: false, failureCode: 'RESOURCE_NOT_FOUND' })
    if (!result.ok) expect(result.detail).toContain('collected 2 of 5')
  })

  it('PATH_NOT_FOUND when every candidate is unreachable and nothing was collected', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1), posAt(2)])
    deps.gotoBlock = async () => 'path_not_found'
    const result = await mineBlock(deps, { name: 'stone' }, CTX)
    expect(result).toMatchObject({ ok: false, failureCode: 'PATH_NOT_FOUND' })
    if (!result.ok) expect(result.detail).toContain('2 unreachable')
  })

  it('TOOL_REQUIRED when the block needs a tool the pack lacks', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1)])
    deps.equipBestToolFor = async () => 'missing'
    const result = await mineBlock(deps, { name: 'iron_ore' }, CTX)
    expect(result).toMatchObject({ ok: false, failureCode: 'TOOL_REQUIRED' })
  })

  it('TIMEOUT when the walk times out with nothing collected', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1)])
    deps.gotoBlock = async (_pos, timeoutMs) => {
      clock.advance(timeoutMs)
      return 'timeout'
    }
    const result = await mineBlock(deps, { name: 'stone' }, CTX)
    expect(result).toMatchObject({ ok: false, failureCode: 'TIMEOUT' })
    if (!result.ok) expect(result.costMs).toBe(MINE_BLOCK_BASE_BUDGET_MS + MINE_BLOCK_PER_BLOCK_BUDGET_MS)
  })

  it('TIMEOUT when the budget expires between candidates with zero yield', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1), posAt(2)])
    // First cycle digs but the drops vanished (zero pickup) and burned the
    // whole budget; the loop's next budget check must stop with TIMEOUT.
    deps.collectNearbyDrops = async () => {
      clock.advance(MINE_BLOCK_BASE_BUDGET_MS + MINE_BLOCK_PER_BLOCK_BUDGET_MS)
      return 0
    }
    const result = await mineBlock(deps, { name: 'stone' }, CTX)
    expect(result).toMatchObject({ ok: false, failureCode: 'TIMEOUT' })
  })
})

describe('mineBlock — partial collection on timeout', () => {
  it('returns ok with collected < count when >=1 collected and the budget stopped the run', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1), posAt(2), posAt(3), posAt(4)])
    const budgetMs = MINE_BLOCK_BASE_BUDGET_MS + 3 * MINE_BLOCK_PER_BLOCK_BUDGET_MS
    // Each drop sweep costs more than the whole budget: one block lands,
    // then the loop's budget check fires with something already in the pack.
    deps.collectNearbyDrops = async () => {
      clock.advance(budgetMs)
      return 1
    }
    const result = await mineBlock(deps, { name: 'stone', count: 3 }, CTX)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.outcome.collected).toBe(1)
      expect(result.outcome.collected).toBeLessThan(3)
      expect(result.costMs).toBeGreaterThanOrEqual(budgetMs)
    }
  })

  it('a mid-walk timeout with earlier yield is also a partial success', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1), posAt(2), posAt(3)])
    let walks = 0
    deps.gotoBlock = async (_pos, timeoutMs) => {
      walks += 1
      if (walks === 1) return 'arrived'
      clock.advance(timeoutMs)
      return 'timeout'
    }
    const result = await mineBlock(deps, { name: 'stone', count: 3 }, CTX)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.outcome.collected).toBe(1)
  })
})

describe('mineBlock — params hygiene', () => {
  it('clamps a non-positive count to 1', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [posAt(1), posAt(2)])
    const result = await mineBlock(deps, { name: 'stone', count: 0 }, CTX)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.outcome.collected).toBe(1)
  })

  it('carries the invocation context through unchanged on failure', async () => {
    const clock = makeClock()
    const deps = happyDeps(clock, [])
    const result = await mineBlock(deps, { name: 'stone' }, CTX)
    expect(result.context).toBe(CTX)
  })
})
