// Ported from the stick half of Voyager
// skill_library/trial1/skill/code/craftOakPlanksAndSticks.js (MIT — see
// ../VENDORED.md). Voyager checked bot.inventory counts; the port is
// failure-driven: attempt the craft, recover MISSING_MATERIALS via the
// craftPlanks skill (any species, mining if needed), retry once.

import { craftPlanks } from './craftPlanks.ts'
import {
  skillFail,
  skillOk,
  type SkillFailureCode,
  type SkillInvocationContext,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/**
 * Structural primitive surface this skill composes (superset of what the
 * craftPlanks recovery path needs). Implementations arrive via assembly
 * wiring — never imported here.
 */
export interface CraftSticksPrimitives {
  mineBlock(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ collected: number }>>
  craftItem(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ crafted: number }>>
}

export interface CraftSticksParams {
  /** Stick items wanted; null/omitted -> 4 (one craft's worth). */
  count?: number | null
}

export interface CraftSticksOutcome {
  crafted: number
}

const STICKS_PER_CRAFT = 4 // 2 planks -> 4 sticks
const PLANKS_PER_CRAFT = 2

export const CRAFT_STICKS_FAILURE_CODES: readonly SkillFailureCode[] = [
  'RESOURCE_NOT_FOUND',
  'PATH_NOT_FOUND',
  'TOOL_REQUIRED',
  'TOOL_TIER_REQUIRED',
  'TIMEOUT',
  'INVENTORY_FULL',
  'ABORTED',
  'INTERNAL',
  'RECIPE_UNAVAILABLE',
  'MISSING_MATERIALS',
]

export async function craftSticks(
  primitives: CraftSticksPrimitives,
  params: CraftSticksParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<CraftSticksOutcome>> {
  // Normalize before it reaches a primitive: zero/negative/fractional counts
  // would otherwise let a craft of nothing report success.
  const count = Math.max(1, Math.floor(params.count ?? 4))
  // craftItem's count is recipe APPLICATIONS (2 planks -> 4 sticks), not item
  // yield — convert, or a 4-stick ask becomes a 4-application (8-plank) demand.
  const applications = Math.ceil(count / STICKS_PER_CRAFT)
  let costMs = 0

  const first = await primitives.craftItem({ name: 'stick', count: applications })
  costMs += first.costMs
  if (first.ok) return skillOk({ crafted: first.outcome.crafted }, costMs, ctx)
  if (first.failureCode !== 'MISSING_MATERIALS') {
    return skillFail(first.failureCode, `craftSticks: ${first.detail}`, costMs, ctx)
  }

  const planksNeeded = Math.ceil(count / STICKS_PER_CRAFT) * PLANKS_PER_CRAFT
  const planks = await craftPlanks(primitives, { count: planksNeeded }, ctx)
  costMs += planks.costMs
  if (!planks.ok) {
    return skillFail(
      planks.failureCode,
      `craftSticks(planks): ${planks.detail}`,
      costMs,
      ctx,
    )
  }

  const retry = await primitives.craftItem({ name: 'stick', count: applications })
  costMs += retry.costMs
  if (retry.ok) return skillOk({ crafted: retry.outcome.crafted }, costMs, ctx)
  return skillFail(
    retry.failureCode,
    `craftSticks(after planks): ${retry.detail}`,
    costMs,
    ctx,
  )
}

export const craftSticksSchema: SkillSchemaStub = {
  name: 'craftSticks',
  description:
    'Craft sticks from held planks, crafting planks (mining a log if needed) when materials are missing.',
  params: {
    type: 'object',
    properties: {
      count: {
        type: ['integer', 'null'],
        description: 'Stick items wanted; null means 4.',
      },
    },
    required: ['count'],
    additionalProperties: false,
  },
  failureCodes: [...CRAFT_STICKS_FAILURE_CODES],
}
