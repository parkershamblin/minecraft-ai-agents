// The translation layer between the decision contract and the ported skill
// library (unit 10). Everything here is pure so it can be tested without a
// world: family resolution, the SkillResult -> executor-outcome mapping, and
// the retryability ruling per failure code. BotSession owns the bot-touching
// half; this file owns every judgement call.

import type { SkillFailureCode, SkillResult } from '../skills/types.ts'
import { RESOURCE_BLOCKS } from './resources.ts'

/**
 * Item-level families the store/retrieve verbs move in and out of chests.
 * Deliberately NOT RESOURCE_YIELD: that map answers "what does digging this
 * drop", while storage answers "what in the pack counts as this family" — a
 * villager who crafted their logs into planks still stored wood.
 *
 * `food` is absent on purpose. The edible set is version data, not ours to
 * hardcode: it resolves live against the registry's food table (see
 * resolveStorageItems), the same source the eat reflex reads.
 */
const WOOD_LOGS: readonly string[] = RESOURCE_BLOCKS.wood ?? []

export const STORAGE_FAMILIES: Record<string, readonly string[]> = {
  wood: [...WOOD_LOGS, ...WOOD_LOGS.map((log) => log.replace(/_log$/, '_planks'))],
  stone: ['cobblestone', 'stone'],
  coal: ['coal'],
  raw_iron: ['raw_iron'],
} as const

/** The slice of the registry the food family needs — structural, so tests fake it. */
export interface FoodRegistryLike {
  foods?: Record<number, unknown>
  itemsByName?: Record<string, { id: number } | undefined>
}

export interface CarriedItem {
  name: string
  count: number
}

/**
 * Concrete item names for a contract family, ordered by how much is carried
 * (deepest stack first) so a partial deposit moves the bulk, not a stray.
 * Only names actually present are returned — the caller reports
 * MISSING_MATERIALS on an empty list rather than opening a chest for nothing.
 */
export function resolveStorageItems(
  family: string,
  carried: readonly CarriedItem[],
  registry: FoodRegistryLike,
): string[] {
  const isMember =
    family === 'food'
      ? (name: string) => {
          const id = registry.itemsByName?.[name]?.id
          return id !== undefined && registry.foods?.[id] !== undefined
        }
      : (name: string) => (STORAGE_FAMILIES[family] ?? []).includes(name)

  const totals = new Map<string, number>()
  for (const stack of carried) {
    if (stack.count > 0 && isMember(stack.name)) {
      totals.set(stack.name, (totals.get(stack.name) ?? 0) + stack.count)
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
}

/**
 * Every item name that could belong to a family, independent of what is
 * carried. This is what a WITHDRAWAL asks the chest for: the pack is empty by
 * definition when retrieving, so the carried-stack path above has nothing to
 * work from. Food is enumerated from the registry's food table for the same
 * reason it is absent from STORAGE_FAMILIES — the edible set is version data.
 */
export function storageFamilyCandidates(family: string, registry: FoodRegistryLike): string[] {
  if (family !== 'food') return [...(STORAGE_FAMILIES[family] ?? [])]
  const names: string[] = []
  for (const [name, entry] of Object.entries(registry.itemsByName ?? {})) {
    if (entry && registry.foods?.[entry.id] !== undefined) names.push(name)
  }
  return names
}

/**
 * Spread a requested count across concrete stacks, deepest first. The chest
 * primitives take an explicit {name: count} plan rather than "as much as you
 * can", so the split has to happen here where it is testable.
 */
export function planItemCounts(
  names: readonly string[],
  carried: readonly CarriedItem[],
  wanted: number,
): Record<string, number> {
  const have = new Map<string, number>()
  for (const stack of carried) {
    have.set(stack.name, (have.get(stack.name) ?? 0) + stack.count)
  }
  const plan: Record<string, number> = {}
  let left = wanted
  for (const name of names) {
    if (left <= 0) break
    const take = Math.min(left, have.get(name) ?? 0)
    if (take > 0) {
      plan[name] = take
      left -= take
    }
  }
  return plan
}

/**
 * Would the IDENTICAL command plausibly succeed on a later tick with the
 * villager doing nothing differently? World-state gaps say yes (walk, and the
 * world has changed); pack- and knowledge-gaps say no — the same empty hands
 * fail the same way, and the message has to teach the missing step instead.
 * Mirrors the gather ruling the executor already applies to RESOURCE_NOT_FOUND
 * vs TOOL_TIER_REQUIRED.
 */
const RETRYABLE_BY_CODE: Record<SkillFailureCode, boolean> = {
  RESOURCE_NOT_FOUND: true,
  PATH_NOT_FOUND: false,
  TOOL_REQUIRED: false,
  TOOL_TIER_REQUIRED: false,
  TIMEOUT: true,
  INTERNAL: true,
  UNSUPPORTED_NAME: false,
  RECIPE_UNAVAILABLE: false,
  MISSING_MATERIALS: false,
  PLACE_FAILED: true,
  CONTAINER_NOT_FOUND: true,
  TARGET_NOT_FOUND: true,
  INVENTORY_FULL: false,
  ABORTED: true,
}

export function isRetryable(code: SkillFailureCode): boolean {
  return RETRYABLE_BY_CODE[code] ?? false
}

/** A coded, prescriptive skill failure — same shape crafting.ts throws, so the
 *  executor's existing pass-through handles it untouched and the message
 *  reaches the villager as its next percept verbatim. */
export function skillVerbError(code: SkillFailureCode, message: string): Error {
  const err = new Error(message) as Error & { code?: string; retryable?: boolean }
  err.code = code
  err.retryable = isRetryable(code)
  return err
}

/**
 * Unwrap a SkillResult for the executor: the outcome object on success, a
 * coded throw on failure. The skill's own `detail` is the message — the
 * library was written to teach the missing link (types.ts's closed vocabulary
 * exists so these strings stay honest), so it is passed through rather than
 * rewritten here.
 */
export function unwrapSkillResult<T>(result: SkillResult<T>): T {
  if (result.ok) return result.outcome
  throw skillVerbError(result.failureCode, result.detail)
}
