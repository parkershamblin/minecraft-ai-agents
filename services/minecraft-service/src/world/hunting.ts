import { type Position, round1 } from './position.ts'

/**
 * The hunt verb's pure logic (SV-8): family maps, target selection with the
 * per-entity blacklist, the kill loop against a structural HuntBot, and
 * prescriptive failure prose. One animal per action (the single-block gather
 * precedent) — a wounded escapee keeps its damage and the next hunt finishes
 * it. Ecology brakes are diegetic only: adults-only targeting, one kill per
 * action, scarcity prose that recruits relocation.
 */

export const HUNT_FAMILIES: Record<string, readonly string[]> = {
  cow: ['cow'],
  pig: ['pig'],
  sheep: ['sheep'],
  chicken: ['chicken'],
  any: ['cow', 'pig', 'sheep', 'chicken'],
} as const

/** What a kill is expected to drop — the yield counted for honesty. Wool
 *  colors are matched by suffix in isHuntYield. */
export const HUNT_YIELD: Record<string, readonly string[]> = {
  cow: ['beef', 'leather'],
  pig: ['porkchop'],
  sheep: ['mutton'],
  chicken: ['chicken', 'feather'],
} as const

export function isHuntYield(family: string, itemName: string): boolean {
  if (family === 'sheep' && itemName.endsWith('_wool')) {
    return true
  }
  return (HUNT_YIELD[family] ?? []).includes(itemName)
}

/** The meat the affordance economics talk about. */
export const PRIMARY_MEAT: Record<string, string> = {
  cow: 'beef',
  pig: 'porkchop',
  sheep: 'mutton',
  chicken: 'chicken',
} as const

/** How long an escaped/failed target stays off the menu. */
export const HUNT_BLACKLIST_MS = 5 * 60_000

export interface HuntableEntity {
  id: number
  name: string
  position: Position
  distance: number
  /** the ageable metadata flag (index 16 on 1.21.6) — heights never rescale,
   *  so metadata is the ONLY working baby exclusion (spike-pinned) */
  baby: boolean
}

/** Group live animals into the snapshot's nearbyAnimals shape (adults only —
 *  what "in sight" advertises must be what hunt will actually take). */
export function groupAnimalSightings(
  animals: readonly HuntableEntity[],
  maxDistance: number,
): Array<{ family: string; nearestDistance: number; count: number }> {
  const byFamily = new Map<string, { nearestDistance: number; count: number }>()
  for (const animal of animals) {
    if (animal.baby || animal.distance > maxDistance) {
      continue
    }
    const entry = byFamily.get(animal.name)
    if (entry) {
      entry.count += 1
      entry.nearestDistance = Math.min(entry.nearestDistance, animal.distance)
    } else {
      byFamily.set(animal.name, { nearestDistance: animal.distance, count: 1 })
    }
  }
  return [...byFamily.entries()].map(([family, v]) => ({
    family,
    nearestDistance: round1(v.nearestDistance),
    count: v.count,
  }))
}

/** Nearest huntable adult of the family, skipping recent escapees. */
export function pickHuntTarget(
  candidates: readonly HuntableEntity[],
  family: string,
  maxDistance: number,
  blacklist: ReadonlyMap<number, number>,
  now: number,
): HuntableEntity | null {
  const names = HUNT_FAMILIES[family]
  if (!names) {
    return null
  }
  let best: HuntableEntity | null = null
  for (const entity of candidates) {
    if (!names.includes(entity.name) || entity.baby || entity.distance > maxDistance) {
      continue
    }
    const until = blacklist.get(entity.id)
    if (until !== undefined && until > now) {
      continue
    }
    if (!best || entity.distance < best.distance) {
      best = entity
    }
  }
  return best
}

/**
 * Prescriptive RESOURCE_NOT_FOUND prose for an empty range — the message is
 * the next tick's percept and must carry the fix (the herds are elsewhere;
 * walking is the retry that lands differently).
 */
export function huntNotFoundMessage(family: string, maxDistance: number): string {
  const what = family === 'any' ? 'game of any kind' : `${family}s`
  return (
    `no ${what} within ${maxDistance} blocks — the herds keep to open grass; ` +
    `move toward grassland or water and hunt again from there`
  )
}

export function allHuntTargetsBlacklistedMessage(family: string): string {
  const what = family === 'any' ? 'game' : `${family}s`
  return `the ${what} nearby keep escaping you — move somewhere new before hunting again`
}

export function targetEscapedMessage(family: string, chaseSeconds: number): string {
  return (
    `the ${family} outran your chase after ${chaseSeconds}s — wounded game keeps its wounds, ` +
    `so hunting it again may finish the job; a sword in hand also ends chases faster`
  )
}

