// Port of Voyager skill_library/trial2/skill/code/craftStoneAxe.js
// (MIT — see src/skills/VENDORED.md). Same flow, typed and deps-injected:
// top up cobblestone by mining the deficit, top up sticks by crafting the
// deficit, reuse a nearby crafting table before placing one, then craft.
// Every terminating failure propagates the primitive's code intact — the
// one handled probe is findBlock's TARGET_NOT_FOUND, which triggers the
// place-a-table fallback instead of ending the skill.

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
 * The primitive slice this skill composes. Declared structurally — the
 * implementations live in src/skills/primitives/** (a parallel unit); any
 * object with these shapes satisfies the interface.
 */
export interface CraftStoneAxePrimitives {
  countItem(params: { name: string }): Promise<SkillResult<{ count: number }>>
  mineBlock(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ collected: number }>>
  /** count is the number of ITEMS wanted (the primitive translates to craft ops). */
  craftItem(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ crafted: number }>>
  /** Fails TARGET_NOT_FOUND when nothing matches within maxDistance. */
  findBlock(params: {
    name: string
    maxDistance?: number
  }): Promise<SkillResult<{ position: SkillPosition }>>
  placeItem(params: { name: string }): Promise<SkillResult<{ position: SkillPosition }>>
}

export type CraftStoneAxeParams = Record<string, never>

const COBBLESTONE_NEEDED = 3
const STICKS_NEEDED = 2
const TABLE_SEARCH_DISTANCE = 32

export async function craftStoneAxe(
  primitives: CraftStoneAxePrimitives,
  _params: CraftStoneAxeParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ crafted: number }>> {
  const t0 = Date.now()
  const failed = (r: { failureCode: SkillFailureCode; detail: string }) =>
    skillFail<{ crafted: number }>(r.failureCode, r.detail, Date.now() - t0, ctx)

  // 1) Cobblestone: mine the deficit (mining stone yields cobblestone).
  const cobble = await primitives.countItem({ name: 'cobblestone' })
  if (!cobble.ok) return failed(cobble)
  if (cobble.outcome.count < COBBLESTONE_NEEDED) {
    const mined = await primitives.mineBlock({
      name: 'stone',
      count: COBBLESTONE_NEEDED - cobble.outcome.count,
    })
    if (!mined.ok) return failed(mined)
  }

  // 2) Sticks: craft the deficit.
  const sticks = await primitives.countItem({ name: 'stick' })
  if (!sticks.ok) return failed(sticks)
  if (sticks.outcome.count < STICKS_NEEDED) {
    const crafted = await primitives.craftItem({
      name: 'stick',
      count: STICKS_NEEDED - sticks.outcome.count,
    })
    if (!crafted.ok) return failed(crafted)
  }

  // 3) Crafting table: reuse one nearby, else place one. Only TARGET_NOT_FOUND
  // selects the fallback; any other probe failure terminates the skill.
  const table = await primitives.findBlock({
    name: 'crafting_table',
    maxDistance: TABLE_SEARCH_DISTANCE,
  })
  if (!table.ok) {
    if (table.failureCode !== 'TARGET_NOT_FOUND') return failed(table)
    const placed = await primitives.placeItem({ name: 'crafting_table' })
    if (!placed.ok) return failed(placed)
  }

  // 4) Craft the axe.
  const result = await primitives.craftItem({ name: 'stone_axe', count: 1 })
  if (!result.ok) return failed(result)

  return skillOk({ crafted: result.outcome.crafted }, Date.now() - t0, ctx)
}

/**
 * Failure surface = union of what the composed primitives emit. Absent by
 * construction: TARGET_NOT_FOUND (handled probe → place fallback) and
 * CONTAINER_NOT_FOUND (no container primitive composed).
 */
export const craftStoneAxeSchema: SkillSchemaStub = {
  name: 'craftStoneAxe',
  description:
    'Craft a stone axe: mines missing cobblestone (3), crafts missing sticks (2), reuses or places a crafting table, then crafts.',
  params: {
    type: 'object',
    properties: {},
    required: [],
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
    'RECIPE_UNAVAILABLE',
    'MISSING_MATERIALS',
    'PLACE_FAILED',
    'ABORTED',
    'INTERNAL',
  ],
}
