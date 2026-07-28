import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOVELTY_FRACTION,
  deprecation,
  masteryGate,
  refinementQueue,
  retrievalOrder,
  selectSkill,
  type SkillStatsLike,
} from '../src/skills/policy.ts'

function row(partial: Partial<SkillStatsLike> & { skill: string }): SkillStatsLike {
  return {
    attempts: 0,
    successes: 0,
    successRate: 0,
    trailingRate: 0,
    meanCostMs: 0,
    distinctContexts: 0,
    lastAt: '2026-07-27T00:00:00Z',
    ...partial,
  }
}

function toMap(rows: SkillStatsLike[]): Map<string, SkillStatsLike> {
  return new Map(rows.map((r) => [r.skill, r]))
}

/** Seeded fake rng: replays the given sequence, then repeats the last value. */
function sequenceRng(...values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

describe('masteryGate', () => {
  const stats = toMap([
    row({ skill: 'chop_wood', attempts: 40, successes: 16, successRate: 0.4, trailingRate: 0.4 }),
    row({ skill: 'craft_planks', attempts: 12, successes: 10, successRate: 0.83, trailingRate: 0.9 }),
  ])

  it('blocks new skills while a goal-path skill sits below the threshold', () => {
    const r = masteryGate(
      ['chop_wood', 'craft_planks', 'smelt_iron'],
      ['chop_wood'],
      stats,
      { masteryThreshold: 0.8 },
    )
    expect(r.allowed).toEqual(['chop_wood', 'craft_planks'])
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0]?.skill).toBe('smelt_iron')
    expect(r.blocked[0]?.reason).toContain('chop_wood')
    expect(r.blocked[0]?.reason).toContain('0.8')
  })

  it('always allows refining existing goal-path skills', () => {
    const r = masteryGate(['chop_wood'], ['chop_wood'], stats, {
      masteryThreshold: 0.8,
    })
    expect(r.allowed).toEqual(['chop_wood'])
    expect(r.blocked).toEqual([])
  })

  it('opens once every attempted goal-path skill is at threshold', () => {
    const r = masteryGate(
      ['smelt_iron', 'craft_planks'],
      ['craft_planks'],
      stats,
      { masteryThreshold: 0.8 },
    )
    expect(r.allowed).toEqual(['smelt_iron', 'craft_planks'])
    expect(r.blocked).toEqual([])
  })

  it('a never-attempted goal-path skill does not hold the gate shut (no deadlock)', () => {
    const r = masteryGate(['smelt_iron'], ['smelt_iron'], stats, {
      masteryThreshold: 0.8,
    })
    expect(r.allowed).toEqual(['smelt_iron'])
    expect(r.blocked).toEqual([])
  })
})

describe('refinementQueue', () => {
  it('frequency x failure rate: 60% failing at 100 attempts outranks 90% failing at 10', () => {
    const stats = toMap([
      row({ skill: 'rare_flop', attempts: 10, successes: 1, successRate: 0.1, trailingRate: 0.1 }),
      row({ skill: 'workhorse', attempts: 100, successes: 40, successRate: 0.4, trailingRate: 0.4 }),
    ])
    const queue = refinementQueue(stats)
    expect(queue.map((q) => q.skill)).toEqual(['workhorse', 'rare_flop'])
    expect(queue[0]?.burden).toBeCloseTo(60)
    expect(queue[1]?.burden).toBeCloseTo(9)
  })

  it('omits zero-attempt skills — nothing to refine yet', () => {
    const stats = toMap([
      row({ skill: 'untried' }),
      row({ skill: 'tried', attempts: 5, successes: 2, successRate: 0.4, trailingRate: 0.4 }),
    ])
    expect(refinementQueue(stats).map((q) => q.skill)).toEqual(['tried'])
  })
})

describe('deprecation', () => {
  const opts = { brokenHealthyRate: 0.6, brokenCollapsedRate: 0.2, minAttempts: 5 }

  it('worked-then-stopped yields broken (repair signal)', () => {
    const stats = toMap([
      row({ skill: 'mine_iron', attempts: 50, successes: 40, successRate: 0.8, trailingRate: 0.1 }),
    ])
    const verdicts = deprecation(stats, opts)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]?.skill).toBe('mine_iron')
    expect(verdicts[0]?.verdict).toBe('broken')
    expect(verdicts[0]?.evidence).toContain('worked then stopped')
  })

  it('strict domination on the same outcomeTag yields superseded, naming the dominator', () => {
    const stats = toMap([
      row({
        skill: 'punch_tree',
        attempts: 40, successes: 28, successRate: 0.7, trailingRate: 0.7,
        meanCostMs: 9000, outcomeTag: 'logs',
      }),
      row({
        skill: 'axe_chop',
        attempts: 30, successes: 29, successRate: 0.97, trailingRate: 0.95,
        meanCostMs: 3000, outcomeTag: 'logs',
      }),
    ])
    const verdicts = deprecation(stats, opts)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]?.skill).toBe('punch_tree')
    expect(verdicts[0]?.verdict).toBe('superseded')
    expect(verdicts[0]?.evidence).toContain('axe_chop')
  })

  it('domination must win BOTH axes — a faster but less reliable peer does not supersede', () => {
    const stats = toMap([
      row({
        skill: 'punch_tree',
        attempts: 40, successes: 36, successRate: 0.9, trailingRate: 0.9,
        meanCostMs: 9000, outcomeTag: 'logs',
      }),
      row({
        skill: 'reckless_chop',
        attempts: 30, successes: 15, successRate: 0.5, trailingRate: 0.5,
        meanCostMs: 3000, outcomeTag: 'logs',
      }),
    ])
    expect(deprecation(stats, opts)).toEqual([])
  })

  it('skills with different outcome tags never supersede each other', () => {
    const stats = toMap([
      row({
        skill: 'punch_tree',
        attempts: 40, successes: 28, successRate: 0.7, trailingRate: 0.7,
        meanCostMs: 9000, outcomeTag: 'logs',
      }),
      row({
        skill: 'mine_stone',
        attempts: 30, successes: 29, successRate: 0.97, trailingRate: 0.95,
        meanCostMs: 3000, outcomeTag: 'stone',
      }),
    ])
    expect(deprecation(stats, opts)).toEqual([])
  })
})

