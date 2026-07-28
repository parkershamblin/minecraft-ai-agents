// Ported from Voyager's control_primitives/shoot.js (MIT, MineDojo Team — see
// ../VENDORED.md). Substantial rewrite: Voyager fired hawkEye.autoAttack and
// abandoned the volley to an empty auto_shot_stopped listener (fire-and-forget,
// always "succeeded"); here the whole minecrafthawkeye engagement sits behind
// one deps closure that resolves with a terminal state, weapons are narrowed to
// the two real launchers, and chat-and-return failures became the closed
// SkillFailureCode vocabulary. The hawkeye plugin itself is wired at assembly —
// this file models the seam, never touches the plugin.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
} from '../types.ts'

/**
 * Launchers only. Voyager's validWeapons also listed throwables (snowball,
 * ender_pearl, egg, splash_potion, trident) that hawkeye can aim but that are
 * useless for the hunting arc — cut to the two the skill layer actually needs.
 */
export type ShootWeapon = 'bow' | 'crossbow'

/** hawkeye arcs well past melee range; beyond this a shot is a prayer */
export const SHOOT_SEARCH_RADIUS = 64

/** terminal states of one full hawkeye engagement (autoAttack → auto_shot_stopped) */
export type HawkeyeShotResult = 'hit' | 'lost' | 'no_ammo'

export interface ShootDeps {
  /** nearest entity with this name within maxDistance blocks, or null */
  findNearestMob(
    name: string,
    maxDistance: number,
  ): { id: number; position: SkillPosition } | null
  /** is the launcher in the inventory? (Voyager's findInventoryItem check) */
  hasWeapon(weapon: ShootWeapon): boolean
  /**
   * One full minecrafthawkeye engagement against the target, wired at
   * assembly. Resolves 'hit' when the volley brought the target down, 'lost'
   * when the target vanished or left range mid-aim, 'no_ammo' when the
   * quiver ran dry before the kill.
   */
  hawkeyeShoot(targetId: number, weapon: ShootWeapon): Promise<HawkeyeShotResult>
  now(): number
}

export interface ShootParams {
  mobName: string
  weapon: ShootWeapon
}

export interface ShootOutcome {
  hit: true
  targetId: number
}

export async function shoot(
  deps: ShootDeps,
  params: ShootParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<ShootOutcome>> {
  const start = deps.now()

  if (!deps.hasWeapon(params.weapon)) {
    return skillFail(
      'TOOL_REQUIRED',
      `no ${params.weapon} in inventory`,
      deps.now() - start,
      ctx,
    )
  }

  const target = deps.findNearestMob(params.mobName, SHOOT_SEARCH_RADIUS)
  if (!target) {
    return skillFail(
      'TARGET_NOT_FOUND',
      `no ${params.mobName} within ${SHOOT_SEARCH_RADIUS} blocks`,
      deps.now() - start,
      ctx,
    )
  }

  try {
    const result = await deps.hawkeyeShoot(target.id, params.weapon)
    switch (result) {
      case 'hit':
        return skillOk<ShootOutcome>(
          { hit: true, targetId: target.id },
          deps.now() - start,
          ctx,
        )
      case 'lost':
        return skillFail(
          'TARGET_NOT_FOUND',
          `${params.mobName} (entity ${target.id}) vanished mid-aim`,
          deps.now() - start,
          ctx,
        )
      case 'no_ammo':
        return skillFail(
          'TOOL_REQUIRED',
          `out of ammunition for ${params.weapon}`,
          deps.now() - start,
          ctx,
        )
      default: {
        const unreachable: never = result
        return skillFail(
          'INTERNAL',
          `unexpected hawkeye state ${String(unreachable)}`,
          deps.now() - start,
          ctx,
        )
      }
    }
  } catch (err) {
    return skillFail(
      'INTERNAL',
      `shoot(${params.mobName}, ${params.weapon}) threw: ${err instanceof Error ? err.message : String(err)}`,
      deps.now() - start,
      ctx,
    )
  }
}
