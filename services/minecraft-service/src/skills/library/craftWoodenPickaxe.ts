// Ported from Voyager skill_library/trial1/skill/code/craftWoodenPickaxe.js
// (MIT — see ../VENDORED.md). The original sequence is preserved: ensure
// planks -> ensure sticks -> ensure a crafting table -> place it one block +x
// of the bot -> craft the pickaxe. Voyager's bot.inventory count checks became
// failure-driven sub-skills (the wood tier has no counting primitive), so the
// material steps may over-craft; every step propagates its FIRST failure with
// the code intact — never remapped.

import { craftCraftingTable } from './craftCraftingTable.ts'
import { craftPlanks } from './craftPlanks.ts'
import { craftSticks } from './craftSticks.ts'
import {
  skillFail,
  skillOk,
  type SkillFailureCode,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/**
 * Structural primitive surface this skill composes (the full wood tier).
 * Implementations arrive via assembly wiring — never imported here.
 */
export interface WoodTierPrimitives {
  mineBlock(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ collected: number }>>
  craftItem(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ crafted: number }>>
  placeItem(params: {
    name: string
    position: SkillPosition
  }): Promise<SkillResult<{ placed: true }>>
}

export interface CraftWoodenPickaxeParams {
  /** Where to stand the crafting table; null/omitted -> one block +x of the bot. */
  tablePosition?: SkillPosition | null
}

export interface CraftWoodenPickaxeOutcome {
  crafted: number
  tablePosition: SkillPosition
}

// 3 (pickaxe head) + 2 (stick input) + 4 (crafting table) plank items.
const PLANKS_FOR_PICKAXE = 9
const STICKS_FOR_PICKAXE = 2

export const CRAFT_WOODEN_PICKAXE_FAILURE_CODES: readonly SkillFailureCode[] = [
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
  'PLACE_FAILED',
]

export async function craftWoodenPickaxe(
  primitives: WoodTierPrimitives,
  params: CraftWoodenPickaxeParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<CraftWoodenPickaxeOutcome>> {
  let costMs = 0

  const planks = await craftPlanks(primitives, { count: PLANKS_FOR_PICKAXE }, ctx)
  costMs += planks.costMs
  if (!planks.ok) {
    return skillFail(
      planks.failureCode,
      `craftWoodenPickaxe(planks): ${planks.detail}`,
      costMs,
      ctx,
    )
  }

  const sticks = await craftSticks(primitives, { count: STICKS_FOR_PICKAXE }, ctx)
  costMs += sticks.costMs
  if (!sticks.ok) {
    return skillFail(
      sticks.failureCode,
      `craftWoodenPickaxe(sticks): ${sticks.detail}`,
      costMs,
      ctx,
    )
  }

  const table = await craftCraftingTable(primitives, {}, ctx)
  costMs += table.costMs
  if (!table.ok) {
    return skillFail(
      table.failureCode,
      `craftWoodenPickaxe(table): ${table.detail}`,
      costMs,
      ctx,
    )
  }

  // Voyager placed at bot.entity.position.offset(1, 0, 0).
  const tablePosition = params.tablePosition ?? {
    x: ctx.position.x + 1,
    y: ctx.position.y,
    z: ctx.position.z,
  }
  const placed = await primitives.placeItem({
    name: 'crafting_table',
    position: tablePosition,
  })
  costMs += placed.costMs
  if (!placed.ok) {
    return skillFail(
      placed.failureCode,
      `craftWoodenPickaxe(place table): ${placed.detail}`,
      costMs,
      ctx,
    )
  }

  const pickaxe = await primitives.craftItem({ name: 'wooden_pickaxe', count: 1 })
  costMs += pickaxe.costMs
  if (!pickaxe.ok) {
    return skillFail(
      pickaxe.failureCode,
      `craftWoodenPickaxe: ${pickaxe.detail}`,
      costMs,
      ctx,
    )
  }
  return skillOk(
    { crafted: pickaxe.outcome.crafted, tablePosition },
    costMs,
    ctx,
  )
}

export const craftWoodenPickaxeSchema: SkillSchemaStub = {
  name: 'craftWoodenPickaxe',
  description:
    'Craft a wooden pickaxe end to end: ensure planks, sticks, and a placed crafting table, then craft.',
  params: {
    type: 'object',
    properties: {
      tablePosition: {
        anyOf: [
          {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              z: { type: 'number' },
            },
            required: ['x', 'y', 'z'],
            additionalProperties: false,
          },
          { type: 'null' },
        ],
        description:
          'Where to place the crafting table; null means one block +x of the bot.',
      },
    },
    required: ['tablePosition'],
    additionalProperties: false,
  },
  failureCodes: [...CRAFT_WOODEN_PICKAXE_FAILURE_CODES],
}
