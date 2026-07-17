import { type Position, roundPos } from '../world/position.ts'

/**
 * The powder-snow reflex (post-M2). mineflayer-pathfinder scores powder snow
 * as walkable air (its safety check is `boundingBox === 'empty' &&
 * !blocksToAvoid`, and powder snow reads 'empty'), so paths on the frozen
 * peaks stroll bots straight into patches; the body sinks, freeze damage
 * ticks, and no path ever leads back out. Prevention: hardenMovements teaches
 * the planner to avoid the block. Cure: HazardWatcher — a per-bot O(1) watch
 * that opens a trap episode, digs the body out WITHOUT the pathfinder (its
 * A* budget is deliberately starved fleet-wide), and narrates every phase
 * transition as a HazardEncountered world fact.
 */

/** Cross-cutting body ownership: the executor claims 'action' for a command's
 *  lifetime; reflexes claim their own literal for an attempt's. Never two at
 *  once. Priority ladder (survival cluster): escape > combat > eat >
 *  action-commands — enforced by each claimant checking the seam (and the
 *  open-episode getters) before claiming, never by preemption. */
export type BusyState = 'action' | 'escape' | 'combat' | 'eat' | null

export type HazardPhase = 'trapped' | 'escaped' | 'escape_failed'

/** The slice of prismarine-block the reflex reads — structural, so tests fake it. */
export interface HazardBlock {
  name: string
  boundingBox: string
  position: Position
}

/** The slice of a mineflayer Bot the reflex drives — structural, so tests fake it. */
export interface HazardBot {
  entity: { position: Position } | undefined
  blockAt(position: Position): HazardBlock | null
  dig(block: HazardBlock): Promise<void>
  look(yaw: number, pitch: number, force?: boolean): Promise<void>
  setControlState(control: 'forward', state: boolean): void
}

/** The slices of pathfinder Movements and the block registry avoidance touches. */
export interface AvoidanceMovements {
  blocksToAvoid: Set<number>
}

export interface BlockRegistry {
  blocksByName: Record<string, { id: number } | undefined>
}

/**
 * Teach a Movements instance that powder snow is cobweb-grade terrain.
 * Tolerates the block missing from the registry (older MC versions) —
 * prevention just stays off and the watch below carries the whole load.
 */
export function hardenMovements(movements: AvoidanceMovements, registry: BlockRegistry): void {
  const powderSnow = registry.blocksByName.powder_snow
  if (powderSnow) {
    movements.blocksToAvoid.add(powderSnow.id)
  }
}

/** The HazardEncountered payload, shaped exactly like the committed contract. */
export function hazardPayload(
  villagerId: string,
  phase: HazardPhase,
  position: Position,
  detail: string | null,
): Record<string, unknown> {
  return { villagerId, hazardType: 'powder_snow', phase, position, detail }
}

export interface HazardConfig {
  /** backoff between escape attempts while an episode stays open */
  escapeRetryMs: number
  /** powder snow blocks one attempt may dig before giving up */
  digBudget: number
  /** the whole attempt races this deadline — never trust a mineflayer promise to settle */
  escapeTimeoutMs: number
}

interface HazardLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface HazardWatcherDeps {
  /** the live body, or null when disconnected — re-read every pass (reconnects swap bots) */
  bot(): HazardBot | null
  emit(phase: HazardPhase, position: Position, detail: string | null): void
  /** cancel any residual pathfinder goal before the reflex takes the controls */
  stopMoving(): void
  getBusy(): BusyState
  setBusy(state: 'escape' | null): void
  log: HazardLog
  config: HazardConfig
}

/** consecutive positive passes before an episode opens — one pass can be a clipped corner */
const HITS_TO_OPEN = 2
/** raw-control walk verification: poll cadence and per-cell budget */
const WALK_POLL_MS = 100
const WALK_TIMEOUT_MS = 3_000
const CARDINALS = [
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
] as const

