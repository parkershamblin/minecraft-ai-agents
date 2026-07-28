// Ported from Voyager trial1 skill_library craftFurnace.js (MIT — see
// ../VENDORED.md). The original inspects bot.inventory up front to decide
// whether to mine cobblestone, then always places a crafting table. This
// port has no inventory primitive, so it inverts to attempt-first: craft,
// and recover from the two blockers the original pre-empted —
// MISSING_MATERIALS (mine stone; stone drops cobblestone without silk
// touch) and RECIPE_UNAVAILABLE (no crafting table in reach; place one).
// Each recovery runs at most once, then the craft is retried; anything
// else propagates INTACT, never remapped.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/** Structural view of the primitives (owned by the primitives unit). */
export interface CraftFurnacePrimitives {
  craftItem(params: {
    itemName: string
    count?: number
  }): Promise<SkillResult<{ crafted: number }>>
  mineBlock(params: {
    blockName: string
    count?: number
  }): Promise<SkillResult<{ mined: number }>>
  placeItem(params: {
    itemName: string
    position?: SkillPosition
  }): Promise<SkillResult<{ placed: boolean }>>
}

export interface CraftFurnaceParams {
  /** Furnaces to craft; null/omitted -> 1. */
  count?: number | null
}

export interface CraftFurnaceOutcome {
  crafted: number
  /** True when the RECIPE_UNAVAILABLE recovery placed a crafting table. */
  tablePlaced: boolean
  /** True when the MISSING_MATERIALS recovery mined stone for cobblestone. */
  stoneMined: boolean
}

/** The furnace recipe: 8 cobblestone around an empty center. */
export const COBBLESTONE_PER_FURNACE = 8

export async function craftFurnace(
  primitives: CraftFurnacePrimitives,
  params: CraftFurnaceParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<CraftFurnaceOutcome>> {
  const started = Date.now()
  const count = params.count ?? 1
  if (!Number.isInteger(count) || count < 1) {
    // Bounds are stripped from the wire schema, so a bad count CAN arrive.
    return skillFail(
      'INTERNAL',
      `count must be a positive integer, got ${count}`,
      Date.now() - started,
      ctx,
    )
  }
  let tablePlaced = false
  let stoneMined = false

  let attempt = await primitives.craftItem({ itemName: 'furnace', count })
  while (!attempt.ok) {
    if (attempt.failureCode === 'RECIPE_UNAVAILABLE' && !tablePlaced) {
      const place = await primitives.placeItem({ itemName: 'crafting_table' })
      if (!place.ok) {
        return skillFail(place.failureCode, place.detail, Date.now() - started, ctx)
      }
      tablePlaced = true
    } else if (attempt.failureCode === 'MISSING_MATERIALS' && !stoneMined) {
      const mine = await primitives.mineBlock({
        blockName: 'stone',
        count: COBBLESTONE_PER_FURNACE * count,
      })
      if (!mine.ok) {
        return skillFail(mine.failureCode, mine.detail, Date.now() - started, ctx)
      }
      stoneMined = true
    } else {
      // No recovery path left for this code — propagate INTACT.
      return skillFail(attempt.failureCode, attempt.detail, Date.now() - started, ctx)
    }
    attempt = await primitives.craftItem({ itemName: 'furnace', count })
  }

  return skillOk(
    { crafted: attempt.outcome.crafted, tablePlaced, stoneMined },
    Date.now() - started,
    ctx,
  )
}

export const craftFurnaceSchema: SkillSchemaStub = {
  name: 'craftFurnace',
  description:
    'Craft a furnace (8 cobblestone at a crafting table). Self-recovers ' +
    'once from missing cobblestone (mines stone) and once from no table in ' +
    'reach (places one); every other failure propagates unchanged. ' +
    'count null -> 1.',
  params: {
    type: 'object',
    properties: {
      count: {
        type: ['integer', 'null'],
        description: 'Furnaces to craft; null -> 1.',
      },
    },
    required: ['count'],
    additionalProperties: false,
  },
  failureCodes: [
    'RECIPE_UNAVAILABLE',
    'MISSING_MATERIALS',
    'PLACE_FAILED',
    'RESOURCE_NOT_FOUND',
    'PATH_NOT_FOUND',
    'TOOL_REQUIRED',
    'TIMEOUT',
    'INVENTORY_FULL',
    'ABORTED',
    'INTERNAL',
  ],
}
