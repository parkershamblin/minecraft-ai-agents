// Ported from Voyager's control_primitives/killMob.js + the melee half of
// waitForMobRemoved.js (MIT, MineDojo Team — see ../VENDORED.md). Substantial
// rewrite: typed, deps-injected (the bot and mineflayer-pvp live ONLY behind
// KillMobDeps, wired at assembly — the GuardTetherDeps convention), Voyager's
// entityGone/stoppedAttacking listener soup replaced by an injected-clock poll
// loop, and chat-and-return failures replaced by the closed SkillFailureCode
// vocabulary. Voyager's ranged branch (hawkEye when a shooting weapon is in
// hand) lives in shoot.ts; this primitive is the melee path.
//
// The invariant this file is designed around: **killMob returned => pvp is
// disengaged**, on EVERY exit path. A leaked engagement chases mobs across the
// map long after the command that started it died.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
} from '../types.ts'

/** Voyager's nearestEntity filter: entities beyond 48 blocks are not "nearby". */
export const KILL_MOB_SEARCH_RADIUS = 48

/** Voyager's default `timeout = 300` seconds. */
export const KILL_MOB_DEFAULT_TIMEOUT_MS = 300_000

/** Poll cadence while the pvp plugin fights — cheap; mobGone is a map lookup. */
export const KILL_MOB_POLL_INTERVAL_MS = 250

/**
 * Everything killMob touches in the world, injected at assembly. The bot and
 * the mineflayer-pvp plugin never appear here directly, so the primitive is
 * botless-testable.
 */
export interface KillMobDeps {
  /** nearest entity with this name within maxDistance blocks, or null */
  findNearestMob(
    name: string,
    maxDistance: number,
  ): { id: number; position: SkillPosition } | null
  /** start a mineflayer-pvp engagement; resolves once the engagement starts */
  pvpAttack(mobId: number): Promise<void>
  /** disengage; idempotent — called on EVERY exit path */
  pvpStop(): Promise<void>
  /** true once the entity has left the world (died or despawned) */
  mobGone(mobId: number): boolean
  /** sweep nearby item drops; resolves with how many were picked up */
  collectNearbyDrops(): Promise<number>
  now(): number
  sleep(ms: number): Promise<void>
}

export interface KillMobParams {
  mobName: string
  timeoutMs?: number
}

export interface KillMobOutcome {
  killed: true
  dropsCollected: number
}

export async function killMob(
  deps: KillMobDeps,
  params: KillMobParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<KillMobOutcome>> {
  const start = deps.now()
  const timeoutMs = params.timeoutMs ?? KILL_MOB_DEFAULT_TIMEOUT_MS

  const mob = deps.findNearestMob(params.mobName, KILL_MOB_SEARCH_RADIUS)
  if (!mob) {
    // Defensive stop even though this call never attacked: the disengaged
    // invariant must hold on every path, so an engagement leaked by any
    // earlier caller cannot outlive this call.
    await stopQuietly(deps)
    return skillFail(
      'TARGET_NOT_FOUND',
      `no ${params.mobName} within ${KILL_MOB_SEARCH_RADIUS} blocks`,
      deps.now() - start,
      ctx,
    )
  }

  try {
    await deps.pvpAttack(mob.id)
    for (;;) {
      if (deps.mobGone(mob.id)) break
      const elapsed = deps.now() - start
      if (elapsed >= timeoutMs) {
        await deps.pvpStop()
        return skillFail(
          'TIMEOUT',
          `${params.mobName} (entity ${mob.id}) still alive after ${timeoutMs}ms`,
          deps.now() - start,
          ctx,
        )
      }
      await deps.sleep(Math.min(KILL_MOB_POLL_INTERVAL_MS, timeoutMs - elapsed))
    }
    // Disengage BEFORE the drop sweep — collection must not fight.
    await deps.pvpStop()
    const dropsCollected = await deps.collectNearbyDrops()
    return skillOk<KillMobOutcome>(
      { killed: true, dropsCollected },
      deps.now() - start,
      ctx,
    )
  } catch (err) {
    await stopQuietly(deps)
    return skillFail(
      'INTERNAL',
      `killMob(${params.mobName}) threw: ${err instanceof Error ? err.message : String(err)}`,
      deps.now() - start,
      ctx,
    )
  }
}

/** best-effort stop for failure paths — a throwing stop must not mask the real failure */
async function stopQuietly(deps: Pick<KillMobDeps, 'pvpStop'>): Promise<void> {
  try {
    await deps.pvpStop()
  } catch {
    // swallowed: the surrounding path is already reporting its own failure
  }
}
