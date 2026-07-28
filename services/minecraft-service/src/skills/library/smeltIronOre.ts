// Ported from Voyager trial1 skill_library smeltFiveRawIron.js / V2
// (MIT — see ../VENDORED.md). The name keeps the repo's ore-chain framing,
// but the furnace INPUT is raw_iron — iron ore has dropped raw_iron since
// 1.17, and smelting the ore block itself stopped being possible then
// (Voyager's own craftIronPickaxe.js still tries to smelt "iron_ore"; its
// smeltFiveRawIron.js got it right). The original crafts a furnace via a
// cross-skill call and always places it; this port keeps composition at the
// caller (a missing furnace ITEM is craftFurnace's job) and recovers only
// from a missing placed furnace: on CONTAINER_NOT_FOUND, place one from
// inventory and retry once. Everything else propagates INTACT.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/** Structural view of the primitives (owned by the primitives unit). */
export interface SmeltIronOrePrimitives {
  smeltItem(params: {
    itemName: string
    fuelName: string
    count?: number
  }): Promise<SkillResult<{ smelted: number }>>
  placeItem(params: {
    itemName: string
    position?: SkillPosition
  }): Promise<SkillResult<{ placed: boolean }>>
}

export type SmeltFuel = 'coal' | 'charcoal'

export interface SmeltIronOreParams {
  /** raw_iron to smelt; null/omitted -> DEFAULT_SMELT_COUNT. */
  count?: number | null
  /** Furnace fuel; null/omitted -> coal (the race chain's fuel). */
  fuelName?: SmeltFuel | null
}

export interface SmeltIronOreOutcome {
  smelted: number
  requested: number
  fuelName: SmeltFuel
  /** True when the CONTAINER_NOT_FOUND recovery placed a furnace. */
  furnacePlaced: boolean
}

/** smeltFiveRawIron's five: 3 ingots for the pickaxe plus headroom. */
export const DEFAULT_SMELT_COUNT = 5

export async function smeltIronOre(
  primitives: SmeltIronOrePrimitives,
  params: SmeltIronOreParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<SmeltIronOreOutcome>> {
  const started = Date.now()
  const count = params.count ?? DEFAULT_SMELT_COUNT
  if (!Number.isInteger(count) || count < 1) {
    // Bounds are stripped from the wire schema, so a bad count CAN arrive.
    return skillFail(
      'INTERNAL',
      `count must be a positive integer, got ${count}`,
      Date.now() - started,
      ctx,
    )
  }
  const fuelName: SmeltFuel = params.fuelName ?? 'coal'
  let furnacePlaced = false

  let attempt = await primitives.smeltItem({ itemName: 'raw_iron', fuelName, count })
  while (!attempt.ok) {
    if (attempt.failureCode === 'CONTAINER_NOT_FOUND' && !furnacePlaced) {
      const place = await primitives.placeItem({ itemName: 'furnace' })
      if (!place.ok) {
        // MISSING_MATERIALS here means no furnace item either — propagate
        // so the caller can schedule craftFurnace.
        return skillFail(place.failureCode, place.detail, Date.now() - started, ctx)
      }
      furnacePlaced = true
      attempt = await primitives.smeltItem({ itemName: 'raw_iron', fuelName, count })
      continue
    }
    // MISSING_MATERIALS (no raw_iron / no fuel) and everything else
    // propagates INTACT — never remapped.
    return skillFail(attempt.failureCode, attempt.detail, Date.now() - started, ctx)
  }

  return skillOk(
    { smelted: attempt.outcome.smelted, requested: count, fuelName, furnacePlaced },
    Date.now() - started,
    ctx,
  )
}

export const smeltIronOreSchema: SkillSchemaStub = {
  name: 'smeltIronOre',
  description:
    'Smelt raw_iron into iron_ingot in a furnace (the input is raw_iron — ' +
    'what mineIronOre drops — never the ore block, per 1.17+). Places a ' +
    'furnace from inventory once if none is in reach. ' +
    `count null -> ${DEFAULT_SMELT_COUNT}; fuelName null -> coal.`,
  params: {
    type: 'object',
    properties: {
      count: {
        type: ['integer', 'null'],
        description: `raw_iron to smelt; null -> ${DEFAULT_SMELT_COUNT}.`,
      },
      fuelName: {
        anyOf: [{ enum: ['coal', 'charcoal'] }, { type: 'null' }],
        description: 'Furnace fuel; null -> coal.',
      },
    },
    required: ['count', 'fuelName'],
    additionalProperties: false,
  },
  failureCodes: [
    'CONTAINER_NOT_FOUND',
    'MISSING_MATERIALS',
    'PLACE_FAILED',
    'TIMEOUT',
    'ABORTED',
    'INTERNAL',
  ],
}