describe('retrievalOrder', () => {
  const stats = toMap([
    row({
      skill: 'punch_tree',
      attempts: 40, successes: 28, successRate: 0.7, trailingRate: 0.7,
      meanCostMs: 9000, outcomeTag: 'logs',
    }),
    row({
      skill: 'axe_chop',
      attempts: 30, successes: 29, successRate: 0.97, trailingRate: 0.95,
      meanCostMs: 3000, outcomeTag: 'logs',
    }),
    row({ skill: 'mine_stone', attempts: 60, successes: 30, successRate: 0.5, trailingRate: 0.5 }),
  ])
  const verdicts = deprecation(stats, {
    brokenHealthyRate: 0.99, brokenCollapsedRate: 0.01, minAttempts: 5,
  })

  it('superseded skills are demoted to the tail, never absent', () => {
    expect(verdicts.map((v) => v.skill)).toEqual(['punch_tree'])
    // raw UCB (no verdicts): punch_tree outranks mine_stone
    expect(retrievalOrder(stats, [], { cap: 30 })).toEqual([
      'axe_chop', 'punch_tree', 'mine_stone',
    ])
    // with the superseded verdict it is demoted to the tail — but never absent
    const order = retrievalOrder(stats, verdicts, { cap: 30 })
    expect(order).toEqual(['axe_chop', 'mine_stone', 'punch_tree'])
  })

  it('respects the cap', () => {
    const order = retrievalOrder(stats, [], { cap: 2 })
    expect(order).toHaveLength(2)
  })

  it('zero-attempt skills float to the top for their one try', () => {
    const withNew = new Map(stats)
    withNew.set('brand_new', row({ skill: 'brand_new' }))
    const order = retrievalOrder(withNew, [], { cap: 30 })
    expect(order[0]).toBe('brand_new')
  })
})

describe('selectSkill', () => {
  const stats = toMap([
    row({ skill: 'gather_wood', attempts: 100, successes: 95, successRate: 0.95, trailingRate: 0.95 }),
    row({ skill: 'weak_skill', attempts: 50, successes: 5, successRate: 0.1, trailingRate: 0.1 }),
  ])

  it('UCB tries a zero-attempt skill first', () => {
    const withNew = new Map(stats)
    withNew.set('brand_new', row({ skill: 'brand_new' }))
    const pick = selectSkill(['gather_wood', 'brand_new', 'weak_skill'], withNew, {
      noveltyFraction: DEFAULT_NOVELTY_FRACTION,
      rng: sequenceRng(0.99),
    })
    expect(pick).toEqual({ skill: 'brand_new', via: 'ucb' })
  })

  it('exploits the dominant skill when the novelty gate does not fire', () => {
    const pick = selectSkill(['gather_wood', 'weak_skill'], stats, {
      noveltyFraction: 0.1,
      rng: sequenceRng(0.5),
    })
    expect(pick).toEqual({ skill: 'gather_wood', via: 'ucb' })
  })

  it('escape hatch fires: rng below the fraction picks least-attempted even against a dominant skill', () => {
    const pick = selectSkill(['gather_wood', 'weak_skill'], stats, {
      noveltyFraction: 0.1,
      rng: sequenceRng(0.05, 0),
    })
    expect(pick).toEqual({ skill: 'weak_skill', via: 'novelty' })
  })

  it('novelty picks uniformly among the least-attempted via the injected rng', () => {
    const tied = toMap([
      row({ skill: 'a', attempts: 3, successes: 3, successRate: 1, trailingRate: 1 }),
      row({ skill: 'b', attempts: 3, successes: 0, successRate: 0, trailingRate: 0 }),
      row({ skill: 'busy', attempts: 90, successes: 80, successRate: 0.89, trailingRate: 0.9 }),
    ])
    const first = selectSkill(['busy', 'a', 'b'], tied, {
      noveltyFraction: 0.2,
      rng: sequenceRng(0.1, 0.0),
    })
    const second = selectSkill(['busy', 'a', 'b'], tied, {
      noveltyFraction: 0.2,
      rng: sequenceRng(0.1, 0.9),
    })
    expect(first).toEqual({ skill: 'a', via: 'novelty' })
    expect(second).toEqual({ skill: 'b', via: 'novelty' })
  })

  it('throws on an empty eligible list', () => {
    expect(() =>
      selectSkill([], stats, { noveltyFraction: 0.1, rng: sequenceRng(0.5) }),
    ).toThrow('eligible list is empty')
  })
})
