import { type Position, distance } from '../world/position.ts'

/**
 * The guard arc's post tether: a guard-stance villager displaced from its
 * anchor (spawn position — the race harness anchors spawnpoints at team
 * posts, so death-respawn re-anchors correctly) walks home when the body is
 * otherwise idle. Piggybacks the threat interval — no timer of its own.
 *
 * Command-lane rules (the whole design): the tether NEVER claims the busy
 * seam and NEVER clears a goal it cannot prove it owns. Any busy claim or
 * open episode sighted mid-walk forfeits ownership WITHOUT clearGoal — the
 * claimant's own pathfinder.setGoal atomically replaces the tether's goal
 * (single-goal semantics), so arbitration is free. Check-then-set is safe:
 * both this pass and the executor's busy claim are synchronous blocks on
 * one event loop.
 */

export interface TetherBot {
  alive: boolean
  position(): Position | null
  /** fire-and-forget GoalNear at the anchor with reflex movements (canDig=false —
   *  a homeward walk must never mine through a house); NEVER awaited */
  setGoalNear(pos: Position, range: number): void
  /** clear the pathfinder goal + restore default movements */
  clearGoal(): void
}

export interface GuardTetherDeps {
  bot(): TetherBot | null
  anchor(): Position | null
  stance(): string
  getBusy(): string | null
  threatOpen(): boolean
  hazardOpen(): boolean
  config: {
    postRadius: number
    repathMs: number
  }
}

/** inside this distance of the anchor the walk is done and the goal cleared */
export const TETHER_ARRIVE_RADIUS = 4

export class GuardTether {
  /** true only while a goal WE set may still be live */
  private goalActive = false
  private lastSetAt = 0

  constructor(private readonly deps: GuardTetherDeps) {}

  check(now: number = Date.now()): void {
    const bot = this.deps.bot()
    if (!bot?.alive || this.deps.stance() !== 'guard') {
      this.goalActive = false
      return
    }
    if (this.deps.getBusy() !== null || this.deps.threatOpen() || this.deps.hazardOpen()) {
      // Someone else owns (or is about to own) the body — forfeit without
      // clearGoal; their setGoal replaces ours.
      this.goalActive = false
      return
    }
    const anchor = this.deps.anchor()
    const position = bot.position()
    if (!anchor || !position) {
      return
    }
    const fromPost = distance(position, anchor)
    if (fromPost <= TETHER_ARRIVE_RADIUS) {
      if (this.goalActive) {
        bot.clearGoal() // ours by the forfeit rule — nothing else claimed since we set it
        this.goalActive = false
      }
      return
    }
    if (fromPost > this.deps.config.postRadius) {
      // Hysteresis band (ARRIVE..postRadius): a bot already walking home
      // keeps its goal; a stalled one re-paths on the throttle.
      if (!this.goalActive || now - this.lastSetAt >= this.deps.config.repathMs) {
        bot.setGoalNear(anchor, 2)
        this.goalActive = true
        this.lastSetAt = now
      }
    }
  }
}
