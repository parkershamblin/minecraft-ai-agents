import { type Position, distance, round1 } from './position.ts'

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

/** One WorldSnapshot.nearbyResources entry — the contract's shape exactly. */
export interface ResourceSighting {
  family: string
  nearestDistance: number
  count: number
}

export interface ScanOptions {
  /** 3D scan radius — keep aligned with GatherParams' default so "in sight" means "gatherable" */
  maxDistance: number
  /** per-family result cap; the snapshot's count reads "at least" beyond it */
  countCap: number
  /** |dy| beyond which a sighting is dropped — findBlock has no reachability
   *  check and a goto toward a cliff-face target never settles (M2-1 finding),
   *  so the snapshot only advertises blocks near the villager's own altitude */
  yBand: number
}

/** The slice of a mineflayer Bot the scan reads — structural, so tests fake it. */
export interface ScannableBot {
  entity: { position: Position } | undefined
  findBlocks(options: {
    matching: (block: { name: string }) => boolean
    maxDistance: number
    count: number
  }): Position[]
}

/**
 * The scan's skip gate. Measured 2026-07-08: an ungated 5s scan across 20
 * bots pins a full CPU core (~175ms per bot-scan — findBlocks sweeps 4096
 * blocks in every match-bearing section), and that core is the event loop
 * that runs command execution. A standing bot is staring at the same world,
 * so: rescan only after real movement, or when the survey is old enough
 * that someone may have dug the world out from under it.
 */
export function shouldRescan(
  last: { position: Position; at: number } | null,
  position: Position,
  now: number,
  opts: { moveBlocks: number; maxAgeMs: number },
): boolean {
  if (!last) {
    return true
  }
  return distance(position, last.position) >= opts.moveBlocks || now - last.at >= opts.maxAgeMs
}

/**
 * Survey every resource family around the bot for the snapshot's
 * nearbyResources line. Called on its own slow cadence (not the 1s snapshot
 * tick): each family is one findBlocks sweep, and although absent families
 * are cheap (palette pre-check skips their sections), present ones pay a
 * 4096-block section scan. Returns [] for "scanned, nothing in sight" —
 * the caller distinguishes that from "no scan yet" (null).
 *
 * The Y-band is a post-filter by necessity: findBlocks probes section
 * palettes with position-less Block instances, so a position-aware matcher
 * would wrongly skip whole sections.
 */
export function scanNearbyResources(bot: ScannableBot, opts: ScanOptions): ResourceSighting[] | null {
  const origin = bot.entity?.position
  if (!origin) {
    return null // not spawned — nothing truthful to report
  }
  const sightings: ResourceSighting[] = []
  for (const [family, names] of Object.entries(RESOURCE_BLOCKS)) {
    const positions = bot.findBlocks({
      matching: (block) => names.includes(block.name),
      maxDistance: opts.maxDistance,
      // Headroom for the post-filter: in-band blocks must survive even when
      // out-of-band ones (a mountainside of stone below) fill the cap first.
      count: opts.countCap * 2,
    })
    const inBand = positions.filter((p) => Math.abs(p.y - origin.y) <= opts.yBand)
    if (inBand.length === 0) {
      continue
    }
    sightings.push({
      family,
      // findBlocks returns nearest-first, but the Y-band filter may have
      // dropped the head of the list — recompute instead of trusting order.
      nearestDistance: round1(Math.min(...inBand.map((p) => distance(p, origin)))),
      count: Math.min(inBand.length, opts.countCap),
    })
  }
  return sightings
}

/** Blacklist key for a block position — whole-block resolution. */
export function targetKey(p: Position): string {
  return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
}

/**
 * Choose the nearest candidate that hasn't recently defeated this bot.
 * findBlock is deterministic from a standing position, so without memory a
 * failed target gets re-picked every tick — measured 2026-07-09: one
 * half-harvested slope spruce ate five watchdogs across three villagers,
 * drawing them in from up to 27 blocks away. Failed targets are marked
 * before the attempt and cleared on completion (the dedupe pattern), and
 * marks EXPIRE: world state shifts, and a block that defeated four attempts
 * was harvested on the fifth.
 */
export function pickGatherTarget<T extends Position>(
  candidates: readonly T[],
  origin: Position,
  blacklist: ReadonlyMap<string, number>,
  now: number,
): T | null {
  let best: T | null = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const until = blacklist.get(targetKey(candidate))
    if (until !== undefined && until > now) {
      continue
    }
    const d = distance(candidate, origin)
    if (d < bestDistance) {
      bestDistance = d
      best = candidate
    }
  }
  return best
}

/**
 * Prescriptive prose for "wood exists here, but every block of it has
 * recently defeated you" — saying "no wood within N blocks" would be a lie,
 * and the honest fix is different: stand somewhere new.
 */
export function allTargetsBlacklistedMessage(resource: string): string {
  return `the ${resource} in sight keeps defeating you from this spot — move somewhere new before trying again`
}

/**
 * The in-world line a villager speaks when setting off to harvest — spoken
 * AFTER the fail-fast checks, so an announced dig is always genuinely
 * attempted. Names the block and its coordinates: a watcher who sees it can
 * `/tp` to the speaker and spectate the attempt as it happens.
 */
export function gatherStartAnnouncement(resource: string, blockType: string, target: Position): string {
  const material = blockType.replace(/_/g, ' ')
  return `Heading to gather ${resource} — ${material} at (${Math.round(target.x)}, ${Math.round(target.y)}, ${Math.round(target.z)}).`
}

/**
 * The in-world line a villager speaks after a successful harvest. Spoken
 * chat is world-visible: nearby villagers hear it (ChatObserved → percepts),
 * so a haul becomes social information — and a human watcher can't miss it.
 * Null when nothing was collected: announcing a zero would be a lie the
 * whole village hears.
 */
export function gatherAnnouncement(blockType: string, collected: number): string | null {
  if (collected <= 0) {
    return null
  }
  const material = blockType.replace(/_/g, ' ')
  return `Gathered ${collected} ${material}${collected === 1 ? '' : 's'}!`
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
