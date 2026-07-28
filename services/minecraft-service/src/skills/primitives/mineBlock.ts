// Voyager control-primitive port: mineBlock.
// Source: MineDojo/Voyager voyager/control_primitives/mineBlock.js (MIT —
// attribution in ../VENDORED.md). Substantial rewrite for this stack: typed
// and deps-injected (the bot never appears here — the CraftFlowDeps
// convention from src/world/crafting.ts), name resolution through the 1.21.6
// guard layer, the closed SkillFailureCode vocabulary in place of thrown
// strings + a module-global fail counter, and a params-scoped time budget
// instead of collectBlock's open-ended run. Voyager targeted MC ~1.19; this
// port targets 1.21.6.

import type { NameLookup } from '../names.ts'
import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
} from '../types.ts'

/** Search radius, matching the original's findBlocks maxDistance. */
export const MINE_BLOCK_MAX_DISTANCE = 32

/**
 * Params-scoped time budget: a flat base plus an increment per requested
 * block, read exclusively through deps.now(). Sized against the executor's
 * 60s gather trip budget — count=1 gives 30s.
 */
export const MINE_BLOCK_BASE_BUDGET_MS = 10_000
export const MINE_BLOCK_PER_BLOCK_BUDGET_MS = 20_000

/**
 * Ask the world for more candidates than the target so an unreachable or
 * blocked block can be skipped (Voyager over-fetched 1024 and passed
 * ignoreNoPath for the same reason). The x4 headroom is capped so a large
 * count cannot demand a giant client-side sweep — but the pool never drops
 * below the target itself, or full success would be unreachable past the cap.
 */
const CANDIDATE_POOL_MULTIPLIER = 4
const CANDIDATE_POOL_CAP = 64

/**
 * World touches mineBlock needs, as closures over a live bot (assembly
 * wiring); tests hand in structural fakes. The bot itself never crosses
 * this seam.
 */
export interface MineBlockDeps {
  /** guardedBlock partially applied over live mcData */
  resolveBlock(name: string): NameLookup
  /** positions of matching blocks, nearest first */
  findBlocks(blockId: number, maxDistance: number, count: number): SkillPosition[]
  /** walk within digging reach of pos; resolves with why the walk stopped */
  gotoBlock(pos: SkillPosition, timeoutMs: number): Promise<'arrived' | 'path_not_found' | 'timeout'>
  /** 'missing' means the block only drops with a tool the pack lacks */
  equipBestToolFor(pos: SkillPosition): Promise<'equipped' | 'none_needed' | 'missing'>
  /** 'blocked' = the dig could not happen (block gone, protected, occluded) */
  dig(pos: SkillPosition): Promise<'dug' | 'blocked'>
  /** sweep drops around the body; resolves the number of items picked up */
  collectNearbyDrops(): Promise<number>
  now(): number
}

/**
 * Mine up to params.count blocks of params.name and collect the drops.
 *
 * Outcome semantics: full success when collected >= count; partial success
 * (ok: true, collected < count) ONLY when at least one item was collected
 * and the stop reason was the time budget — every other early stop returns
 * its failure code. collected is the honest pickup count and can exceed
 * count when a drop sweep catches extra items.
 */
export async function mineBlock(
  deps: MineBlockDeps,
  params: { name: string; count?: number },
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ collected: number }>> {
  const startedAt = deps.now()
  const elapsed = () => deps.now() - startedAt

  const lookup = deps.resolveBlock(params.name)
  if (!lookup.ok) {
    return skillFail(lookup.failureCode, lookup.detail, elapsed(), ctx)
  }
  const blockName = lookup.value.name

  const target = Math.max(1, Math.floor(params.count ?? 1))
  const budgetMs = MINE_BLOCK_BASE_BUDGET_MS + MINE_BLOCK_PER_BLOCK_BUDGET_MS * target

  const poolSize = Math.max(target, Math.min(target * CANDIDATE_POOL_MULTIPLIER, CANDIDATE_POOL_CAP))
  const candidates = deps.findBlocks(lookup.value.id, MINE_BLOCK_MAX_DISTANCE, poolSize)
  if (candidates.length === 0) {
    return skillFail(
      'RESOURCE_NOT_FOUND',
      `no ${blockName} within ${MINE_BLOCK_MAX_DISTANCE} blocks — explore first`,
      elapsed(),
      ctx,
    )
  }

  let collected = 0
  let unreachable = 0
  let blockedDigs = 0

  // Partial success exists for exactly one stop reason: the budget ran out
  // with something already in the pack. A zero-yield timeout is a TIMEOUT.
  const settleTimeout = (): SkillResult<{ collected: number }> =>
    collected >= 1
      ? skillOk({ collected }, elapsed(), ctx)
      : skillFail(
          'TIMEOUT',
          `budget of ${budgetMs}ms elapsed before any ${blockName} was collected`,
          elapsed(),
          ctx,
        )

  const progress = () => `collected ${collected} of ${target} ${blockName}`

  for (const pos of candidates) {
    const remainingMs = budgetMs - elapsed()
    if (remainingMs <= 0) return settleTimeout()

    const walk = await deps.gotoBlock(pos, remainingMs)
    if (walk === 'timeout') return settleTimeout()
    if (walk === 'path_not_found') {
      unreachable += 1
      continue
    }

    const equip = await deps.equipBestToolFor(pos)
    if (equip === 'missing') {
      return skillFail(
        'TOOL_REQUIRED',
        `${blockName} at (${pos.x}, ${pos.y}, ${pos.z}) needs a tool the pack lacks; ${progress()}`,
        elapsed(),
        ctx,
      )
    }

    const dug = await deps.dig(pos)
    if (dug === 'blocked') {
      blockedDigs += 1
      continue
    }

    collected += await deps.collectNearbyDrops()
    if (collected >= target) {
      return skillOk({ collected }, elapsed(), ctx)
    }
  }

  // Candidate pool exhausted below target — a world shortfall, not a budget
  // one, so no partial-success escape here.
  const missDetail = `${progress()} (${unreachable} unreachable, ${blockedDigs} blocked digs)`
  if (unreachable > 0) {
    return skillFail('PATH_NOT_FOUND', `no path to remaining ${blockName} — ${missDetail}`, elapsed(), ctx)
  }
  return skillFail(
    'RESOURCE_NOT_FOUND',
    `ran out of ${blockName} within ${MINE_BLOCK_MAX_DISTANCE} blocks — ${missDetail}`,
    elapsed(),
    ctx,
  )
}
