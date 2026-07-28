// Ported from Voyager skill_library/trial1/skill/code/craftCraftingTable.js
// (MIT — see ../VENDORED.md). Voyager checked bot.inventory for 4 oak planks
// and bailed with a chat line when logs ran short; the port is failure-driven:
// attempt the craft, recover MISSING_MATERIALS via the craftPlanks skill
// (any species, mining if needed), retry once.

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
export interface CraftCraftingTablePrimitives {
  mineBlock(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ collected: number }>>
  craftItem(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ crafted: number }>>
}

/** A crafting table is always one table from 4 planks — nothing to configure. */
export type CraftCraftingTableParams = Record<string, never>

export interface CraftCraftingTableOutcome {
  crafted: number
}

const PLANKS_FOR_TABLE = 4

export const CRAFT_CRAFTING_TABLE_FAILURE_CODES: readonly SkillFailureCode[] = [
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

export async function craftCraftingTable(
  primitives: CraftCraftingTablePrimitives,
  _params: CraftCraftingTableParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<CraftCraftingTableOutcome>> {
  let costMs = 0

  const first = await primitives.craftItem({ name: 'crafting_table', count: 1 })
  costMs += first.costMs
  if (first.ok) return skillOk({ crafted: first.outcome.crafted }, costMs, ctx)
  if (first.failureCode !== 'MISSING_MATERIALS') {
    return skillFail(
      first.failureCode,
      `craftCraftingTable: ${first.detail}`,
      costMs,
      ctx,
    )
  }

  const planks = await craftPlanks(primitives, { count: PLANKS_FOR_TABLE }, ctx)
  costMs += planks.costMs
  if (!planks.ok) {
    return skillFail(
      planks.failureCode,
      `craftCraftingTable(planks): ${planks.detail}`,
      costMs,
      ctx,
    )
  }

  const retry = await primitives.craftItem({ name: 'crafting_table', count: 1 })
  costMs += retry.costMs
  if (retry.ok) return skillOk({ crafted: retry.outcome.crafted }, costMs, ctx)
  return skillFail(
    retry.failureCode,
    `craftCraftingTable(after planks): ${retry.detail}`,
    costMs,
    ctx,
  )
}

export const craftCraftingTableSchema: SkillSchemaStub = {
  name: 'craftCraftingTable',
  description:
    'Craft one crafting table, crafting planks (mining a log if needed) when materials are missing.',
  params: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  failureCodes: [...CRAFT_CRAFTING_TABLE_FAILURE_CODES],
}
