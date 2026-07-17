import { type Position, distance } from '../world/position.ts'
import { THREAT_ALERT_RADIUS, type TrackedHostile } from './threat.ts'

/**
 * The maneuver half of the defense arc (SV-12b): hand-rolled fight and flee
 * interiors behind the driver seam (the mineflayer-pvp spike was a NO-GO —
 * nested duplicate mineflayer, unsilenceable swings; the hand-roll matched
 * its TTK at ~101%), plus the FLEET-wide fight cap.
 *
 * THE HARD RULE, inherited and strengthened: maneuvers NEVER await a
 * pathfinder promise — goals are set fire-and-forget and progress is
 * verified by polling. The spike measured pursuit event-loop p99 141.8ms at
 * 20 concurrent — the cap is load-bearing, and overflow downgrades to flee,
 * never queues (queues hide wedges).
 */

const POLL_MS = 250
/** full-charge swing spacing, spike-validated on 1.21.6 (~4-5s stone-sword TTK) */
const SWING_INTERVAL_MS = 650
const ATTACK_REACH = 3.5
/** One flee hop. Shorter than the 24-block original: A* cost grows
 *  super-linearly with distance on rough terrain, the loop re-hops anyway,
 *  and 20 concurrent night flees at 24 blocks pinned the event loop
 *  (measured 2026-07-17). */
export const FLEE_DISTANCE = 16
/** a second hostile within this along the flee path deflects the bearing */
const DEFLECT_RADIUS = 16
/** cornered = no net movement across this window while fleeing. Must be
 *  comfortably wider than the pathfinder's think budget (10s tickTimeout-
 *  starved A* can take seconds to START moving) — 3s produced false
 *  cornered verdicts fleet-wide on the first night (live-observed
 *  2026-07-17): the goal got cleared before the path began, and bots
 *  jittered in place instead of fleeing. */
const NO_PROGRESS_WINDOW_MS = 7_000
const NO_PROGRESS_MIN_BLOCKS = 1.5

/** Fleet-wide fight slots — ONE instance per process, shared by every
 *  session's driver. max 0 = flee-only fleet (the staged-rollout lever). */
export class FightSlots {
  private active = 0

  constructor(
    readonly max: number,
    private readonly gauge?: { set(value: number): void },
  ) {}

  tryAcquire(): boolean {
    if (this.active >= this.max) {
      return false
    }
    this.active += 1
    this.gauge?.set(this.active)
    return true
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    this.gauge?.set(this.active)
  }
}

/** Static weapon tier table — best carried wins; fists lose to everything. */
const WEAPON_TIERS = [
  'netherite_sword',
  'diamond_sword',
  'iron_sword',
  'stone_sword',
  'wooden_sword',
  'netherite_axe',
  'diamond_axe',
  'iron_axe',
  'stone_axe',
  'wooden_axe',
] as const

export function pickWeapon(carried: readonly string[]): string | null {
  for (const tier of WEAPON_TIERS) {
    if (carried.includes(tier)) {
      return tier
    }
  }
  return null
}

/**
 * The flee bearing — pure, so the geometry is table-testable. Away from the
 * nearest hostile; deflected ±90° when a second hostile sits along the
 * escape line; biased toward the nearest villager inside a 60° cone
 * (fleeing INTO the village is story — kiting is accepted emergent chaos
 * with the cone as sole mitigation).
 */
