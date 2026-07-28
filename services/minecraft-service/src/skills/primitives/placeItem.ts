// Port of Voyager's placeItem.js control primitive (MineDojo/Voyager, MIT —
// attribution in ../VENDORED.md). Substantial rewrite: typed, deps-injected,
// guarded name resolution, closed failure vocabulary, and two fixes over the
// original: (1) the reference-block scan runs AFTER the walk, because from a
// distance the target's chunk can be unloaded and world reads lie (Voyager
// scanned first, and its `block?.name !== "air"` check even admits a null
// block from an unloaded chunk); (2) a 'failed' place is verified against
// the world before it is reported — mineflayer's placeBlock can throw
// "blockUpdate did not fire within 5000ms" when the placement actually
// landed (the placeCarried lesson from BotSession, reimplemented against
// these deps). Voyager checked the inventory count instead, which a
// concurrent pickup can fake; the world is the truth.

import { skillFail, skillOk } from '../types.ts'
import type { SkillInvocationContext, SkillPosition, SkillResult } from '../types.ts'
import type { NameLookup } from '../names.ts'

/** Walk budget for reaching the placement site — must fit inside the
 *  executor's 30s act watchdog alongside the place itself. */
export const GOTO_PLACE_TIMEOUT_MS = 20_000

export interface PlaceItemDeps {
  /** guarded lookup (names.ts guardedItem under the hood) */
  resolveItem(name: string): NameLookup
  hasItem(itemId: number): boolean
  /** A solid neighbor of the target cell to place against, plus the face
   *  vector from that neighbor toward the target — Voyager's six-vector
   *  scan lives adapter-side. Null when every neighbor is air (a floating
   *  block, which vanilla cannot place). */
  findReferenceBlock(near: SkillPosition): { ref: SkillPosition; face: SkillPosition } | null
  /** equip + placeBlock against the reference; 'failed' for any underlying
   *  throw (including the blockUpdate flake — see verifyPlaced) */
  place(ref: SkillPosition, face: SkillPosition): Promise<'placed' | 'failed'>
  /** world-truth check: does a block of this name now stand at/near the
   *  target cell? */
  verifyPlaced(name: string, near: SkillPosition): Promise<boolean>
  gotoNear(pos: SkillPosition, timeoutMs: number): Promise<'arrived' | 'failed'>
  now(): number
}

export interface PlaceItemParams {
  name: string
  position: SkillPosition
}

/**
 * Place one carried block at the target cell. Failure order teaches the
 * deepest gap first: unknown name, nothing to place, unreachable site, no
 * face to place against, then the placement itself — and a placement that
 * "failed" only counts once the world confirms the cell is still empty.
 */
export async function placeItem(
  deps: PlaceItemDeps,
  params: PlaceItemParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ placed: true; position: SkillPosition }>> {
  const started = deps.now()
  const cost = () => Math.max(0, deps.now() - started)
  const { position } = params

  const lookup = deps.resolveItem(params.name)
  if (!lookup.ok) {
    return skillFail(lookup.failureCode, lookup.detail, cost(), ctx)
  }
  const item = lookup.value

  try {
    if (!deps.hasItem(item.id)) {
      return skillFail(
        'MISSING_MATERIALS',
        `no ${item.name} in inventory — craft or gather one first`,
        cost(),
        ctx,
      )
    }

    const walked = await deps.gotoNear(position, GOTO_PLACE_TIMEOUT_MS)
    if (walked === 'failed') {
      return skillFail(
        'PATH_NOT_FOUND',
        `could not reach the placement site at (${position.x}, ${position.y}, ${position.z})`,
        cost(),
        ctx,
      )
    }

    const reference = deps.findReferenceBlock(position)
    if (!reference) {
      return skillFail(
        'PLACE_FAILED',
        `no block to place ${item.name} against at (${position.x}, ${position.y}, ${position.z}) — you cannot place a floating block`,
        cost(),
        ctx,
      )
    }

    const outcome = await deps.place(reference.ref, reference.face)
    if (outcome === 'failed') {
      // The blockUpdate flake: the throw can arrive AFTER the block landed.
      // Trust the world, not the promise.
      if (await deps.verifyPlaced(item.name, position)) {
        return skillOk({ placed: true, position }, cost(), ctx)
      }
      return skillFail(
        'PLACE_FAILED',
        `placing ${item.name} at (${position.x}, ${position.y}, ${position.z}) failed — find another position to place`,
        cost(),
        ctx,
      )
    }
    return skillOk({ placed: true, position }, cost(), ctx)
  } catch (err) {
    return skillFail(
      'INTERNAL',
      `placeItem(${item.name}): ${err instanceof Error ? err.message : String(err)}`,
      cost(),
      ctx,
    )
  }
}
