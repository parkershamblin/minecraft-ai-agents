// Ported from Voyager (MineDojo/Voyager, MIT — attribution in ../VENDORED.md)
// control_primitives/exploreUntil.js. The original drove bot.pathfinder
// directly: random 10-30 block legs re-goaled on a 2s interval, progress
// announced in chat, thrown errors for bad input, and a silent null when time
// ran out. This port is typed and deps-injected (the CraftFlowDeps
// convention): every world touch arrives via ExploreUntilDeps, the leg length
// is pinned for reproducibility, bad input is a coded failure instead of a
// throw, and running out of budget is an honest TIMEOUT result.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
} from '../types.ts'

/** Voyager defaulted to 60s of exploration; kept. */
export const EXPLORE_DEFAULT_MAX_TIME_MS = 60_000

/** Voyager clamped any requested budget to 1200s; kept for parity. */
export const EXPLORE_MAX_TIME_CAP_MS = 1_200_000

/** Blocks per leg. Voyager randomized 10-30 per leg; a fixed mid-range length
 *  keeps runs reproducible (the greedy-decode convention) without changing
 *  the coverage rate. */
export const EXPLORE_LEG_DISTANCE = 16

/** Per-leg pathfinding budget — short so a walled-off leg reports 'blocked'
 *  quickly enough for the streak counter to matter inside one exploration. */
export const EXPLORE_LEG_TIMEOUT_MS = 10_000

/** Pause between legs so chunks and percepts catch up before the next
 *  predicate read (Voyager's 2s re-goal interval served the same purpose). */
export const EXPLORE_SETTLE_MS = 250

/** Consecutive 'blocked' legs before the direction is declared impassable. */
export const EXPLORE_BLOCKED_STREAK_LIMIT = 3

export interface ExploreUntilDeps {
  /** One exploration leg: walk `distance` blocks along `direction` (unit
   *  components), giving the pathfinder at most `timeoutMs`. 'blocked' means
   *  no meaningful progress was made — not an exception. */
  moveInDirection(
    direction: SkillPosition,
    distance: number,
    timeoutMs: number,
  ): Promise<'moved' | 'blocked'>
  now(): number
  sleep(ms: number): Promise<void>
}

export interface ExploreUntilParams {
  /** Unit direction vector — each component -1, 0, or 1; not all zero. */
  direction: SkillPosition
  /** Exploration budget; default EXPLORE_DEFAULT_MAX_TIME_MS, capped at
   *  EXPLORE_MAX_TIME_CAP_MS. */
  maxTimeMs?: number
}

function isUnitComponent(value: number): boolean {
  return value === -1 || value === 0 || value === 1
}

/**
 * Explore along a direction until the predicate finds something, the budget
 * runs out (TIMEOUT), or the way is walled off (PATH_NOT_FOUND). The
 * predicate is evaluated before the first leg (Voyager's pre-check, kept) and
 * again after every leg — including one final look once the budget is spent,
 * so a match reached on the last leg still wins.
 */
export async function exploreUntil<T>(
  deps: ExploreUntilDeps,
  params: ExploreUntilParams,
  predicate: () => T | null,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ found: T; elapsedMs: number }>> {
  const startedAt = deps.now()
  const { direction } = params
  const label = `(${direction.x},${direction.y},${direction.z})`

  if (
    !isUnitComponent(direction.x) ||
    !isUnitComponent(direction.y) ||
    !isUnitComponent(direction.z) ||
    (direction.x === 0 && direction.y === 0 && direction.z === 0)
  ) {
    return skillFail(
      'INTERNAL',
      `direction components must each be -1, 0, or 1 and not all zero — got ${label}`,
      deps.now() - startedAt,
      ctx,
    )
  }

  // Voyager validated maxTime too (it threw on non-numbers). NaN is the one
  // number the cap below cannot absorb: every `elapsed >= NaN` comparison is
  // false, which would explore forever.
  if (params.maxTimeMs !== undefined && Number.isNaN(params.maxTimeMs)) {
    return skillFail(
      'INTERNAL',
      'maxTimeMs must be a number of milliseconds — got NaN',
      deps.now() - startedAt,
      ctx,
    )
  }

  const budgetMs = Math.min(
    params.maxTimeMs ?? EXPLORE_DEFAULT_MAX_TIME_MS,
    EXPLORE_MAX_TIME_CAP_MS,
  )
  let blockedStreak = 0

  for (;;) {
    let found: T | null
    try {
      found = predicate()
    } catch (err) {
      return skillFail(
        'INTERNAL',
        `predicate threw while exploring toward ${label}: ${err instanceof Error ? err.message : String(err)}`,
        deps.now() - startedAt,
        ctx,
      )
    }
    const elapsedMs = deps.now() - startedAt
    if (found !== null && found !== undefined) {
      return skillOk({ found, elapsedMs }, elapsedMs, ctx)
    }
    if (blockedStreak >= EXPLORE_BLOCKED_STREAK_LIMIT) {
      return skillFail(
        'PATH_NOT_FOUND',
        `${blockedStreak} legs in a row blocked heading ${label} — the way is walled off; explore a different direction`,
        elapsedMs,
        ctx,
      )
    }
    if (elapsedMs >= budgetMs) {
      return skillFail(
        'TIMEOUT',
        `explored ${elapsedMs}ms toward ${label} without a match — budget ${budgetMs}ms spent; try another direction or a larger maxTimeMs`,
        elapsedMs,
        ctx,
      )
    }
    const legTimeoutMs = Math.min(EXPLORE_LEG_TIMEOUT_MS, budgetMs - elapsedMs)
    const leg = await deps.moveInDirection(direction, EXPLORE_LEG_DISTANCE, legTimeoutMs)
    blockedStreak = leg === 'blocked' ? blockedStreak + 1 : 0
    await deps.sleep(EXPLORE_SETTLE_MS)
  }
}
