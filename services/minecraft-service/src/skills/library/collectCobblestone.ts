// Port of Voyager skill_library/trial1/skill/code/mineTenCobblestone.js
// (MIT — see src/skills/VENDORED.md; no mineFiveCobblestone.js exists
// upstream, this is the nearest equivalent with the count generalized).
// Voyager's original crafted a wooden pickaxe on the fly and explored for
// stone before mining; here tool acquisition is its own skill, so a missing
// pickaxe is a TOOL_REQUIRED refusal, and exploration lives inside the
// mineBlock primitive. Mining `stone` yields cobblestone (no silk touch at
// this tier).

import {
  skillFail,
  skillOk,
  type SkillFailureCode,
  type SkillInvocationContext,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/**
 * The primitive slice this skill composes. Declared structurally — the
 * implementations live in src/skills/primitives/** (a parallel unit); any
 * object with these shapes satisfies the interface.
 */
export interface CollectCobblestonePrimitives {
  /** Equip the best tool in inventory for the block; fails TOOL_REQUIRED when none qualifies. */
  equipBestTool(params: { block: string }): Promise<SkillResult<{ tool: string }>>
  mineBlock(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ collected: number }>>
}

export interface CollectCobblestoneParams {
  /** How many cobblestone to collect; null/omitted uses the default. */
  count?: number | null
}

export const DEFAULT_COBBLESTONE_COUNT = 5

export async function collectCobblestone(
  primitives: CollectCobblestonePrimitives,
  params: CollectCobblestoneParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ collected: number }>> {
  const t0 = Date.now()
  const failed = (r: { failureCode: SkillFailureCode; detail: string }) =>
    skillFail<{ collected: number }>(r.failureCode, r.detail, Date.now() - t0, ctx)

  // LLM-facing param: schema says integer, but not every provider path
  // enforces it — floor fractions, clamp to >= 1, default anything non-finite.
  const requested = params.count ?? DEFAULT_COBBLESTONE_COUNT
  const count = Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : DEFAULT_COBBLESTONE_COUNT

  // A pickaxe must be held before mining stone — propagate the primitive's
  // refusal (TOOL_REQUIRED when the inventory has none) with its code intact.
  const equip = await primitives.equipBestTool({ block: 'stone' })
  if (!equip.ok) return failed(equip)

  const mined = await primitives.mineBlock({ name: 'stone', count })
  if (!mined.ok) return failed(mined)

  return skillOk({ collected: mined.outcome.collected }, Date.now() - t0, ctx)
}

/**
 * Failure surface = union of what the composed primitives emit
 * (equipBestTool ∪ mineBlock); codes always propagate intact, never remapped.
 */
export const collectCobblestoneSchema: SkillSchemaStub = {
  name: 'collectCobblestone',
  description:
    'Mine nearby stone with the best held pickaxe, collecting cobblestone (default 5). Refuses with TOOL_REQUIRED when no pickaxe is in inventory.',
  params: {
    type: 'object',
    properties: {
      count: {
        type: ['integer', 'null'],
        description: 'How many cobblestone to collect; null uses the default of 5.',
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
    'UNSUPPORTED_NAME',
    'ABORTED',
    'INTERNAL',
  ],
}