export function fleeBearing(
  origin: Position,
  hostiles: readonly TrackedHostile[],
  buddies: readonly Position[],
  buddyRadius: number,
): { x: number; z: number } {
  const nearest = hostiles[0]
  if (!nearest) {
    return { x: 1, z: 0 }
  }
  let dx = origin.x - nearest.position.x
  let dz = origin.z - nearest.position.z
  const norm = Math.hypot(dx, dz) || 1
  dx /= norm
  dz /= norm

  // Second-hostile deflection: if another hostile lies roughly along the
  // escape line and close, rotate the bearing ±90° away from it.
  for (const other of hostiles.slice(1)) {
    const ox = other.position.x - origin.x
    const oz = other.position.z - origin.z
    const dist = Math.hypot(ox, oz)
    if (dist > DEFLECT_RADIUS || dist === 0) {
      continue
    }
    const dot = (ox / dist) * dx + (oz / dist) * dz
    if (dot > 0.5) {
      // it sits within ~60° of the escape line — rotate away from its side
      const cross = (ox / dist) * dz - (oz / dist) * dx
      const sign = cross > 0 ? -1 : 1
      const rx = dx * Math.cos((sign * Math.PI) / 2) - dz * Math.sin((sign * Math.PI) / 2)
      const rz = dx * Math.sin((sign * Math.PI) / 2) + dz * Math.cos((sign * Math.PI) / 2)
      dx = rx
      dz = rz
      break
    }
  }

  // Buddy bias: the nearest villager inside a 60° cone of the (possibly
  // deflected) bearing pulls the path toward company.
  if (buddyRadius > 0) {
    let best: Position | null = null
    let bestDistance = Infinity
    for (const buddy of buddies) {
      const bx = buddy.x - origin.x
      const bz = buddy.z - origin.z
      const dist = Math.hypot(bx, bz)
      if (dist === 0 || dist > buddyRadius) {
        continue
      }
      const dot = (bx / dist) * dx + (bz / dist) * dz
      if (dot >= Math.cos(Math.PI / 6) && dist < bestDistance) {
        best = buddy
        bestDistance = dist
      }
    }
    if (best) {
      const bx = best.x - origin.x
      const bz = best.z - origin.z
      const norm2 = Math.hypot(bx, bz) || 1
      dx = bx / norm2
      dz = bz / norm2
    }
  }
  return { x: dx, z: dz }
}

export function bearingAngleDeg(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z))
  return (Math.acos(dot) * 180) / Math.PI
}

/** The slice of the body the driver drives — structural, tests fake it. */
export interface CombatBot {
  alive: boolean
  food(): number
  position(): Position | null
  /** live entity by id, or null when gone (dead or despawned) */
  hostileById(id: number): TrackedHostile | null
  /** hostiles in alert range, nearest first (the watcher's same view) */
  hostiles(): TrackedHostile[]
  /** other villagers' positions — the buddy-bias input */
  villagers(): Position[]
  equipWeapon(name: string): Promise<void>
  carried(): string[]
  /** fire-and-forget dynamic follow goal — NEVER awaited */
  setGoalFollow(targetId: number, range: number): void
  /** fire-and-forget XZ goal — NEVER awaited */
  setGoalXZ(x: number, z: number): void
  clearGoal(): void
  /** fire-and-forget look */
  lookAt(position: Position): void
  attack(targetId: number): void
  setSprint(state: boolean): void
}

interface DriverLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface FightDriverConfig {
  fightTimeoutMs: number
  fleeTimeoutMs: number
  buddyRadius: number
}

/**
 * One driver per bot session, sharing the process-wide FightSlots. The
 * watcher (threat.ts) owns episodes and the busy seam; the driver owns only
 * the interiors and their deadlines.
 */
export class FightDriver {
  constructor(
    private readonly bot: () => CombatBot | null,
    private readonly slots: FightSlots,
    private readonly log: DriverLog,
    private readonly config: FightDriverConfig,
  ) {}

  /** null = cap full (the watcher downgrades to flee, never queues). */
  tryFight(targetId: number, ctx: { abandoned: boolean }): Promise<'killed' | 'lost' | 'abandoned'> | null {
    if (!this.slots.tryAcquire()) {
      return null
    }
    return this.fight(targetId, ctx).finally(() => this.slots.release())
  }

