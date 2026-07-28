// Port of Voyager craftWoodenSword.js (trial1/trial3 — MIT, attribution in
// ../VENDORED.md). The original counted oak_planks/stick via unguarded mcData
// lookups, crafted the shortfall from oak logs, placed a crafting_table by
// hand, then crafted the sword. The port keeps the dependency chain —
// planks -> sticks -> table -> sword — but every step goes through the
// craftItem primitive, which owns inventory checks, recipe resolution, and
// table placement. The FIRST failing step's code is propagated intact (never
// remapped): MISSING_MATERIALS from the planks step means "no logs", exactly
// like the original's early return.

import { skillFail, skillOk } from '../types.ts'
import type {
  SkillInvocationContext,
  SkillResult,
  SkillSchemaStub,
} from '../types.ts'

/**
 * Structural view of the craftItem primitive. Declared locally — the
 * primitives unit owns the implementation; this skill compiles against the
 * shape only.
 */
export interface CraftWoodenSwordPrimitives {
  craftItem(params: {
    itemName: string
    count: number
  }): Promise<SkillResult<{ crafted: number }>>
}

/** killOnePig-style skills take params; this one has none. */
export type CraftWoodenSwordParams = Record<string, never>

/**
 * Plank budget for the whole chain: 4 (crafting_table) + 2 (stick craft
 * yields 4 sticks) + 2 (sword blade) = 8 planks = 2 logs.
 */
export const CRAFT_STEPS: readonly Readonly<{
  itemName: string
  count: number
}>[] = [
  { itemName: 'oak_planks', count: 8 },
  { itemName: 'stick', count: 1 },
  { itemName: 'crafting_table', count: 1 },
  { itemName: 'wooden_sword', count: 1 },
]

export async function craftWoodenSword(
  primitives: CraftWoodenSwordPrimitives,
  _params: CraftWoodenSwordParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ crafted: true; item: 'wooden_sword' }>> {
  const startedAt = Date.now()
  for (const step of CRAFT_STEPS) {
    const result = await primitives.craftItem(step)
    if (!result.ok) {
      // First failure propagated intact — never remapped.
      return skillFail(
        result.failureCode,
        result.detail,
        Date.now() - startedAt,
        ctx,
      )
    }
  }
  return skillOk(
    { crafted: true, item: 'wooden_sword' },
    Date.now() - startedAt,
    ctx,
  )
}

export const craftWoodenSwordSchema: SkillSchemaStub = {
  name: 'craftWoodenSword',
  description:
    'Craft a wooden sword from oak logs: planks, then sticks, then a ' +
    'crafting table, then the sword. Fails MISSING_MATERIALS when the ' +
    'inventory cannot cover the chain.',
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
