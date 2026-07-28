// Voyager control-primitive port (MineDojo/Voyager, MIT — attribution in
// ../VENDORED.md): useChest.js (getItemFromChest / depositItemIntoChest /
// checkItemInsideChest, absorbing its moveToChest / closeChest helpers)
// rewritten typed + deps-injected. The original /tp-teleports the bot when
// the chest is far, chats failures into the void, and swallows withdraw and
// deposit errors; this port walks honestly, returns coded failures, and
// reports per-item partial transfers in the outcome. Every world touch
// arrives through UseChestDeps (the CraftFlowDeps convention), so the flows
// are unit-testable without a bot.

import {
  skillFail,
  skillOk,
  type SkillInvocationContext,
  type SkillPosition,
  type SkillResult,
} from '../types.ts'
import type { NameLookup } from '../names.ts'

/** Voyager parity: how far the body scans when hunting for another chest. */
export const CHEST_SEARCH_DISTANCE = 32

/** Walk budget to the chest — must fit the act node's watchdog alongside
 *  the container work itself. */
export const CHEST_GOTO_TIMEOUT_MS = 20_000

/**
 * Minimal structural chest window. The assembly adapter wraps mineflayer's
 * Container; withdraw/deposit resolve the count ACTUALLY moved (0 when the
 * chest lacks the item, the pack lacks the item, or the receiving side has
 * no room) — honest partials are the whole contract here.
 */
export interface ChestHandle {
  /** current chest contents; may repeat a name across stacks */
  items(): Array<{ name: string; count: number }>
  /** move up to count of itemId chest → inventory; resolves the count moved */
  withdraw(itemId: number, count: number): Promise<number>
  /** move up to count of itemId inventory → chest; resolves the count moved */
  deposit(itemId: number, count: number): Promise<number>
  close(): Promise<void>
}

export interface UseChestDeps {
  findChest(maxDistance: number): SkillPosition | null
  /** walk within interaction range; false = no path inside the budget */
  gotoBlock(pos: SkillPosition, timeoutMs: number): Promise<boolean>
  openChest(pos: SkillPosition): Promise<ChestHandle | null>
  /** guarded name lookup (wire guardedItem over live minecraft-data) */
  resolveItem(name: string): NameLookup
  inventoryFull(): boolean
  now(): number
}

interface ResolvedRequest {
  /** canonical (alias-resolved) item name — outcome maps key on this */
  name: string
  id: number
  count: number
}

type Resolved =
  | { ok: true; requests: ResolvedRequest[] }
  | { ok: false; failureCode: 'UNSUPPORTED_NAME'; detail: string }

/** Resolve every requested name up front — a bad name fails the call before
 *  the body moves. Entries asking for zero or less are dropped. */
function resolveRequests(deps: UseChestDeps, items: Record<string, number>): Resolved {
  const requests: ResolvedRequest[] = []
  for (const [name, count] of Object.entries(items)) {
    const want = Math.floor(count)
    if (want <= 0) {
      continue
    }
    const lookup = deps.resolveItem(name)
    if (!lookup.ok) {
      return { ok: false, failureCode: lookup.failureCode, detail: lookup.detail }
    }
    requests.push({ name: lookup.value.name, id: lookup.value.id, count: want })
  }
  return { ok: true, requests }
}

type Approach =
  | { ok: true; handle: ChestHandle }
  | { ok: false; failureCode: 'PATH_NOT_FOUND' | 'CONTAINER_NOT_FOUND'; detail: string }

/** Voyager's moveToChest, honestly: walk (never /tp), then open; a chest that
 *  is absent or will not open is CONTAINER_NOT_FOUND, with the nearest real
 *  chest named when one stands in range. */
async function approachChest(deps: UseChestDeps, pos: SkillPosition): Promise<Approach> {
  if (!(await deps.gotoBlock(pos, CHEST_GOTO_TIMEOUT_MS))) {
    return { ok: false, failureCode: 'PATH_NOT_FOUND', detail: `no path to the chest at ${at(pos)}` }
  }
  const handle = await deps.openChest(pos)
  if (!handle) {
    const nearest = deps.findChest(CHEST_SEARCH_DISTANCE)
    const hint = nearest
      ? `the nearest chest stands at ${at(nearest)}`
      : `no chest stands within ${CHEST_SEARCH_DISTANCE} blocks`
    return { ok: false, failureCode: 'CONTAINER_NOT_FOUND', detail: `no chest opens at ${at(pos)} — ${hint}` }
  }
  return { ok: true, handle }
}

function at(pos: SkillPosition): string {
  return `(${pos.x}, ${pos.y}, ${pos.z})`
}

function summary(transferred: Record<string, number>): string {
  return Object.entries(transferred)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ')
}

function countByName(handle: ChestHandle, name: string): number {
  return handle
    .items()
    .filter((stack) => stack.name === name)
    .reduce((sum, stack) => sum + stack.count, 0)
}

