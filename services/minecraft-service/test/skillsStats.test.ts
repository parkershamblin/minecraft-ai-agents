import { describe, expect, it } from 'vitest'
import type {
  SkillInvocationContext,
  SkillInvocationRecord,
} from '../src/skills/types.ts'
import {
  contextKey,
  foldStats,
  isMastered,
  isPlumbingCode,
  refinementInputs,
  seedFromLedger,
  type LedgerEventLike,
} from '../src/skills/stats.ts'

// Deterministic timestamps from a fixed base — no clock reads anywhere.
const BASE_MS = Date.UTC(2026, 6, 1, 0, 0, 0)
function at(i: number): string {
  return new Date(BASE_MS + i * 1000).toISOString()
}

function ctx(over: Partial<SkillInvocationContext> = {}): SkillInvocationContext {
  return {
    biome: 'forest',
    timeOfDay: 1000,
    heldTool: 'wooden_axe',
    hostileCount: 0,
    position: { x: 0, y: 64, z: 0 },
    ...over,
  }
}

function rec(
  over: Partial<SkillInvocationRecord> & { skill: string; at: string },
): SkillInvocationRecord {
  return {
    ok: true,
    failureCode: null,
    costMs: 1000,
    context: null,
    ...over,
  }
}

describe('contextKey', () => {
  it('null context is the single unknown bucket', () => {
    expect(contextKey(null)).toBe('unknown')
  })

  it('buckets biome × tool tier × day/night', () => {
    expect(contextKey(ctx())).toBe('forest|wooden|day')
    expect(
      contextKey(ctx({ biome: 'desert', heldTool: 'netherite_pickaxe', timeOfDay: 13000 })),
    ).toBe('desert|netherite|night')
  })

  it('day/night boundary: 12000 is day, 12001 is night', () => {
    expect(contextKey(ctx({ timeOfDay: 12000 }))).toBe('forest|wooden|day')
    expect(contextKey(ctx({ timeOfDay: 12001 }))).toBe('forest|wooden|night')
  })

  it('raw world ticks past one day wrap around', () => {
    expect(contextKey(ctx({ timeOfDay: 24000 + 1000 }))).toBe('forest|wooden|day')
    expect(contextKey(ctx({ timeOfDay: 24000 + 13000 }))).toBe('forest|wooden|night')
  })

  it('tool tiers: none for empty hand, other for untiered tools', () => {
    expect(contextKey(ctx({ heldTool: null }))).toBe('forest|none|day')
    expect(contextKey(ctx({ heldTool: 'shears' }))).toBe('forest|other|day')
    expect(contextKey(ctx({ heldTool: 'golden_pickaxe' }))).toBe('forest|other|day')
    expect(contextKey(ctx({ heldTool: 'stone_sword' }))).toBe('forest|stone|day')
    expect(contextKey(ctx({ heldTool: 'iron_pickaxe' }))).toBe('forest|iron|day')
    expect(contextKey(ctx({ heldTool: 'diamond_axe' }))).toBe('forest|diamond|day')
  })

  it('null biome inside a real context buckets as unknown biome', () => {
    expect(contextKey(ctx({ biome: null }))).toBe('unknown|wooden|day')
  })
})

