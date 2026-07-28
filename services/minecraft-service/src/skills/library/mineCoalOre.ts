// Ported from Voyager trial1 skill_library mineFiveCoalOres.js / V2
// (MIT — see ../VENDORED.md). De-pluralized and parameterized: count is a
// param instead of a hardcoded 5, and the 1.19-era single-variant lookup is
// widened for 1.21.6 — coal generates as coal_ore AND deepslate_coal_ore
// (deepslate variants are 1.17+; Voyager's era-locked list never sees them
// below y=0).
//
// Any pickaxe harvests coal (wooden tier is enough), so the tool failure
// this skill propagates is TOOL_REQUIRED (no pickaxe at all / wrong tool in
// hand), not TOOL_TIER_REQUIRED. Enforcement lives with the executor and the
// mineBlock primitive; this skill's contract is to pass the code through
// INTACT and never spend a second trip on the other variant when the failure
// applies to both.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/** Structural view of the mining primitive (owned by the primitives unit). */
export interface MineCoalOrePrimitives {
  mineBlock(params: {
    blockName: string
    count?: number
  }): Promise<SkillResult<{ mined: number }>>
}

export interface MineCoalOreParams {
  /** Ore blocks to mine; null/omitted -> DEFAULT_COAL_ORE_COUNT. */
  count?: number | null
}

export interface MineCoalOreOutcome {
  mined: number
  requested: number
  /** Yield per variant actually dug, mirrors the ledger's byType. */
  byVariant: Record<string, number>
}

/**
 * Coal trips in the live race run 3-6 per gather; 3 matches the iron-side
 * default and stays inside the 60s trip budget at any depth.
 */
export const DEFAULT_COAL_ORE_COUNT = 3

/** Below this y, deepslate has replaced stone — search deepslate first. */
const DEEPSLATE_CUTOFF_Y = 0

const SURFACE_FIRST = ['coal_ore', 'deepslate_coal_ore'] as const
const DEEPSLATE_FIRST = ['deepslate_coal_ore', 'coal_ore'] as const

export async function mineCoalOre(
  primitives: MineCoalOrePrimitives,
  params: MineCoalOreParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<MineCoalOreOutcome>> {
  const started = Date.now()
  const requested = params.count ?? DEFAULT_COAL_ORE_COUNT
  if (!Number.isInteger(requested) || requested < 1) {
    // Bounds are stripped from the wire schema, so a bad count CAN arrive —
    // refuse honestly instead of reporting a fabricated RESOURCE_NOT_FOUND.
    return skillFail(
      'INTERNAL',
      `count must be a positive integer, got ${requested}`,
      Date.now() - started,
      ctx,
    )
  }
  const variants =
    ctx.position.y < DEEPSLATE_CUTOFF_Y ? DEEPSLATE_FIRST : SURFACE_FIRST

  const byVariant: Record<string, number> = {}
  let mined = 0
  let notFoundDetail: string | null = null

  for (const blockName of variants) {
    const remaining = requested - mined
    if (remaining <= 0) break
    const r = await primitives.mineBlock({ blockName, count: remaining })
    if (r.ok) {
      if (r.outcome.mined > 0) byVariant[blockName] = r.outcome.mined
      mined += r.outcome.mined
      continue
    }
    if (r.failureCode === 'RESOURCE_NOT_FOUND') {
      // Only absence cascades to the other variant.
      notFoundDetail = r.detail
      continue
    }
    // Substantive failures apply to the trip or the tool, not the variant —
    // propagate the code INTACT rather than burning a second trip.
    if (mined > 0) break // keep the partial haul; partial gathers complete
    return skillFail(r.failureCode, r.detail, Date.now() - started, ctx)
  }

  if (mined > 0) {
    return skillOk({ mined, requested, byVariant }, Date.now() - started, ctx)
  }
  return skillFail(
    'RESOURCE_NOT_FOUND',
    notFoundDetail
      ? `no coal ore in reach (tried ${variants.join(', ')}): ${notFoundDetail}`
      : `coal ore exhausted with zero yield (tried ${variants.join(', ')})`,
    Date.now() - started,
    ctx,
  )
}

export const mineCoalOreSchema: SkillSchemaStub = {
  name: 'mineCoalOre',
  description:
    'Mine coal ore, trying coal_ore and deepslate_coal_ore in depth-aware ' +
    'order. Any pickaxe works (TOOL_REQUIRED if none). Drops coal directly — ' +
    `furnace fuel for the smelt chain. count null -> ${DEFAULT_COAL_ORE_COUNT}.`,
  params: {
    type: 'object',
    properties: {
      count: {
        type: ['integer', 'null'],
        description:
          'Ore blocks to mine; null uses the trip-budget-sized default of ' +
          `${DEFAULT_COAL_ORE_COUNT}.`,
      },
    },
    required: ['count'],
    additionalProperties: false,
  },
  failureCodes: [
    'RESOURCE_NOT_FOUND',
    'PATH_NOT_FOUND',
    'TOOL_REQUIRED',
    'TIMEOUT',
    'INVENTORY_FULL',
    'ABORTED',
    'INTERNAL',
  ],
}
