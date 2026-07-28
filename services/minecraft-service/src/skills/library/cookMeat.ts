// Generalization of Voyager's cook skills — trial1 cookPorkchops.js /
// cookSevenMutton.js, trial2 cookMutton.js, trial3 cookChicken.js /
// cookRawBeef.js / cookRawMutton.js / cookThreeRawChicken.js (MIT —
// attribution in ../VENDORED.md). Every original hand-rolled the same shape:
// ensure a furnace (craft it, place it at an offset), then
// smeltItem(bot, <raw meat>, 'coal', N). The port folds all seven into one
// typed skill: the smeltItem primitive owns the furnace and the fuel choice
// (any fuel, not just coal), and the meat is a closed enum so an invalid meat
// name is unrepresentable.
//
// 1.21.6 naming: the raw meat item IS the plain meat name ('porkchop',
// 'beef', 'chicken', 'mutton' — the raw_ prefixes died in the 1.13
// flattening), and the smelted result is cooked_<meat>.

import { skillFail, skillOk } from '../types.ts'
import type {
  SkillInvocationContext,
  SkillResult,
  SkillSchemaStub,
} from '../types.ts'

export const MEAT_NAMES = ['porkchop', 'beef', 'chicken', 'mutton'] as const

export type MeatName = (typeof MEAT_NAMES)[number]

/**
 * Structural view of the smeltItem primitive. Declared locally — the
 * primitives unit owns the implementation; this skill compiles against the
 * shape only. Omitting fuelName means "any fuel the primitive can find".
 */
export interface CookMeatPrimitives {
  smeltItem(params: {
    itemName: string
    count: number
    fuelName?: string | null
  }): Promise<SkillResult<{ smelted: number }>>
}

export interface CookMeatParams {
  meat: MeatName
  /** How many to cook; defaults to 1 (Voyager variants ranged 1–7). */
  count?: number
}

export async function cookMeat(
  primitives: CookMeatPrimitives,
  params: CookMeatParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ cooked: number }>> {
  const startedAt = Date.now()
  // The wire schema carries no bounds (stripped for strict mode), so clamp
  // here: a zero/negative count from the LLM cooks 1, never reaches the
  // primitive as nonsense.
  const count = Math.max(1, Math.floor(params.count ?? 1))
  const result = await primitives.smeltItem({
    itemName: params.meat,
    count,
  })
  const costMs = Date.now() - startedAt
  if (!result.ok) {
    // First failure propagated intact — never remapped.
    return skillFail(result.failureCode, result.detail, costMs, ctx)
  }
  return skillOk({ cooked: result.outcome.smelted }, costMs, ctx)
}

export const cookMeatSchema: SkillSchemaStub = {
  name: 'cookMeat',
  description:
    'Cook raw meat in a furnace using any available fuel. The smelt ' +
    'primitive finds or places the furnace; fails MISSING_MATERIALS when ' +
    'raw meat or fuel is absent.',
  params: {
    type: 'object',
    properties: {
      meat: {
        type: 'string',
        enum: [...MEAT_NAMES],
        description: 'Which raw meat to cook.',
      },
      count: {
        type: ['integer', 'null'],
        description: 'How many to cook; null cooks 1.',
      },
    },
    required: ['meat', 'count'],
    additionalProperties: false,
  },
  failureCodes: [
    'MISSING_MATERIALS',
    'CONTAINER_NOT_FOUND',
    'PLACE_FAILED',
    'TIMEOUT',
    'ABORTED',
    'INTERNAL',
  ],
}
