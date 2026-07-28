// Port of Voyager's craftItem.js + craftHelper.js control primitives
// (MineDojo/Voyager, MIT — attribution in ../VENDORED.md). Substantial
// rewrite: typed, deps-injected (the CraftFlowDeps convention from
// src/world/crafting.ts), guarded name resolution, and the closed failure
// vocabulary instead of chat-side error prose. The original's two known
// hazards are fixed here: `recipesFor(...)[0]` was indexed UNGUARDED (a
// TypeError when the item has no recipe), and missing-ingredient diagnosis
// lived in a separate helper that re-fetched recipes — both are one guarded
// pass below.

import { skillFail, skillOk } from '../types.ts'
import type { SkillInvocationContext, SkillPosition, SkillResult } from '../types.ts'
import type { NameLookup } from '../names.ts'

/** Voyager's crafting-table search radius, verbatim. */
export const CRAFTING_TABLE_SEARCH_DISTANCE = 32

/** Walk budget for reaching a found table — must fit inside the executor's
 *  30s act watchdog alongside the craft itself. */
export const GOTO_TABLE_TIMEOUT_MS = 20_000

/** One ingredient line of a recipe, name carried alongside the id so failure
 *  prose never needs a reverse lookup (craftHelper resolved names through
 *  mcData.items[id] at message-build time — a second unguarded read). */
export interface RecipeIngredient {
  itemId: number
  name: string
  /** required per single application of the recipe */
  count: number
}

/** The minimal structural slice of a mineflayer Recipe the primitive needs.
 *  Adapters map bot.recipesAll rows into this shape. */
export interface Recipe {
  requiresTable: boolean
  ingredients: readonly RecipeIngredient[]
}

export interface CraftItemDeps {
  /** guarded lookup (names.ts guardedItem under the hood) */
  resolveItem(name: string): NameLookup
  /** Every recipe for the item usable given table availability: with
   *  tableNearby false, only table-free recipes. NOT filtered by inventory —
   *  material gaps are this primitive's job to diagnose, not the adapter's
   *  to hide (Voyager's recipesFor pre-filtered by inventory, which is why
   *  it needed craftHelper to re-fetch with recipesAll). */
  recipesFor(itemId: number, tableNearby: boolean): Recipe[]
  /** apply the recipe `count` times; 'failed' for any underlying throw */
  craft(recipe: Recipe, count: number): Promise<'crafted' | 'failed'>
  countInventory(itemId: number): number
  findCraftingTable(maxDistance: number): SkillPosition | null
  gotoBlock(pos: SkillPosition, timeoutMs: number): Promise<'arrived' | 'failed'>
  now(): number
}

export interface CraftItemParams {
  name: string
  /** recipe applications, default 1 (yield can exceed this — planks come 4 a craft) */
  count?: number
}

/**
 * Craft `count` applications of the item's cheapest-to-satisfy recipe.
 * Failure order teaches the deepest gap first: unknown name, no recipe at
 * all, table missing, materials missing, unreachable table, then the craft
 * itself. The outcome reports the honest inventory delta, not the ask.
 */
export async function craftItem(
  deps: CraftItemDeps,
  params: CraftItemParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ crafted: number }>> {
  const started = deps.now()
  const cost = () => Math.max(0, deps.now() - started)
  // Non-finite counts (LLM params can carry anything) collapse to 1 — a NaN
  // would sail through every `have < required` comparison below.
  const asked = params.count ?? 1
  const count = Number.isFinite(asked) ? Math.max(1, Math.floor(asked)) : 1

  const lookup = deps.resolveItem(params.name)
  if (!lookup.ok) {
    return skillFail(lookup.failureCode, lookup.detail, cost(), ctx)
  }
  const item = lookup.value

  try {
    const table = deps.findCraftingTable(CRAFTING_TABLE_SEARCH_DISTANCE)
    const recipes = deps.recipesFor(item.id, table !== null)

    if (recipes.length === 0) {
      // The guard Voyager lacked: its `bot.recipesFor(...)[0]` threw a
      // TypeError here. Distinguish "no recipe exists" from "the recipe
      // needs a table and none stands nearby".
      const withTable = table !== null ? [] : deps.recipesFor(item.id, true)
      if (withTable.length > 0) {
        return skillFail(
          'RESOURCE_NOT_FOUND',
          `crafting_table: crafting ${item.name} needs a crafting table and none stands within ${CRAFTING_TABLE_SEARCH_DISTANCE} blocks`,
          cost(),
          ctx,
        )
      }
      return skillFail('RECIPE_UNAVAILABLE', `no recipe for "${item.name}"`, cost(), ctx)
    }

    // craftHelper's fewest-missing selection, one pass, scaled to the whole
    // batch: the villager should hear about its actual shortfall, not a
    // from-scratch variant's.
    let best: Recipe = recipes[0]!
    let bestMissing = Infinity
    let bestGaps: string[] = []
    for (const recipe of recipes) {
      let missing = 0
      const gaps: string[] = []
      for (const ingredient of recipe.ingredients) {
        const required = ingredient.count * count
        const have = deps.countInventory(ingredient.itemId)
        if (have < required) {
          missing += required - have
          gaps.push(`${required - have} more ${ingredient.name}`)
        }
      }
      // Fewest missing wins; on a tie, a table-free recipe beats a table
      // recipe (both satisfiable means the table walk would be pure waste).
      if (missing < bestMissing || (missing === bestMissing && best.requiresTable && !recipe.requiresTable)) {
        bestMissing = missing
        best = recipe
        bestGaps = gaps
      }
    }
    if (bestMissing > 0) {
      return skillFail(
        'MISSING_MATERIALS',
        `crafting ${count} ${item.name} needs ${bestGaps.join(', ')}`,
        cost(),
        ctx,
      )
    }

    if (best.requiresTable) {
      if (table === null) {
        // Defensive: a sloppy adapter returned a table recipe with no table
        // in reach — same gap as the empty-recipes table case.
        return skillFail(
          'RESOURCE_NOT_FOUND',
          `crafting_table: crafting ${item.name} needs a crafting table and none stands within ${CRAFTING_TABLE_SEARCH_DISTANCE} blocks`,
          cost(),
          ctx,
        )
      }
      const walked = await deps.gotoBlock(table, GOTO_TABLE_TIMEOUT_MS)
      if (walked === 'failed') {
        return skillFail(
          'PATH_NOT_FOUND',
          `could not reach the crafting table at (${table.x}, ${table.y}, ${table.z})`,
          cost(),
          ctx,
        )
      }
    }

    const before = deps.countInventory(item.id)
    const outcome = await deps.craft(best, count)
    if (outcome === 'failed') {
      return skillFail('INTERNAL', `craft of ${item.name} failed mid-recipe`, cost(), ctx)
    }
    const crafted = Math.max(0, deps.countInventory(item.id) - before)
    return skillOk({ crafted }, cost(), ctx)
  } catch (err) {
    return skillFail(
      'INTERNAL',
      `craftItem(${item.name}): ${err instanceof Error ? err.message : String(err)}`,
      cost(),
      ctx,
    )
  }
}
