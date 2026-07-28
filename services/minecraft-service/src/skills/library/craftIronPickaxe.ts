// Ported from Voyager trial1 skill_library craftIronPickaxe.js / V2
// (MIT — see ../VENDORED.md). The original self-provisions: it mines iron
// ore and then smelts "iron_ore" — a 1.19-era bug, since iron ore has
// dropped raw_iron (the only smeltable form) since 1.17. This port drops
// the in-skill provisioning entirely: acquiring ingots is mineIronOre +
// smeltIronOre's job, and a MISSING_MATERIALS here propagates INTACT so the
// deliberator can schedule those skills — the same feedback loop the
// executor's refusals already drive today. The recipe: iron_ingot x3 +
// stick x2 at a crafting table. The single recovery kept from the original
// is the table: on RECIPE_UNAVAILABLE, place a crafting_table once and
// retry. The FIRST unrecovered failure code passes through unchanged.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/** Structural view of the primitives (owned by the primitives unit). */
export interface CraftIronPickaxePrimitives {
  craftItem(params: {
    itemName: string
    count?: number
  }): Promise<SkillResult<{ crafted: number }>>
  placeItem(params: {
    itemName: string
    position?: SkillPosition
  }): Promise<SkillResult<{ placed: boolean }>>
}

/** The iron pickaxe recipe is fixed; there is nothing to parameterize. */
export type CraftIronPickaxeParams = Record<string, never>

export interface CraftIronPickaxeOutcome {
  crafted: number
  /** True when the RECIPE_UNAVAILABLE recovery placed a crafting table. */
  tablePlaced: boolean
}

export async function craftIronPickaxe(
  primitives: CraftIronPickaxePrimitives,
  _params: CraftIronPickaxeParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<CraftIronPickaxeOutcome>> {
  const started = Date.now()
  let tablePlaced = false

  let attempt = await primitives.craftItem({ itemName: 'iron_pickaxe', count: 1 })
  while (!attempt.ok) {
    if (attempt.failureCode === 'RECIPE_UNAVAILABLE' && !tablePlaced) {
      const place = await primitives.placeItem({ itemName: 'crafting_table' })
      if (!place.ok) {
        return skillFail(place.failureCode, place.detail, Date.now() - started, ctx)
      }
      tablePlaced = true
      attempt = await primitives.craftItem({ itemName: 'iron_pickaxe', count: 1 })
      continue
    }
    // MISSING_MATERIALS (no ingots / no sticks) and everything else: the
    // FIRST failure code propagates INTACT — never remapped, never retried.
    return skillFail(attempt.failureCode, attempt.detail, Date.now() - started, ctx)
  }

  return skillOk(
    { crafted: attempt.outcome.crafted, tablePlaced },
    Date.now() - started,
    ctx,
  )
}

export const craftIronPickaxeSchema: SkillSchemaStub = {
  name: 'craftIronPickaxe',
  description:
    'Craft an iron pickaxe (iron_ingot x3 + stick x2 at a crafting table). ' +
    'Places a table once if none is in reach. Does NOT provision ' +
    'materials — MISSING_MATERIALS propagates so the caller can schedule ' +
    'mineIronOre / smeltIronOre / stick crafting first.',
  params: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  failureCodes: [
    'MISSING_MATERIALS',
    'RECIPE_UNAVAILABLE',
    'PLACE_FAILED',
    'TIMEOUT',
    'ABORTED',
    'INTERNAL',
  ],
}