interface Episode {
  openedAt: number
  /** blocks dug across ALL attempts — the escaped detail reads this */
  digs: number
  attempts: number
  lastAttemptEndedAt: number | null
  /** where the trap opened — the emit fallback if the body vanishes mid-escape */
  position: Position
}

type AttemptResult = { ok: true } | { ok: false; reason: string }

/**
 * Per-bot trap detection and the bounded escape maneuver. check() is the only
 * entry — wired to a setInterval sibling of the snapshot/resource-scan loops.
 * Each pass is two or three blockAt reads, NEVER a world sweep (20 bots share
 * one event loop; sweeps are this repo's recorded scar tissue), and the pass
 * catches everything: no throw or rejection ever escapes the interval.
 */
export class HazardWatcher {
  private pendingHits = 0
  private episode: Episode | null = null
  private attemptInFlight = false

  constructor(private readonly deps: HazardWatcherDeps) {}

  /** An open trap episode — lower-priority reflexes (combat, eat) gate on
   *  this so they never claim the body between escape attempts (the
   *  retry-backoff window would otherwise be a hole in the ladder). */
  get trapped(): boolean {
    return this.episode !== null
  }

  check(): void {
    try {
      if (this.attemptInFlight) {
        return // single-flight: an escape attempt owns the body right now
      }
      const bot = this.deps.bot()
      if (!bot?.entity) {
        this.pendingHits = 0 // mid-respawn — nothing truthful to read
        return
      }
      const feet = flooredPosition(bot.entity.position)
      const inSnow = this.inPowderSnow(bot, feet)
      if (!this.episode) {
        if (!inSnow) {
          this.pendingHits = 0
          return
        }
        this.pendingHits += 1
        if (this.pendingHits < HITS_TO_OPEN) {
          return
        }
        this.openEpisode(bot)
        this.maybeAttempt(bot)
        return
      }
      if (!inSnow && this.hasSolidFloor(bot, feet)) {
        this.closeEscaped(bot) // free — whether by our digging or the world's mercy
        return
      }
      this.maybeAttempt(bot)
    } catch (err) {
      // Never let a hiccup (mid-chunk-unload race) kill the watch.
      this.deps.log.warn({ err: (err as Error).message }, 'hazard watch pass failed')
    }
  }

  /** Trapped = feet OR head submerged: without leather boots a body standing
   *  on powder snow sinks INTO it, so the feet block catches the walk-on case. */
  private inPowderSnow(bot: HazardBot, feet: Position): boolean {
    return isPowderSnow(bot.blockAt(feet)) || isPowderSnow(bot.blockAt(above(feet)))
  }

  private hasSolidFloor(bot: HazardBot, feet: Position): boolean {
    return isSolidFloor(bot.blockAt(below(feet)))
  }

  private position(bot: HazardBot | null): Position | null {
    const p = bot?.entity?.position
    return p ? roundPos(p) : null
  }

  private openEpisode(bot: HazardBot): void {
    const position = this.position(bot) as Position // caller verified the entity
    this.pendingHits = 0
    this.episode = { openedAt: Date.now(), digs: 0, attempts: 0, lastAttemptEndedAt: null, position }
    this.deps.emit('trapped', position, 'sunk into powder snow')
  }

  private closeEscaped(bot: HazardBot | null): void {
    const episode = this.episode
    if (!episode) {
      return
    }
    this.episode = null
    const seconds = Math.round((Date.now() - episode.openedAt) / 1_000)
    const detail =
      episode.digs > 0
        ? `dug ${episode.digs} powder snow block${episode.digs === 1 ? '' : 's'} to get free after ~${seconds}s trapped`
        : `came free without digging after ~${seconds}s trapped`
    this.deps.log.info({ digs: episode.digs, attempts: episode.attempts, seconds }, 'powder snow escape succeeded')
    this.deps.emit('escaped', this.position(bot) ?? episode.position, detail)
  }

