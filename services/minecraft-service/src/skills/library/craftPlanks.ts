// Ported from the plank-ensuring halves of Voyager
// skill_library/trial1/skill/code/craftOakPlanksAndSticks.js and
// craftCraftingTable.js (MIT — see ../VENDORED.md). Voyager counted
// bot.inventory and bailed with a chat line; the port is failure-driven
// instead: attempt the craft, recover MISSING_MATERIALS by mining the
// matching log, retry once. Generalized from oak-only to the full
// WOOD_LOGS family from names.ts (1.21.6 and 26.2).

import { WOOD_LOGS, plankNameFor } from '../names.ts'
import {
  skillFail,
  skillOk,
  type SkillFailureCode,
  type SkillInvocationContext,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/**
 * Structural primitive surface this skill composes. Implementations arrive
 * via assembly wiring (built by the primitives unit) — never imported here.
 * craftItem's count is the desired ITEM count; recipe math (yields, batch
 * sizes) is the primitive's business.
 */
export interface CraftPlanksPrimitives {
  mineBlock(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ collected: number }>>
  craftItem(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ crafted: number }>>
}

export interface CraftPlanksParams {
  /** Plank items wanted; null/omitted -> 4 (one log's worth). */
  count?: number | null
  /** Pin to one log species (a WOOD_LOGS member); null/omitted -> any. */
  log?: string | null
}

export interface CraftPlanksOutcome {
  crafted: number
  /** Which plank item was produced (e.g. oak_planks). */
  planks: string
}

// plankNameFor lives in names.ts so gather/craft/store share the bamboo case.
export { plankNameFor }

/** Logs needed for `planks` items: a log yields 4 planks, a bamboo block 2. */
function logsNeededFor(log: string, planks: number): number {
  return Math.max(1, Math.ceil(planks / (log === 'bamboo_block' ? 2 : 4)))
}

export const CRAFT_PLANKS_FAILURE_CODES: readonly SkillFailureCode[] = [
  'RESOURCE_NOT_FOUND',
  'PATH_NOT_FOUND',
  'TOOL_REQUIRED',
  'TOOL_TIER_REQUIRED',
  'TIMEOUT',
  'INVENTORY_FULL',
  'ABORTED',
  'INTERNAL',
  'UNSUPPORTED_NAME',
  'RECIPE_UNAVAILABLE',
  'MISSING_MATERIALS',
]

export async function craftPlanks(
  primitives: CraftPlanksPrimitives,
  params: CraftPlanksParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<CraftPlanksOutcome>> {
  // Normalize before it reaches a primitive: zero/negative/fractional counts
  // would otherwise let a craft of nothing report success.
  const count = Math.max(1, Math.floor(params.count ?? 4))
  let costMs = 0
  if (params.log != null && !WOOD_LOGS.includes(params.log)) {
    return skillFail(
      'UNSUPPORTED_NAME',
      `craftPlanks: "${params.log}" is not a known log (expected one of ${WOOD_LOGS.join(', ')})`,
      costMs,
      ctx,
    )
  }
  const candidates = params.log != null ? [params.log] : [...WOOD_LOGS]

  // Pass 1: materials already in the inventory may satisfy a species' recipe.
  // craftItem's count is recipe APPLICATIONS (one log -> 4 planks), not item
  // yield — convert, or a 9-plank ask becomes a 9-log demand (live-gate bug).
  for (const log of candidates) {
    const planks = plankNameFor(log)
    const crafted = await primitives.craftItem({ name: planks, count: logsNeededFor(log, count) })
    costMs += crafted.costMs
    if (crafted.ok) {
      return skillOk({ crafted: crafted.outcome.crafted, planks }, costMs, ctx)
    }
    if (crafted.failureCode !== 'MISSING_MATERIALS') {
      // Substantive failure — propagate immediately, code intact.
      return skillFail(
        crafted.failureCode,
        `craftPlanks(${planks}): ${crafted.detail}`,
        costMs,
        ctx,
      )
    }
  }

  // Pass 2: mine the matching log, then retry the craft once per species.
  for (const log of candidates) {
    const mined = await primitives.mineBlock({
      name: log,
      count: logsNeededFor(log, count),
    })
    costMs += mined.costMs
    if (!mined.ok) {
      if (mined.failureCode === 'RESOURCE_NOT_FOUND') continue // species not around — try the next
      return skillFail(
        mined.failureCode,
        `craftPlanks(mine ${log}): ${mined.detail}`,
        costMs,
        ctx,
      )
    }
    const planks = plankNameFor(log)
    const crafted = await primitives.craftItem({ name: planks, count: logsNeededFor(log, count) })
    costMs += crafted.costMs
    if (crafted.ok) {
      return skillOk({ crafted: crafted.outcome.crafted, planks }, costMs, ctx)
    }
    return skillFail(
      crafted.failureCode,
      `craftPlanks(${planks} after mining): ${crafted.detail}`,
      costMs,
      ctx,
    )
  }

  return skillFail(
    'RESOURCE_NOT_FOUND',
    `craftPlanks: no craftable materials held and no log of any family nearby (tried ${candidates.join(', ')})`,
    costMs,
    ctx,
  )
}

export const craftPlanksSchema: SkillSchemaStub = {
  name: 'craftPlanks',
  description:
    'Craft wooden planks from held logs, mining a nearby log first when materials are missing.',
  params: {
    type: 'object',
    properties: {
      count: {
        type: ['integer', 'null'],
        description: 'Plank items wanted; null means 4.',
      },
      log: {
        anyOf: [{ enum: [...WOOD_LOGS] }, { type: 'null' }],
        description: 'Pin to one log species; null means any.',
      },
    },
    required: ['count', 'log'],
    additionalProperties: false,
  },
  failureCodes: [...CRAFT_PLANKS_FAILURE_CODES],
}
