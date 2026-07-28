// Ported from Voyager (MineDojo/Voyager, MIT — attribution in ../VENDORED.md),
// the givePlacedItemBack control primitive. The original assumed a
// cheats-enabled Fabric world: it chatted a doTileDrops-off gamerule, a
// server-side item give, and a setblock-to-air destroy per position, then
// toggled the gamerule back. This stack runs vanilla offline-mode Paper with
// no cheat channel, so the port recovers the item through pure world
// mechanics instead: walk to the placed block, verify it is still the named
// block, dig it back up, and collect the drop. Typed and deps-injected (the
// CraftFlowDeps convention); one position per call — Voyager's batching loop
// belongs to callers.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
} from '../types.ts'
import { guardedBlock, type McDataLike } from '../names.ts'

/** Walk budget to reach the placed block — generous next to dig+collect, and
 *  the placement site is somewhere the bot already stood by definition. */
export const GIVE_BACK_GOTO_TIMEOUT_MS = 20_000

export interface GivePlacedItemBackDeps {
  /** minecraft-data slice for the 1.21.6 name guard (alias-aware lookup —
   *  the "guarded lookups only" convention). */
  mcData: McDataLike
  /** Block name at pos, or null for air/unloaded chunks. */
  blockAt(pos: SkillPosition): string | null
  /** Dig the block at pos with the current tool; 'blocked' means the world
   *  refused (reach, protection) — not an exception. */
  dig(pos: SkillPosition): Promise<'dug' | 'blocked'>
  /** Sweep nearby item entities into the inventory; resolves with how many
   *  were picked up. The chase budget lives in the implementation. */
  collectNearbyDrops(): Promise<number>
  gotoBlock(pos: SkillPosition, timeoutMs: number): Promise<'arrived' | 'blocked'>
  now(): number
}

export interface GivePlacedItemBackParams {
  name: string
  position: SkillPosition
}

/**
 * Take back an item that was placed as a block: dig it up and collect the
 * drop. ok:{recovered:false} means the block WAS removed but the drop never
 * made it into the inventory — honesty over optimism; callers decide whether
 * to re-gather.
 */
export async function givePlacedItemBack(
  deps: GivePlacedItemBackDeps,
  params: GivePlacedItemBackParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ recovered: boolean }>> {
  const startedAt = deps.now()

  const lookup = guardedBlock(deps.mcData, params.name)
  if (!lookup.ok) {
    return skillFail('UNSUPPORTED_NAME', lookup.detail, deps.now() - startedAt, ctx)
  }
  const canonical = lookup.value.name

  const pos: SkillPosition = {
    x: Math.floor(params.position.x),
    y: Math.floor(params.position.y),
    z: Math.floor(params.position.z),
  }
  const label = `(${pos.x},${pos.y},${pos.z})`

  const walk = await deps.gotoBlock(pos, GIVE_BACK_GOTO_TIMEOUT_MS)
  if (walk === 'blocked') {
    return skillFail(
      'PATH_NOT_FOUND',
      `could not reach the placed ${canonical} at ${label} within ${GIVE_BACK_GOTO_TIMEOUT_MS}ms — it stays placed`,
      deps.now() - startedAt,
      ctx,
    )
  }

  const present = deps.blockAt(pos)
  if (present !== canonical) {
    return skillFail(
      'TARGET_NOT_FOUND',
      `expected ${canonical} at ${label} but found ${present ?? 'nothing'} — the placement moved or was already broken`,
      deps.now() - startedAt,
      ctx,
    )
  }

  const dug = await deps.dig(pos)
  if (dug === 'blocked') {
    return skillFail(
      'INTERNAL',
      `the world refused the dig on ${canonical} at ${label} (reach or protection) — the block is still placed`,
      deps.now() - startedAt,
      ctx,
    )
  }

  const collected = await deps.collectNearbyDrops()
  return skillOk({ recovered: collected > 0 }, deps.now() - startedAt, ctx)
}
