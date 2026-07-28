// Voyager control-primitive port (MineDojo/Voyager, MIT — attribution in
// ../VENDORED.md): smeltItem.js rewritten typed + deps-injected. The original
// hard-waits 12 * 20 ticks per item and only then inspects the output slot;
// this port POLLS the output slot on injected time against an overall budget,
// takes output as it appears, and reports the honest partial count on
// timeout. Every world touch arrives through SmeltItemDeps (the CraftFlowDeps
// convention), so the flow is unit-testable without a bot.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
} from '../types.ts'
import type { NameLookup } from '../names.ts'

/** Voyager parity: how far the body scans for a standing furnace. */
export const FURNACE_SEARCH_DISTANCE = 32

/** Walk budget to the furnace — must fit the act node's watchdog alongside
 *  the smelt itself. */
export const FURNACE_GOTO_TIMEOUT_MS = 20_000

/** Output-slot poll cadence. Injected time — tests drive a fake clock. */
export const SMELT_POLL_INTERVAL_MS = 1_000

/** Overall budget per item asked: vanilla cooks one item in 10s and Voyager
 *  hard-waited 12s; 15s absorbs fuel-lighting lag without hanging on a dead
 *  furnace for long. */
export const SMELT_BUDGET_PER_ITEM_MS = 15_000

/**
 * Minimal structural furnace window. The assembly adapter wraps mineflayer's
 * Furnace; putFuel MAY no-op when the furnace is still burning — fuel economy
 * is adapter policy (fuelSeconds is deliberately not part of this seam).
 */
export interface FurnaceHandle {
  putInput(itemId: number, count: number): Promise<void>
  putFuel(itemId: number, count: number): Promise<void>
  /** items sitting in the output slot right now */
  outputCount(): number
  /** drain the output slot into the inventory */
  takeOutput(): Promise<void>
  close(): Promise<void>
}

export interface SmeltItemDeps {
  /** guarded name lookup (wire guardedItem over live minecraft-data) */
  resolveItem(name: string): NameLookup
  findFurnace(maxDistance: number): SkillPosition | null
  /** walk within interaction range; false = no path inside the budget */
  gotoBlock(pos: SkillPosition, timeoutMs: number): Promise<boolean>
  openFurnace(pos: SkillPosition): Promise<FurnaceHandle | null>
  countInventory(itemId: number): number
  now(): number
  sleep(ms: number): Promise<void>
}

export interface SmeltItemParams {
  itemName: string
  fuelName: string
  count?: number
}

/**
 * Smelt up to params.count of itemName using fuelName. Outcome reports the
 * HONEST count taken from the output slot: a timeout with at least one item
 * smelted is ok:true with smelted < count (what cooked is in the pack); a
 * timeout with nothing smelted is TIMEOUT. No furnace in range is
 * RESOURCE_NOT_FOUND; an empty input or fuel stack is MISSING_MATERIALS
 * before the body moves at all.
 */
export async function smeltItem(
  deps: SmeltItemDeps,
  params: SmeltItemParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ smelted: number }>> {
  const startedAt = deps.now()
  const elapsed = () => deps.now() - startedAt
  const target = Math.max(1, Math.floor(params.count ?? 1))

  const input = deps.resolveItem(params.itemName)
  if (!input.ok) {
    return skillFail(input.failureCode, input.detail, elapsed(), ctx)
  }
  const fuel = deps.resolveItem(params.fuelName)
  if (!fuel.ok) {
    return skillFail(fuel.failureCode, fuel.detail, elapsed(), ctx)
  }

  if (deps.countInventory(input.value.id) <= 0) {
    return skillFail(
      'MISSING_MATERIALS',
      `no ${input.value.name} to smelt in your pack — gather it first, then smelt`,
      elapsed(),
      ctx,
    )
  }
  if (deps.countInventory(fuel.value.id) <= 0) {
    return skillFail(
      'MISSING_MATERIALS',
      `no ${fuel.value.name} to burn — carry fuel (coal burns longest) before smelting`,
      elapsed(),
      ctx,
    )
  }

  const furnaceAt = deps.findFurnace(FURNACE_SEARCH_DISTANCE)
  if (!furnaceAt) {
    return skillFail(
      'RESOURCE_NOT_FOUND',
      `no furnace within ${FURNACE_SEARCH_DISTANCE} blocks — craft and place one first`,
      elapsed(),
      ctx,
    )
  }
  if (!(await deps.gotoBlock(furnaceAt, FURNACE_GOTO_TIMEOUT_MS))) {
    return skillFail(
      'PATH_NOT_FOUND',
      `no path to the furnace at (${furnaceAt.x}, ${furnaceAt.y}, ${furnaceAt.z})`,
      elapsed(),
      ctx,
    )
  }
  const furnace = await deps.openFurnace(furnaceAt)
  if (!furnace) {
    return skillFail(
      'RESOURCE_NOT_FOUND',
      `the furnace at (${furnaceAt.x}, ${furnaceAt.y}, ${furnaceAt.z}) would not open`,
      elapsed(),
      ctx,
    )
  }

  const budgetMs = target * SMELT_BUDGET_PER_ITEM_MS
  const deadline = deps.now() + budgetMs
  let smelted = 0
  let loaded = 0
  try {
    while (smelted < target && deps.now() < deadline) {
      const ready = furnace.outputCount()
      if (ready > 0) {
        await furnace.takeOutput()
        smelted += ready
        continue
      }
      if (loaded < target && deps.countInventory(input.value.id) > 0) {
        // One fuel rides along with each input; the adapter skips the put
        // when the furnace is still burning (see FurnaceHandle).
        if (deps.countInventory(fuel.value.id) > 0) {
          await furnace.putFuel(fuel.value.id, 1)
        }
        await furnace.putInput(input.value.id, 1)
        loaded += 1
        continue
      }
      if (loaded === smelted) {
        // Nothing cooking and nothing left to load — no further progress is
        // possible, so return the honest partial now instead of at deadline.
        break
      }
      await deps.sleep(SMELT_POLL_INTERVAL_MS)
    }
  } finally {
    await furnace.close()
  }

  if (smelted > 0) {
    return skillOk({ smelted }, elapsed(), ctx)
  }
  if (loaded === 0) {
    // The pre-check saw input, but it was gone by the time the furnace
    // opened (the world can shift during the walk) — a materials problem,
    // not a time problem.
    return skillFail(
      'MISSING_MATERIALS',
      `your ${input.value.name} was gone by the time the furnace opened — gather more and smelt again`,
      elapsed(),
      ctx,
    )
  }
  return skillFail(
    'TIMEOUT',
    `nothing came out of the furnace within ${budgetMs}ms — check that ${input.value.name} smelts and ${fuel.value.name} burns`,
    elapsed(),
    ctx,
  )
}