  private maybeAttempt(bot: HazardBot): void {
    if (this.deps.getBusy() !== null) {
      return // an action owns the body — its watchdog guarantees a window soon
    }
    const episode = this.episode
    if (!episode) {
      return
    }
    if (
      episode.lastAttemptEndedAt !== null &&
      Date.now() - episode.lastAttemptEndedAt < this.deps.config.escapeRetryMs
    ) {
      return // backoff between attempts
    }
    this.attemptInFlight = true
    this.deps.setBusy('escape')
    void this.runAttempt(bot, episode)
  }

  /** Owns the attempt lifecycle: race against the deadline, emit the outcome,
   *  and ALWAYS release controls + the busy claim. Never rejects. */
  private async runAttempt(bot: HazardBot, episode: Episode): Promise<void> {
    episode.attempts += 1
    const { escapeTimeoutMs } = this.deps.config
    // Shared with the maneuver so a timed-out (abandoned) attempt stops
    // touching the body the moment the race settles.
    const ctx = { abandoned: false }
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ctx.abandoned = true
        resolve('timeout')
      }, escapeTimeoutMs)
    })
    this.deps.log.info({ attempt: episode.attempts, digsSoFar: episode.digs }, 'powder snow escape attempt starting')
    try {
      this.deps.stopMoving()
      // THE HARD RULE (CLAUDE.md corollary 3): race, never await a mineflayer
      // promise directly — a dig on a dead connection never settles, and one
      // wedged promise here would freeze this bot's reflex forever.
      const result = await Promise.race([this.escapeManeuver(bot, episode, ctx), timedOut])
      if (result === 'timeout') {
        this.failAttempt(bot, episode, `escape attempt timed out after ${escapeTimeoutMs}ms`)
      } else if (result.ok) {
        this.closeEscaped(bot)
      } else {
        this.failAttempt(bot, episode, result.reason)
      }
    } catch (err) {
      this.failAttempt(bot, episode, `escape attempt crashed: ${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
      try {
        bot.setControlState('forward', false)
      } catch {
        // a dead connection can reject control writes — the attempt is over either way
      }
      if (this.episode) {
        this.episode.lastAttemptEndedAt = Date.now()
      }
      this.deps.setBusy(null)
      this.attemptInFlight = false
    }
  }

  /** escape_failed leaves the episode open — maybeAttempt retries after backoff. */
  private failAttempt(bot: HazardBot, episode: Episode, reason: string): void {
    this.deps.log.warn({ attempt: episode.attempts, reason }, 'powder snow escape attempt failed')
    this.deps.emit('escape_failed', this.position(bot) ?? episode.position, reason)
  }

  /**
   * The maneuver: dig own head/feet first (a cleared head stops the freeze
   * clock — powder snow is instantly hand-diggable), then tunnel toward the
   * cheapest cardinal neighbor with a solid floor, walking by raw control
   * states. Budget-bounded; sinking a level mid-walk is fine, the loop
   * re-floors itself from the live position every iteration.
   */
  private async escapeManeuver(
    bot: HazardBot,
    episode: Episode,
    ctx: { abandoned: boolean },
  ): Promise<AttemptResult> {
    const { digBudget } = this.deps.config
    let digs = 0
    /** dig one cell if it holds powder snow; non-null return = attempt over */
    const digOut = async (cell: Position): Promise<AttemptResult | null> => {
      const block = bot.blockAt(cell)
      if (!isPowderSnow(block)) {
        return null
      }
      if (digs >= digBudget) {
        return { ok: false, reason: `dig budget of ${digBudget} spent without reaching solid ground` }
      }
      await bot.dig(block)
      digs += 1
      episode.digs += 1
      return ctx.abandoned ? { ok: false, reason: 'abandoned mid-dig' } : null
    }
    // Every iteration digs at least one block or walks into an already-open
    // cell (which the next iteration's clear-check terminates), so the step
    // bound is a belt over the budget's suspenders.
    for (let step = 0; step < digBudget + 4; step += 1) {
      if (ctx.abandoned || !bot.entity) {
        return { ok: false, reason: 'the body vanished mid-escape (disconnect or respawn)' }
      }
      const feet = flooredPosition(bot.entity.position)
      for (const cell of [above(feet), feet]) {
        const over = await digOut(cell)
        if (over) {
          return over
        }
      }
      if (!this.inPowderSnow(bot, feet) && this.hasSolidFloor(bot, feet)) {
        return { ok: true }
      }
      const exit = pickExit(bot, feet)
      if (!exit) {
        return { ok: false, reason: 'no diggable exit among the four neighbor cells' }
      }
      for (const cell of exit.digCells) {
        const over = await digOut(cell)
        if (over) {
          return over
        }
      }
      const moved = await this.walkInto(bot, feet, exit.feet, ctx)
      if (ctx.abandoned) {
        return { ok: false, reason: 'abandoned mid-walk' }
      }
      if (!moved) {
        return { ok: false, reason: `walked toward (${exit.feet.x}, ${exit.feet.z}) but never left the trapped cell` }
      }
    }
    return { ok: false, reason: 'escape loop overran its step bound' }
  }

  /** Raw-control walk into an adjacent cell: face it, hold forward, verify the
   *  column changed. No pathfinder — see the module doc. */
  private async walkInto(
    bot: HazardBot,
    from: Position,
    to: Position,
    ctx: { abandoned: boolean },
  ): Promise<boolean> {
    const start = bot.entity
    if (!start) {
      return false
    }
    const dx = to.x + 0.5 - start.position.x
    const dz = to.z + 0.5 - start.position.z
    await bot.look(Math.atan2(-dx, -dz), 0, true)
    if (ctx.abandoned) {
      return false
    }
    bot.setControlState('forward', true)
    try {
      const deadline = Date.now() + WALK_TIMEOUT_MS
      while (Date.now() < deadline) {
        await sleep(WALK_POLL_MS)
        if (ctx.abandoned || !bot.entity) {
          return false
        }
        const cell = flooredPosition(bot.entity.position)
        if (cell.x !== from.x || cell.z !== from.z) {
          return true // left the trapped column — powder snow permits slow movement
        }
      }
      return false
    } finally {
      bot.setControlState('forward', false)
    }
  }
}

interface ExitCandidate {
  feet: Position
  /** the powder snow cells to clear before walking in (0..2, fewest preferred) */
  digCells: Position[]
}

/** Cheapest cardinal cell a body can occupy: feet/head each passable or
 *  diggable snow, floor solid and NOT powder snow (or the walk just re-traps). */
function pickExit(bot: HazardBot, feet: Position): ExitCandidate | null {
  let best: ExitCandidate | null = null
  for (const dir of CARDINALS) {
    const nFeet = { x: feet.x + dir.x, y: feet.y, z: feet.z + dir.z }
    if (!isSolidFloor(bot.blockAt(below(nFeet)))) {
      continue
    }
    const digCells: Position[] = []
    let viable = true
    for (const cell of [above(nFeet), nFeet]) {
      const block = bot.blockAt(cell)
      if (isPowderSnow(block)) {
        digCells.push(cell) // head first — the same order we dig
      } else if (!isPassable(block)) {
        viable = false
        break
      }
    }
    if (viable && (!best || digCells.length < best.digCells.length)) {
      best = { feet: nFeet, digCells }
    }
  }
  return best
}

function flooredPosition(p: Position): Position {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

function above(p: Position): Position {
  return { x: p.x, y: p.y + 1, z: p.z }
}

function below(p: Position): Position {
  return { x: p.x, y: p.y - 1, z: p.z }
}

function isPowderSnow(block: HazardBlock | null): block is HazardBlock {
  return block !== null && block.name === 'powder_snow'
}

/** null = unloaded chunk: safe to stand in, never safe to walk toward */
function isPassable(block: HazardBlock | null): boolean {
  return block !== null && block.boundingBox === 'empty'
}

function isSolidFloor(block: HazardBlock | null): boolean {
  return block !== null && block.boundingBox === 'block' && block.name !== 'powder_snow'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
