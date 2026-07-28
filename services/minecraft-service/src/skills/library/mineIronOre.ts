// Ported from Voyager trial1 skill_library mineFiveIronOres.js / V2
// (MIT — see ../VENDORED.md). De-pluralized and parameterized: count is a
// param instead of a hardcoded 5, and the 1.19-era single-variant lookup is
// widened for 1.21.6 — iron ore generates as iron_ore AND deepslate_iron_ore
// (deepslate variants are 1.17+; Voyager's era-locked list never sees them
// below y=0). Iron ore drops raw_iron since 1.17: smelting is smeltIronOre's
// job, with raw_iron as the furnace input, never the ore block.
//
// Stone-tier pickaxe REQUIRED. Tier enforcement lives with the executor and
// the mineBlock primitive (the live ledger's top failure code is
// TOOL_TIER_REQUIRED) — this skill's contract is to propagate that code
// INTACT, never remapped, and never to burn a second trip on the other
// variant when the failure applies to both (an under-tiered pickaxe fails on
// deepslate_iron_ore exactly as it fails on iron_ore).

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/** Structural view of the mining primitive (owned by the primitives unit). */
export interface MineIronOrePrimitives {
  mineBlock(params: {
    blockName: string
    count?: number
  }): Promise<SkillResult<{ mined: number }>>
}

export interface MineIronOreParams {
  /** Ore blocks to mine; null/omitted -> DEFAULT_IRON_ORE_COUNT. */
  count?: number | null
}

export interface MineIronOreOutcome {
  mined: number
  requested: number
  /** Yield per variant actually dug, mirrors the ledger's byType. */
  byVariant: Record<string, number>
}

/**
 * The live race requests iron in threes (gather {count: 3}) because the 60s
 * trip budget inside a 30s tick makes larger hauls the top TIMEOUT source —
 * keep the default aligned with what the fleet actually survives.
 */
export const DEFAULT_IRON_ORE_COUNT = 3

/** Below this y, deepslate has replaced stone — search deepslate first. */
const DEEPSLATE_CUTOFF_Y = 0

const SURFACE_FIRST = ['iron_ore', 'deepslate_iron_ore'] as const
const DEEPSLATE_FIRST = ['deepslate_iron_ore', 'iron_ore'] as const

export async function mineIronOre(
  primitives: MineIronOrePrimitives,
  params: MineIronOreParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<MineIronOreOutcome>> {
  const started = Date.now()
  const requested = params.count ?? DEFAULT_IRON_ORE_COUNT
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
      // Only absence cascades to the other variant — the depth we stand at
      // may simply favor the other generation band.
      notFoundDetail = r.detail
      continue
    }
    // Substantive failures (TOOL_TIER_REQUIRED, TIMEOUT, PATH_NOT_FOUND,
    // INVENTORY_FULL, ...) apply to the trip or the tool, not the variant —
    // retrying the other variant would spend a second trip budget on the
    // same dead end. Propagate the code INTACT.
    if (mined > 0) break // keep the partial haul; partial gathers complete
    return skillFail(r.failureCode, r.detail, Date.now() - started, ctx)
  }

  if (mined > 0) {
    return skillOk({ mined, requested, byVariant }, Date.now() - started, ctx)
  }
  return skillFail(
    'RESOURCE_NOT_FOUND',
    notFoundDetail
      ? `no iron ore in reach (tried ${variants.join(', ')}): ${notFoundDetail}`
      : `iron ore exhausted with zero yield (tried ${variants.join(', ')})`,
    Date.now() - started,
    ctx,
  )
}

export const mineIronOreSchema: SkillSchemaStub = {
  name: 'mineIronOre',
  description:
    'Mine iron ore, trying iron_ore and deepslate_iron_ore in depth-aware ' +
    'order. Requires a stone-tier pickaxe or better (TOOL_TIER_REQUIRED ' +
    'otherwise). Drops raw_iron — smelt it with smeltIronOre. ' +
    `count null -> ${DEFAULT_IRON_ORE_COUNT}, sized to the 60s trip budget.`,
  params: {
    type: 'object',
    properties: {
      count: {
        type: ['integer', 'null'],
        description:
          'Ore blocks to mine; null uses the trip-budget-sized default of ' +
          `${DEFAULT_IRON_ORE_COUNT}.`,
      },
    },
    required: ['count'],
    additionalProperties: false,
  },
  failureCodes: [
    'RESOURCE_NOT_FOUND',
    'PATH_NOT_FOUND',
    'TOOL_REQUIRED',
    'TOOL_TIER_REQUIRED',
    'TIMEOUT',
    'INVENTORY_FULL',
    'ABORTED',
    'INTERNAL',
  ],
}
