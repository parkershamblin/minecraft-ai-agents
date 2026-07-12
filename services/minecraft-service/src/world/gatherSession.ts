import type { Position } from './position.ts'

/**
 * The sustained-gather session loop (SV-2): pick→dig→collect per block, up
 * to GatherParams.count blocks in one trip. The loop is pure orchestration —
 * every world touch (finding, walking, digging, announcing, event emission)
 * is injected — so the control flow that matters (partial hauls, first-block
 * failure, watchdog abandonment) is unit-testable without a bot.
 */

/** One block's harvest, as reported by the injected primitive. */
export interface GatherBlockResult {
  blockType: string
  position: Position
  collected: number
}

export interface GatherSessionDeps {
  /**
   * Find, walk to, and harvest exactly one block: fail-fast checks, the
   * blacklist mark, walk, equip, dig, collect, inventory delta. Throws coded
   * errors (RESOURCE_NOT_FOUND / TOOL_REQUIRED) when no block can even be
   * attempted. `announceStart` is true only for the session's first block —
   * one departure line per trip, not per block.
   */
  harvestOne(announceStart: boolean): Promise<GatherBlockResult>
  /**
   * The executor's busy seam, read between blocks. False means the watchdog
   * timed the command out and abandoned this promise — the session is a
   * zombie and must stop producing side effects (walking, digging, chat)
   * immediately. Bounds zombie work to at most the in-flight block, same
   * exposure as the pre-session single-block gather.
   */
  bodyStillOurs(): boolean
  /**
   * One ResourceGathered per attempted block (zero-collect included — the
   * ghost-block record is part of the world's honest history). Per-block
   * emission means a mid-session timeout loses no ledger facts.
   */
  emitBlock(result: GatherBlockResult): void
  /** The single haul announcement, spoken once at session end. */
  announceHaul(byType: Record<string, number>): void
}

export interface GatherSessionResult {
  /** total items that reached the pack across the whole session */
  collected: number
  /** attempts that actually yielded (a ghost block attempts but never yields) */
  blocksDug: number
  attempts: number
  /** positive yields by block type — the haul announcement's input */
  byType: Record<string, number>
  /** last attempted block — keeps the single-block result shape readable */
  blockType: string
  position: Position
  /** why the session ended before `count` blocks, or null if it ran full */
  stoppedEarly: string | null
}

/**
 * Run up to `count` single-block harvests as one session. The first block's
 * failure fails the whole command (nothing was gathered — the coded error
 * carries the prescriptive prose); a later failure ends the session with an
 * honest partial haul instead, because "I brought back 3 of 5" is a
 * completion, not an error.
 */
export async function runGatherSession(count: number, deps: GatherSessionDeps): Promise<GatherSessionResult> {
  const byType: Record<string, number> = {}
  let attempts = 0
  let collected = 0
  let blocksDug = 0
  let last: GatherBlockResult | null = null
  let stoppedEarly: string | null = null

  for (let i = 0; i < count; i++) {
    if (!deps.bodyStillOurs()) {
      stoppedEarly = 'the session was abandoned by the watchdog'
      break
    }
    let result: GatherBlockResult
    try {
      result = await deps.harvestOne(i === 0)
    } catch (err) {
      if (i === 0) {
        throw err // nothing gathered — the command fails with the coded error
      }
      stoppedEarly = err instanceof Error ? err.message : String(err)
      break
    }
    attempts++
    last = result
    deps.emitBlock(result)
    collected += result.collected
    if (result.collected > 0) {
      blocksDug++
      byType[result.blockType] = (byType[result.blockType] ?? 0) + result.collected
    }
  }

  if (!last) {
    // Only reachable when the watchdog cleared the busy seam before the very
    // first attempt — the outcome latch has already suppressed this promise.
    throw new Error('gather session abandoned before any attempt')
  }
  if (collected > 0 && deps.bodyStillOurs()) {
    // A zombie session stays silent: the mind already heard TIMEOUT, and a
    // cheerful announcement after it would gaslight the whole village.
    deps.announceHaul(byType)
  }
  return { collected, blocksDug, attempts, byType, blockType: last.blockType, position: last.position, stoppedEarly }
}
