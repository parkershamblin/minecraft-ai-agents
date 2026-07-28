import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EXPLORE_BLOCKED_STREAK_LIMIT,
  EXPLORE_DEFAULT_MAX_TIME_MS,
  EXPLORE_LEG_DISTANCE,
  EXPLORE_LEG_TIMEOUT_MS,
  exploreUntil,
  type ExploreUntilDeps,
} from '../src/skills/primitives/exploreUntil.ts'
import type { SkillInvocationContext, SkillPosition } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'plains',
  timeOfDay: 6000,
  heldTool: null,
  hostileCount: 0,
  position: { x: 0, y: 64, z: 0 },
}

const EAST: SkillPosition = { x: 1, y: 0, z: 0 }

interface RecordedLeg {
  direction: SkillPosition
  distance: number
  timeoutMs: number
}

/** Structural fake: a virtual clock advanced by moves and sleeps, plus a
 *  scripted per-leg outcome list (default: every leg makes progress). */
function fakeDeps(opts: { legMs?: number; legs?: ReadonlyArray<'moved' | 'blocked'> } = {}) {
  const legMs = opts.legMs ?? 1_000
  let clock = 0
  const moves: RecordedLeg[] = []
  const deps: ExploreUntilDeps = {
    moveInDirection: async (direction, distance, timeoutMs) => {
      moves.push({ direction, distance, timeoutMs })
      clock += legMs
      return opts.legs?.[moves.length - 1] ?? 'moved'
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  }
  return { deps, moves }
}

describe('exploreUntil — happy paths', () => {
  it('finds the target between legs and reports what and when', async () => {
    const { deps, moves } = fakeDeps()
    const r = await exploreUntil(
      deps,
      { direction: EAST },
      () => (moves.length >= 2 ? 'lava_pool' : null),
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.found).toBe('lava_pool')
      expect(r.outcome.elapsedMs).toBeGreaterThan(0)
      expect(r.costMs).toBe(r.outcome.elapsedMs)
    }
    expect(moves.length).toBe(2)
    expect(moves.at(0)?.direction).toEqual(EAST)
    expect(moves.at(0)?.distance).toBe(EXPLORE_LEG_DISTANCE)
  })

  it('predicate satisfied before any movement wins without a single leg', async () => {
    const { deps, moves } = fakeDeps()
    const r = await exploreUntil(deps, { direction: EAST }, () => ({ hit: true }), ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.found).toEqual({ hit: true })
    expect(moves.length).toBe(0)
  })

  it('a match reached on the final leg beats the deadline (last look wins)', async () => {
    const { deps, moves } = fakeDeps({ legMs: 100_000 })
    const r = await exploreUntil(
      deps,
      { direction: EAST, maxTimeMs: 50_000 },
      () => (moves.length >= 1 ? 'found_it' : null),
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.found).toBe('found_it')
  })
})

describe('exploreUntil — TIMEOUT', () => {
  it('budget exhausted without a match returns TIMEOUT and clamps leg budgets', async () => {
    const { deps, moves } = fakeDeps({ legMs: 10_000 })
    const r = await exploreUntil(deps, { direction: EAST, maxTimeMs: 25_000 }, () => null, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TIMEOUT')
      expect(r.costMs).toBeGreaterThanOrEqual(25_000)
      expect(r.detail).toContain('25000ms')
    }
    expect(moves.length).toBe(3)
    // per-leg budget: never more than the leg cap, never more than what remains
    expect(moves.at(0)?.timeoutMs).toBe(EXPLORE_LEG_TIMEOUT_MS)
    expect(moves.at(2)?.timeoutMs).toBe(4_500)
  })

  it('defaults to the 60s Voyager budget when maxTimeMs is omitted', async () => {
    const { deps, moves } = fakeDeps({ legMs: 30_000 })
    const r = await exploreUntil(deps, { direction: EAST }, () => null, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TIMEOUT')
      expect(r.costMs).toBeGreaterThanOrEqual(EXPLORE_DEFAULT_MAX_TIME_MS)
    }
    expect(moves.length).toBe(2)
  })

  it('caps a huge requested budget at 1200s (Voyager parity)', async () => {
    const { deps, moves } = fakeDeps({ legMs: 700_000 })
    const r = await exploreUntil(
      deps,
      { direction: EAST, maxTimeMs: 5_000_000 },
      () => null,
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('TIMEOUT')
    expect(moves.length).toBe(2)
  })
})

describe('exploreUntil — PATH_NOT_FOUND', () => {
  it('three consecutive blocked legs declare the direction impassable', async () => {
    const { deps, moves } = fakeDeps({ legs: ['blocked', 'blocked', 'blocked'] })
    const r = await exploreUntil(deps, { direction: EAST }, () => null, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PATH_NOT_FOUND')
      expect(r.detail).toContain('different direction')
    }
    expect(moves.length).toBe(EXPLORE_BLOCKED_STREAK_LIMIT)
  })

  it('a moved leg resets the blocked streak', async () => {
    const { deps, moves } = fakeDeps({
      legs: ['blocked', 'blocked', 'moved', 'blocked', 'blocked', 'moved'],
    })
    const r = await exploreUntil(
      deps,
      { direction: EAST },
      () => (moves.length >= 6 ? 'through' : null),
      ctx,
    )
    // without the reset, the streak would have tripped at the fourth leg
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome.found).toBe('through')
    expect(moves.length).toBe(6)
  })
})

describe('exploreUntil — INTERNAL', () => {
  it.each([
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 0.5, y: 0, z: 0 },
    { x: 0, y: -2, z: 0 },
  ])('invalid direction %j is a coded failure, never a throw', async (direction) => {
    const { deps, moves } = fakeDeps()
    const r = await exploreUntil(deps, { direction }, () => 'never', ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('-1, 0, or 1')
    }
    expect(moves.length).toBe(0)
  })

  it('maxTimeMs: NaN is INTERNAL, not an endless walk (every >= NaN is false)', async () => {
    const { deps, moves } = fakeDeps()
    const r = await exploreUntil(deps, { direction: EAST, maxTimeMs: Number.NaN }, () => null, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('NaN')
    }
    expect(moves.length).toBe(0)
  })

  it('diagonal unit directions are valid', async () => {
    const { deps } = fakeDeps()
    const r = await exploreUntil(deps, { direction: { x: 1, y: 1, z: 0 } }, () => 'ok', ctx)
    expect(r.ok).toBe(true)
  })

  it('a throwing predicate becomes INTERNAL with the message in the detail', async () => {
    const { deps } = fakeDeps()
    const r = await exploreUntil(
      deps,
      { direction: EAST },
      () => {
        throw new Error('boom in predicate')
      },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('boom in predicate')
    }
  })
})

describe('exploreUntil — no-cheat property', () => {
  it('the primitive source contains no chat-command strings', () => {
    const src = readFileSync(
      new URL('../src/skills/primitives/exploreUntil.ts', import.meta.url),
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
