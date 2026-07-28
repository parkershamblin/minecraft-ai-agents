// Ported from Voyager's control_primitives/waitForMobRemoved.js (MIT, MineDojo
// Team — see ../VENDORED.md). Substantial rewrite: Voyager's entityGone /
// stoppedAttacking / itemDrop listener soup — which also owned bot.pvp.stop()
// and rejected with a bare Error — becomes a pure poll loop over an injected
// clock. Pvp ownership moved to killMob.ts: this primitive ONLY waits, so it
// composes under any engagement (melee, ranged, none) without touching one.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillResult,
} from '../types.ts'

/** Voyager's default `timeout = 300` seconds. */
export const WAIT_FOR_MOB_REMOVED_DEFAULT_TIMEOUT_MS = 300_000

/** Poll cadence — cheap; mobGone is a map lookup, not a world sweep. */
export const WAIT_FOR_MOB_REMOVED_POLL_INTERVAL_MS = 250

export interface WaitForMobRemovedDeps {
  /** true once the entity has left the world (died or despawned) */
  mobGone(mobId: number): boolean
  now(): number
  sleep(ms: number): Promise<void>
}

export interface WaitForMobRemovedParams {
  mobId: number
  timeoutMs?: number
  pollIntervalMs?: number
}

export interface WaitForMobRemovedOutcome {
  waitedMs: number
}

export async function waitForMobRemoved(
  deps: WaitForMobRemovedDeps,
  params: WaitForMobRemovedParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<WaitForMobRemovedOutcome>> {
  const start = deps.now()
  const timeoutMs = params.timeoutMs ?? WAIT_FOR_MOB_REMOVED_DEFAULT_TIMEOUT_MS
  // floor 1ms: a zero interval on an injected clock would never advance time
  const pollIntervalMs = Math.max(
    1,
    params.pollIntervalMs ?? WAIT_FOR_MOB_REMOVED_POLL_INTERVAL_MS,
  )

  try {
    for (;;) {
      // gone-before-timeout check order: a dead mob is success even at 0ms budget
      if (deps.mobGone(params.mobId)) {
        const waitedMs = deps.now() - start
        return skillOk<WaitForMobRemovedOutcome>({ waitedMs }, waitedMs, ctx)
      }
      const elapsed = deps.now() - start
      if (elapsed >= timeoutMs) {
        return skillFail(
          'TIMEOUT',
          `entity ${params.mobId} still present after ${timeoutMs}ms`,
          elapsed,
          ctx,
        )
      }
      await deps.sleep(Math.min(pollIntervalMs, timeoutMs - elapsed))
    }
  } catch (err) {
    return skillFail(
      'INTERNAL',
      `waitForMobRemoved(${params.mobId}) threw: ${err instanceof Error ? err.message : String(err)}`,
      deps.now() - start,
      ctx,
    )
  }
}