/**
 * Take items out of the chest at chestPosition. Outcome maps canonical item
 * name → count: `taken` is what actually landed in the pack, `missing` the
 * per-item shortfall. Every requested item absent is TARGET_NOT_FOUND; a
 * pack already full is INVENTORY_FULL before walking, and a pack that fills
 * mid-withdraw is INVENTORY_FULL with what was taken named in the detail
 * (those items are KEPT — the failure reports, it does not roll back).
 */
export async function getItemFromChest(
  deps: UseChestDeps,
  params: { chestPosition: SkillPosition; items: Record<string, number> },
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ taken: Record<string, number>; missing: Record<string, number> }>> {
  const startedAt = deps.now()
  const elapsed = () => deps.now() - startedAt

  const resolved = resolveRequests(deps, params.items)
  if (!resolved.ok) {
    return skillFail(resolved.failureCode, resolved.detail, elapsed(), ctx)
  }
  if (deps.inventoryFull()) {
    return skillFail(
      'INVENTORY_FULL',
      'your pack is full — make room before taking from the chest',
      elapsed(),
      ctx,
    )
  }

  const approach = await approachChest(deps, params.chestPosition)
  if (!approach.ok) {
    return skillFail(approach.failureCode, approach.detail, elapsed(), ctx)
  }

  const taken: Record<string, number> = {}
  const missing: Record<string, number> = {}
  try {
    for (const request of resolved.requests) {
      if (deps.inventoryFull()) {
        return skillFail(
          'INVENTORY_FULL',
          `your pack filled mid-withdraw — took ${summary(taken) || 'nothing'}; the rest stays in the chest`,
          elapsed(),
          ctx,
        )
      }
      const inChest = countByName(approach.handle, request.name)
      if (inChest <= 0) {
        missing[request.name] = request.count
        continue
      }
      const moved = await approach.handle.withdraw(request.id, Math.min(request.count, inChest))
      if (moved > 0) {
        taken[request.name] = moved
      }
      if (moved < request.count) {
        missing[request.name] = request.count - moved
      }
    }
  } finally {
    await approach.handle.close()
  }

  if (resolved.requests.length > 0 && Object.keys(taken).length === 0) {
    return skillFail(
      'TARGET_NOT_FOUND',
      `none of ${resolved.requests.map((r) => r.name).join(', ')} in the chest at ${at(params.chestPosition)}`,
      elapsed(),
      ctx,
    )
  }
  return skillOk({ taken, missing }, elapsed(), ctx)
}

/**
 * Put items into the chest at chestPosition. Outcome maps canonical item
 * name → count: `deposited` is what actually left the pack, `kept` the
 * per-item remainder still carried (or never carried). Depositing nothing at
 * all is MISSING_MATERIALS — the pack held none of it, or the chest had no
 * room (the ChestHandle seam reports only what moved).
 */
export async function depositItemIntoChest(
  deps: UseChestDeps,
  params: { chestPosition: SkillPosition; items: Record<string, number> },
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ deposited: Record<string, number>; kept: Record<string, number> }>> {
  const startedAt = deps.now()
  const elapsed = () => deps.now() - startedAt

  const resolved = resolveRequests(deps, params.items)
  if (!resolved.ok) {
    return skillFail(resolved.failureCode, resolved.detail, elapsed(), ctx)
  }

  const approach = await approachChest(deps, params.chestPosition)
  if (!approach.ok) {
    return skillFail(approach.failureCode, approach.detail, elapsed(), ctx)
  }

  const deposited: Record<string, number> = {}
  const kept: Record<string, number> = {}
  try {
    for (const request of resolved.requests) {
      const moved = await approach.handle.deposit(request.id, request.count)
      if (moved > 0) {
        deposited[request.name] = moved
      }
      if (moved < request.count) {
        kept[request.name] = request.count - moved
      }
    }
  } finally {
    await approach.handle.close()
  }

  if (resolved.requests.length > 0 && Object.keys(deposited).length === 0) {
    return skillFail(
      'MISSING_MATERIALS',
      `deposited nothing — you carry none of ${resolved.requests.map((r) => r.name).join(', ')}, or the chest has no room`,
      elapsed(),
      ctx,
    )
  }
  return skillOk({ deposited, kept }, elapsed(), ctx)
}

/**
 * Read the chest at chestPosition without moving anything. Contents are
 * aggregated per item name (Voyager's listItemsInChest reduce), so a chest
 * holding two stick stacks reports one stick entry.
 */
export async function checkItemInsideChest(
  deps: UseChestDeps,
  params: { chestPosition: SkillPosition },
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ contents: Array<{ name: string; count: number }> }>> {
  const startedAt = deps.now()
  const elapsed = () => deps.now() - startedAt

  const approach = await approachChest(deps, params.chestPosition)
  if (!approach.ok) {
    return skillFail(approach.failureCode, approach.detail, elapsed(), ctx)
  }

  let contents: Array<{ name: string; count: number }>
  try {
    const perName = new Map<string, number>()
    for (const stack of approach.handle.items()) {
      perName.set(stack.name, (perName.get(stack.name) ?? 0) + stack.count)
    }
    contents = [...perName.entries()].map(([name, count]) => ({ name, count }))
  } finally {
    await approach.handle.close()
  }

  return skillOk({ contents }, elapsed(), ctx)
}