describe('foldStats', () => {
  it('folds a mixed record set: rates, costs, contexts, failure counts', () => {
    const records: SkillInvocationRecord[] = [
      rec({ skill: 'mineOre', at: at(0), ok: true, costMs: 100, context: ctx() }),
      rec({ skill: 'mineOre', at: at(1), ok: true, costMs: 200, context: ctx() }),
      rec({
        skill: 'mineOre',
        at: at(2),
        ok: false,
        failureCode: 'TIMEOUT',
        costMs: 60000,
        context: ctx({ biome: 'desert' }),
      }),
      rec({
        skill: 'mineOre',
        at: at(3),
        ok: false,
        failureCode: 'TOOL_TIER_REQUIRED',
        costMs: 300,
        context: ctx(),
      }),
      rec({
        skill: 'mineOre',
        at: at(4),
        ok: true,
        costMs: 400,
        context: ctx({ timeOfDay: 13000 }),
      }),
      // second skill partitions into its own row
      rec({ skill: 'chopWood', at: at(5), ok: true, costMs: 500, context: ctx() }),
    ]
    const stats = foldStats(records, { windowSize: 10 })
    expect(stats.size).toBe(2)

    const mine = stats.get('mineOre')
    expect(mine).toBeDefined()
    if (!mine) return
    expect(mine.attempts).toBe(5)
    expect(mine.successes).toBe(3)
    expect(mine.successRate).toBeCloseTo(0.6)
    expect(mine.trailingRate).toBeCloseTo(0.6) // window ≥ attempts → lifetime
    expect(mine.meanCostMs).toBeCloseTo((100 + 200 + 60000 + 300 + 400) / 5)
    expect(mine.firstAt).toBe(at(0))
    expect(mine.lastAt).toBe(at(4))
    // contexts: forest|wooden|day (s,s,f), desert|wooden|day (f), forest|wooden|night (s)
    expect(mine.distinctContexts).toBe(3)
    expect(mine.successesByContext.get('forest|wooden|day')).toBe(2)
    expect(mine.successesByContext.get('forest|wooden|night')).toBe(1)
    expect(mine.successesByContext.has('desert|wooden|day')).toBe(false)
    expect(mine.failureCounts.get('TIMEOUT')).toBe(1)
    expect(mine.failureCounts.get('TOOL_TIER_REQUIRED')).toBe(1)

    const chop = stats.get('chopWood')
    expect(chop?.attempts).toBe(1)
    expect(chop?.successRate).toBe(1)
  })

  it('orders by record timestamps, not caller order', () => {
    // Fed newest-first: the trailing window must still be the LATEST records.
    const records = [
      rec({ skill: 's', at: at(3), ok: true }),
      rec({ skill: 's', at: at(2), ok: true }),
      rec({ skill: 's', at: at(1), ok: false, failureCode: 'TIMEOUT' }),
      rec({ skill: 's', at: at(0), ok: false, failureCode: 'TIMEOUT' }),
    ]
    const s = foldStats(records, { windowSize: 2 }).get('s')
    expect(s?.firstAt).toBe(at(0))
    expect(s?.lastAt).toBe(at(3))
    expect(s?.trailingRate).toBe(1) // last two chronologically are successes
  })

  it('computes nearest-rank p90', () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      rec({ skill: 's', at: at(i), costMs: (i + 1) * 100 }),
    )
    const s = foldStats(records, { windowSize: 5 }).get('s')
    expect(s?.p90CostMs).toBe(900) // ceil(0.9 × 10) = 9th smallest
    expect(s?.meanCostMs).toBeCloseTo(550)
  })

  it('a failure with a null code books as INTERNAL, keeping totals honest', () => {
    const records = [
      rec({ skill: 's', at: at(0), ok: false, failureCode: null }),
      rec({ skill: 's', at: at(1), ok: true }),
    ]
    const s = foldStats(records, { windowSize: 5 }).get('s')
    expect(s?.failureCounts.get('INTERNAL')).toBe(1)
  })

  it('rejects a non-positive window', () => {
    expect(() => foldStats([], { windowSize: 0 })).toThrow(RangeError)
  })

  it('empty input folds to an empty map', () => {
    expect(foldStats([], { windowSize: 5 }).size).toBe(0)
  })
})