/** Spoken on commitment (post fail-fast — an announced hunt is always
 *  genuinely attempted). */
export function huntStartAnnouncement(target: HuntableEntity): string {
  return `Off hunting — a ${target.name.replace(/_/g, ' ')}, ${Math.round(target.distance)} blocks out.`
}

/** Spoken only when something actually reached the pack — never announce a
 *  lie the whole village hears. */
export function huntSuccessAnnouncement(family: string, byType: Record<string, number>): string | null {
  const parts = Object.entries(byType)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name.replace(/_/g, ' ')}`)
  if (parts.length === 0) {
    return null
  }
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `Hunted a ${family.replace(/_/g, ' ')} — ${listed} in the pack!`
}

export interface HuntResult {
  animal: string
  /** the concrete entity name that was chased */
  target: string
  killed: boolean
  /** total items that reached the pack */
  collected: number
  drops: Record<string, number>
  position: Position
  chaseSeconds: number
  /** teaching prose the prompt renders verbatim */
  note: string
}

/** The slice of the body the kill loop drives — structural, tests fake it. */
export interface HuntBot {
  alive: boolean
  position(): Position | null
  /** the live target by id, or null when gone (dead, despawned, untracked) */
  targetById(id: number): { position: Position; distance: number } | null
  /** fire-and-forget dynamic follow — NEVER awaited */
  setGoalFollow(targetId: number, range: number): void
  clearGoal(): void
  lookAt(position: Position): void
  attack(targetId: number): void
  /** walk to a position and settle (used for the drop chase; raced upstream
   *  by the command watchdog) */
  goTo(position: Position): Promise<void>
  /** current spawn generation — a mid-hunt death must not book the respawned
   *  body's state as a kill */
  generation(): number
}

export interface KillLoopOptions {
  chaseTimeoutMs: number
  /** chase leash: give up beyond maxDistance + 16 from the START position */
  leashBlocks: number
  ctx: { abandoned: boolean }
  sleep?: (ms: number) => Promise<void>
}

const POLL_MS = 250
const SWING_INTERVAL_MS = 650
const ATTACK_REACH = 3.5
/** presumed kill: entity gone while we were this close with ≥1 swing in */
const KILL_PRESUMPTION_RANGE = 12

export type KillLoopOutcome =
  | { kind: 'killed'; lastPosition: Position; chaseSeconds: number }
  | { kind: 'escaped'; chaseSeconds: number }
  | { kind: 'abandoned' }

/**
 * Chase and kill one target: dynamic follow set once, 250ms poll re-fetching
 * the entity by id, fire-and-forget look + attack at full-charge spacing,
 * leash + chase deadline. Kill detection is a presumption (entity gone at
 * close range with swings in) kept honest by the caller's inventory delta.
 */
export async function runKillLoop(bot: HuntBot, targetId: number, opts: KillLoopOptions): Promise<KillLoopOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = Date.now()
  const generation = bot.generation()
  const startPosition = bot.position()
  if (!startPosition) {
    return { kind: 'abandoned' }
  }
  bot.setGoalFollow(targetId, 2)
  let lastSwing = 0
  let swings = 0
  let lastDistance = Infinity
  let lastPosition: Position | null = null
  try {
    while (Date.now() - started < opts.chaseTimeoutMs) {
      if (opts.ctx.abandoned || !bot.alive || bot.generation() !== generation) {
        return { kind: 'abandoned' }
      }
      const target = bot.targetById(targetId)
      const chaseSeconds = Math.round((Date.now() - started) / 1_000)
      if (!target) {
        if (lastDistance <= KILL_PRESUMPTION_RANGE && swings > 0 && lastPosition) {
          return { kind: 'killed', lastPosition, chaseSeconds }
        }
        return { kind: 'escaped', chaseSeconds }
      }
      lastDistance = target.distance
      lastPosition = target.position
      const origin = bot.position()
      if (origin && distanceXZ(origin, startPosition) > opts.leashBlocks) {
        return { kind: 'escaped', chaseSeconds } // the leash — a chase budget, not a sight limit
      }
      const now = Date.now()
      if (target.distance <= ATTACK_REACH && now - lastSwing >= SWING_INTERVAL_MS) {
        bot.lookAt(target.position)
        bot.attack(targetId)
        lastSwing = now
        swings += 1
      }
      await sleep(POLL_MS)
    }
    return { kind: 'escaped', chaseSeconds: Math.round(opts.chaseTimeoutMs / 1_000) }
  } finally {
    bot.clearGoal()
  }
}

function distanceXZ(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}
