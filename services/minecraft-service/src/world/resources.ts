import type { Position } from './position.ts'

/**
 * Resource families → concrete block names, plus the pure harvest logic
 * (tool choice, failure prose). The contract speaks in families
 * (wood/stone/dirt); Minecraft speaks in blocks. Unit-tested, and the
 * single place to extend when new resources join the economy.
 */
export const RESOURCE_BLOCKS: Record<string, readonly string[]> = {
  wood: [
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
  ],
  stone: ['stone', 'cobblestone', 'andesite', 'diorite', 'granite'],
  dirt: ['dirt', 'grass_block'],
} as const

export function blockNamesFor(resource: string): readonly string[] | undefined {
  return RESOURCE_BLOCKS[resource]
}

/** Which inventory item names count as yield for a family (grass_block drops dirt, stone drops cobblestone). */
export const RESOURCE_YIELD: Record<string, readonly string[]> = {
  wood: RESOURCE_BLOCKS.wood as readonly string[],
  stone: ['cobblestone', 'stone'],
  dirt: ['dirt'],
} as const

/** The slice of prismarine-block the harvest planner reads — structural, so tests fake it. */
export interface DiggableBlock {
  name: string
  /** item ids that make this block drop; absent = anything works, bare hands included */
  harvestTools?: Record<string, boolean>
  canHarvest(heldItemType: number | null): boolean
  digTime(heldItemType: number | null, creative: boolean, inWater: boolean, notOnGround: boolean): number
}

export type HarvestPlan<T> =
  | { kind: 'dig' } // bare hands both harvest this and are as fast as anything carried
  | { kind: 'equip'; item: T } // equip first: required for drops, or strictly faster
  | { kind: 'blocked'; toolHint: string } // nothing carried makes this block drop — digging would waste the swing

/**
 * Decide what to hold before digging `block`. The canHarvest gate is about
 * DROPS, not speed — stone dug bare-handed breaks eventually but yields
 * nothing, which is how an M1 gather could "complete" with collected: 0.
 */
export function planHarvest<T extends { type: number; name: string }>(
  block: DiggableBlock,
  items: readonly T[],
  itemName: (id: number) => string | undefined,
): HarvestPlan<T> {
  let best: T | undefined
  let bestTime = Infinity
  for (const item of items) {
    if (!block.canHarvest(item.type)) {
      continue
    }
    const time = block.digTime(item.type, false, false, false)
    if (time < bestTime) {
      bestTime = time
      best = item
    }
  }
  if (block.canHarvest(null)) {
    // Bare hands already yield drops; equip only a strict improvement (a
    // pickaxe doesn't speed up wood — don't wave it around for nothing).
    return best && bestTime < block.digTime(null, false, false, false) ? { kind: 'equip', item: best } : { kind: 'dig' }
  }
  return best ? { kind: 'equip', item: best } : { kind: 'blocked', toolHint: toolHint(block, itemName) }
}

/** "a pickaxe" when every qualifying tool is one; otherwise list them out. */
function toolHint(block: DiggableBlock, itemName: (id: number) => string | undefined): string {
  const names = Object.keys(block.harvestTools ?? {})
    .map((id) => itemName(Number(id)))
    .filter((name): name is string => Boolean(name))
  if (names.length === 0) {
    return 'a proper tool'
  }
  const classes = new Set(names.map((name) => name.split('_').pop()))
  const only = classes.size === 1 ? [...classes][0] : undefined
  return only ? `a ${only}` : `one of: ${names.join(', ')}`
}

/**
 * Prescriptive RESOURCE_NOT_FOUND prose. This exact string is what the
 * villager reads on its next tick (ActionFailed → percept → prompt), so the
 * diagnosis must carry the fix: what was searched, from where, and the
 * concrete retry that could land differently. A bare "no wood within 10
 * blocks" taught M1's villagers learned helplessness.
 */
export function gatherFailureMessage(resource: string, maxDistance: number, center: Position | null): string {
  const from = center ? ` of (${Math.round(center.x)}, ${Math.round(center.y)}, ${Math.round(center.z)})` : ''
  const widened = maxDistance < 48 ? 48 : maxDistance < 64 ? 64 : null
  if (widened) {
    return `no ${resource} within ${maxDistance} blocks${from} — try maxDistance ${widened} (the cap is 64), or move somewhere new first`
  }
  return `no ${resource} within ${maxDistance} blocks${from} — that is the search cap; move somewhere new and try again`
}