describe('isMastered — mastered vs overfit', () => {
  it('twenty successes in one forest is overfit, not mastery', () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      rec({ skill: 'chopWood', at: at(i), ok: true, context: ctx() }),
    )
    const s = foldStats(records, { windowSize: 10 }).get('chopWood')
    expect(s).toBeDefined()
    if (!s) return
    expect(s.successes).toBe(20)
    expect(s.successesByContext.size).toBe(1)
    expect(isMastered(s, { minSuccesses: 5, minContexts: 3 })).toBe(false)
  })

  it('six successes across three distinct contexts is mastery', () => {
    const contexts = [
      ctx(), // forest|wooden|day
      ctx({ biome: 'desert', heldTool: 'stone_axe', timeOfDay: 13000 }), // desert|stone|night
      ctx({ biome: 'plains', heldTool: 'iron_axe' }), // plains|iron|day
    ]
    const records = Array.from({ length: 6 }, (_, i) =>
      rec({ skill: 'chopWood', at: at(i), ok: true, context: contexts[i % 3] ?? null }),
    )
    const s = foldStats(records, { windowSize: 10 }).get('chopWood')
    expect(s).toBeDefined()
    if (!s) return
    expect(s.successesByContext.size).toBe(3)
    expect(isMastered(s, { minSuccesses: 5, minContexts: 3 })).toBe(true)
  })

  it('failure-only contexts do not count toward mastery breadth', () => {
    const records = [
      rec({ skill: 's', at: at(0), ok: true, context: ctx() }),
      rec({ skill: 's', at: at(1), ok: true, context: ctx() }),
      rec({ skill: 's', at: at(2), ok: true, context: ctx({ biome: 'plains' }) }),
      rec({ skill: 's', at: at(3), ok: true, context: ctx({ biome: 'plains' }) }),
      rec({ skill: 's', at: at(4), ok: true, context: ctx() }),
      // visited a third context but only ever failed there
      rec({
        skill: 's',
        at: at(5),
        ok: false,
        failureCode: 'TIMEOUT',
        context: ctx({ biome: 'desert' }),
      }),
    ]
    const s = foldStats(records, { windowSize: 10 }).get('s')
    expect(s).toBeDefined()
    if (!s) return
    expect(s.distinctContexts).toBe(3)
    expect(s.successesByContext.size).toBe(2)
    expect(isMastered(s, { minSuccesses: 5, minContexts: 3 })).toBe(false)
  })

  it('ledger-seeded history (null contexts) can never fake breadth', () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      rec({ skill: 'ledger:gather', at: at(i), ok: true, context: null }),
    )
    const s = foldStats(records, { windowSize: 10 }).get('ledger:gather')
    expect(s?.successesByContext.size).toBe(1)
    expect(s?.successesByContext.get('unknown')).toBe(20)
  })
})