  private async fight(targetId: number, ctx: { abandoned: boolean }): Promise<'killed' | 'lost' | 'abandoned'> {
    const bot = this.bot()
    if (!bot?.alive) {
      return 'abandoned'
    }
    const weapon = pickWeapon(bot.carried())
    if (weapon) {
      try {
        await bot.equipWeapon(weapon)
      } catch {
        // fists then — the decision table only fights armed, but the pack
        // can change between decision and equip; the timeout bounds it
      }
    }
    bot.setGoalFollow(targetId, 2) // set ONCE, dynamic — re-fetch entity by id each poll
    const deadline = Date.now() + this.config.fightTimeoutMs
    let lastSwing = 0
    let swings = 0
    let lastDistance = Infinity
    try {
      while (Date.now() < deadline) {
        if (ctx.abandoned || !bot.alive) {
          return 'abandoned'
        }
        const target = bot.hostileById(targetId)
        if (!target) {
          // Gone: a kill if we were on top of it swinging, else it de-spawned
          // or wandered out of tracking — honesty via the same presumption
          // the hunt loop uses.
          return lastDistance <= ATTACK_REACH + 1 && swings > 0 ? 'killed' : 'lost'
        }
        lastDistance = target.distance
        const now = Date.now()
        if (target.distance <= ATTACK_REACH && now - lastSwing >= SWING_INTERVAL_MS) {
          bot.lookAt(target.position)
          bot.attack(targetId)
          lastSwing = now
          swings += 1
        }
        await sleep(POLL_MS)
      }
      return 'lost'
    } finally {
      bot.clearGoal()
    }
  }

  async flee(ctx: { abandoned: boolean }): Promise<'escaped' | 'cornered' | 'abandoned'> {
    const bot = this.bot()
    if (!bot?.alive) {
      return 'abandoned'
    }
    const deadline = Date.now() + this.config.fleeTimeoutMs
    let lastBearing: { x: number; z: number } | null = null
    let lastRepath = 0
    let progressAnchor = bot.position()
    let progressAt = Date.now()
    try {
      while (Date.now() < deadline) {
        if (ctx.abandoned || !bot.alive) {
          return 'abandoned'
        }
        const hostiles = bot.hostiles()
        if (hostiles.length === 0 || hostiles[0]!.distance > THREAT_ALERT_RADIUS + 4) {
          return 'escaped'
        }
        const origin = bot.position()
        if (!origin) {
          return 'abandoned'
        }
        // a starving villager flees at a walk — sprint burns food it lacks
        bot.setSprint(bot.food() > 6)
        const bearing = fleeBearing(origin, hostiles, bot.villagers(), this.config.buddyRadius)
        const now = Date.now()
        if (
          lastBearing === null ||
          (now - lastRepath >= 2_000 && bearingAngleDeg(bearing, lastBearing) > 45)
        ) {
          bot.setGoalXZ(origin.x + bearing.x * FLEE_DISTANCE, origin.z + bearing.z * FLEE_DISTANCE)
          lastBearing = bearing
          lastRepath = now
        }
        // No-progress detector: cornered bodies stop moving — a bounded
        // flail (fire-and-forget swings at whatever is in reach) is more
        // honest than pretending the flee is working.
        if (progressAnchor && now - progressAt >= NO_PROGRESS_WINDOW_MS) {
          if (distance(progressAnchor, origin) < NO_PROGRESS_MIN_BLOCKS) {
            const inReach = hostiles.find((h) => h.distance <= ATTACK_REACH)
            if (inReach) {
              bot.lookAt(inReach.position)
              bot.attack(inReach.id)
            }
            return 'cornered'
          }
          progressAnchor = origin
          progressAt = now
        }
        await sleep(POLL_MS)
      }
      // Deadline with hostiles still near: alive and moving, but not clear —
      // the episode stays open and the next maneuver re-evaluates.
      return 'cornered'
    } finally {
      bot.setSprint(false)
      bot.clearGoal()
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