describe('trailing window vs lifetime rate', () => {
  it('a recovering skill diverges: lifetime 0.4, trailing 1.0', () => {
    const records = [
      ...Array.from({ length: 6 }, (_, i) =>
        rec({ skill: 's', at: at(i), ok: false, failureCode: 'RESOURCE_NOT_FOUND' }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        rec({ skill: 's', at: at(6 + i), ok: true }),
      ),
    ]
    const s = foldStats(records, { windowSize: 4 }).get('s')
    expect(s?.successRate).toBeCloseTo(0.4)
    expect(s?.trailingRate).toBe(1)
  })

  it('a decaying skill diverges the other way', () => {
    const records = [
      ...Array.from({ length: 6 }, (_, i) => rec({ skill: 's', at: at(i), ok: true })),
      ...Array.from({ length: 4 }, (_, i) =>
        rec({ skill: 's', at: at(6 + i), ok: false, failureCode: 'TIMEOUT' }),
      ),
    ]
    const s = foldStats(records, { windowSize: 4 }).get('s')
    expect(s?.successRate).toBeCloseTo(0.6)
    expect(s?.trailingRate).toBe(0)
  })
})

describe('seedFromLedger', () => {
  const events: LedgerEventLike[] = [
    {
      eventType: 'ActionCompleted',
      occurredAt: at(0),
      payload: { action: 'gather', durationMs: 5000 },
    },
    {
      eventType: 'ActionFailed',
      occurredAt: at(1),
      payload: { action: 'craft', errorCode: 'RESOURCE_NOT_FOUND', durationMs: 800 },
    },
    {
      // wire code with no skill-vocabulary counterpart
      eventType: 'ActionFailed',
      occurredAt: at(2),
      payload: { action: 'hunt', errorCode: 'SMELT_FAILED', durationMs: 300 },
    },
    {
      // errorCode absent entirely
      eventType: 'ActionFailed',
      occurredAt: at(3),
      payload: { action: 'gather' },
    },
    {
      // non-seedable action is skipped
      eventType: 'ActionCompleted',
      occurredAt: at(4),
      payload: { action: 'move', durationMs: 1000 },
    },
  ]

  it('maps gather/craft/hunt events into ledger:<action> records', () => {
    const records = seedFromLedger(events)
    expect(records.map((r) => r.skill)).toEqual([
      'ledger:gather',
      'ledger:craft',
      'ledger:hunt',
      'ledger:gather',
    ])
    const first = records[0]
    expect(first).toMatchObject({
      skill: 'ledger:gather',
      at: at(0),
      ok: true,
      failureCode: null,
      costMs: 5000,
      context: null,
    })
  })

  it('known wire codes map 1:1; unknown and missing codes map to INTERNAL', () => {
    const records = seedFromLedger(events)
    expect(records[1]?.failureCode).toBe('RESOURCE_NOT_FOUND')
    expect(records[2]?.failureCode).toBe('INTERNAL') // SMELT_FAILED collapses
    expect(records[3]?.failureCode).toBe('INTERNAL') // absent code
    expect(records[3]?.costMs).toBe(0) // absent durationMs
  })

  it('isPlumbingCode knows the awareness.py canonical set and nothing else', () => {
    for (const code of [
      'SUPERSEDED',
      'STALE_COMMAND',
      'BODY_BUSY',
      'HAZARD_ESCAPE_IN_PROGRESS',
      'SELF_DEFENSE_IN_PROGRESS',
      'BOT_DISCONNECTED',
    ]) {
      expect(isPlumbingCode(code)).toBe(true)
    }
    expect(isPlumbingCode('TIMEOUT')).toBe(false)
    expect(isPlumbingCode('RESOURCE_NOT_FOUND')).toBe(false)
    expect(isPlumbingCode('')).toBe(false)
  })

  it('callers filter plumbing events BEFORE seeding — the intended pipeline', () => {
    const withPlumbing: LedgerEventLike[] = [
      ...events,
      {
        eventType: 'ActionFailed',
        occurredAt: at(5),
        payload: { action: 'gather', errorCode: 'SUPERSEDED', durationMs: 10 },
      },
      {
        eventType: 'ActionFailed',
        occurredAt: at(6),
        payload: { action: 'hunt', errorCode: 'STALE_COMMAND', durationMs: 10 },
      },
    ]
    const substantive = withPlumbing.filter(
      (e) => e.eventType !== 'ActionFailed' || !isPlumbingCode(e.payload.errorCode ?? ''),
    )
    const records = seedFromLedger(substantive)
    // the two plumbing failures are gone; the four seedable rows remain
    expect(records).toHaveLength(4)
    expect(records.every((r) => r.at !== at(5) && r.at !== at(6))).toBe(true)
  })
})

describe('refinementInputs', () => {
  it('frequent-moderate-failure outranks rare-total-failure', () => {
    const records = [
      // skill A: 100 attempts, 60% failure → burden 60
      ...Array.from({ length: 100 }, (_, i) =>
        rec({
          skill: 'A',
          at: at(i),
          ok: i % 5 < 2, // 40 successes
          failureCode: i % 5 < 2 ? null : 'TIMEOUT',
        }),
      ),
      // skill B: 10 attempts, 90% failure → burden 9
      ...Array.from({ length: 10 }, (_, i) =>
        rec({
          skill: 'B',
          at: at(200 + i),
          ok: i === 0,
          failureCode: i === 0 ? null : 'RESOURCE_NOT_FOUND',
        }),
      ),
    ]
    const rows = refinementInputs(foldStats(records, { windowSize: 10 }))
    expect(rows.map((r) => r.skill)).toEqual(['A', 'B'])
    expect(rows[0]?.frequency).toBe(100)
    expect(rows[0]?.failureBurden).toBe(60) // integer-exact: attempts − successes
    expect(rows[1]?.frequency).toBe(10)
    expect(rows[1]?.failureBurden).toBe(9)
  })

  it('ties break by frequency, then skill name, deterministically', () => {
    const records = [
      // C and D: identical burden 2, identical frequency 4 → name order
      ...Array.from({ length: 4 }, (_, i) =>
        rec({ skill: 'D', at: at(i), ok: i < 2, failureCode: i < 2 ? null : 'TIMEOUT' }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        rec({ skill: 'C', at: at(10 + i), ok: i < 2, failureCode: i < 2 ? null : 'TIMEOUT' }),
      ),
      // E: burden 2 from 8 attempts → higher frequency, ranks first among ties
      ...Array.from({ length: 8 }, (_, i) =>
        rec({ skill: 'E', at: at(20 + i), ok: i < 6, failureCode: i < 6 ? null : 'TIMEOUT' }),
      ),
    ]
    const rows = refinementInputs(foldStats(records, { windowSize: 10 }))
    expect(rows.map((r) => r.skill)).toEqual(['E', 'C', 'D'])
  })
})
