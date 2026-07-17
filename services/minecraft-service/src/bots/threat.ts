import { type Position, distance, round1, roundPos } from '../world/position.ts'
import type { BusyState } from './hazard.ts'

/**
 * The threat watcher (SV-12a): hostile detection, the episode state machine,
 * ThreatEncountered emission, and the pure fight-or-flee decision table. The
 * maneuvers themselves (fight/flee interiors, the fleet fight cap) live in
 * combat.ts — two modules so the two concerns never share a file.
 *
 * Detection is ONE filter over the client's entity map per pass — never a
 * world sweep. Emission is edge-triggered on episode STATE (spotted once,
 * engaged only on response flip, overwhelmed rate-limited), so the worst
 * siege night emits a bounded handful of percepts.
 */

export type ThreatPhase = 'spotted' | 'engaged' | 'killed' | 'escaped' | 'overwhelmed'
export type ThreatResponse = 'fight' | 'flee'
export type Stance = 'brave' | 'cautious'

/** Explicit classification — "unknown" means genuinely unmapped, and unknown
 *  hostiles flee (the safe default for mobs this table has never met). */
export const FLEE_ONLY: ReadonlySet<string> = new Set(['creeper'])
export const RANGED: ReadonlySet<string> = new Set(['skeleton', 'stray', 'bogged'])
export const MELEE: ReadonlySet<string> = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'spider'])
export const IGNORED: ReadonlySet<string> = new Set(['enderman'])

export const THREAT_ALERT_RADIUS = 24
const DANGER_RADIUS_DEFAULT = 10
/** a creeper's fuse is ~1.5s and a skeleton shoots from range — both get
 *  wider instant-open bubbles */
const DANGER_RADIUS_OVERRIDES: Record<string, number> = { creeper: 12, skeleton: 16 }
/** episode close: this far past alert plus 3 clear passes (hysteresis) */
const CLOSE_HYSTERESIS = 4
const CLEAR_PASSES_TO_CLOSE = 3
const HITS_TO_OPEN = 2
const OVERWHELMED_MIN_INTERVAL_MS = 60_000

export function dangerRadius(name: string): number {
  return DANGER_RADIUS_OVERRIDES[name] ?? DANGER_RADIUS_DEFAULT
}

export interface TrackedHostile {
  id: number
  name: string
  distance: number
  position: Position
}

export interface ThreatDecisionInput {
  nearest: TrackedHostile
  count: number
  health: number
  armed: boolean
  stance: Stance
  /** failed fight attempts against this specific target (the gather-blacklist mirror) */
  failedFights: number
}

/**
 * The fight-or-flee table — pure, priority-ordered, table-tested. Flee is
 * every default: a villager who runs lives to reconsider.
 */
export function decideResponse(input: ThreatDecisionInput): ThreatResponse {
  const { nearest } = input
  if (FLEE_ONLY.has(nearest.name)) {
    return 'flee' // a creeper cannot be fought profitably, at any range
  }
  if (input.health <= 10) {
    return 'flee'
  }
  if (!input.armed) {
    return 'flee'
  }
  if (input.count > 2) {
    return 'flee'
  }
  if (input.failedFights >= 2) {
    return 'flee'
  }
  if (RANGED.has(nearest.name)) {
    // Closing on a bow under fire is how villagers die — fight only when
    // already on top of it.
    return nearest.distance <= 4 ? 'fight' : 'flee'
  }
  if (MELEE.has(nearest.name)) {
    return input.stance === 'brave' ? 'fight' : 'flee'
  }
  return 'flee' // unknown hostile — never met, never trusted
}

/** Canned cries, ≤1 per phase transition: world-visible chat becomes the
 *  neighbors' ChatObserved percepts — village drama through plumbing that
 *  already exists. */
export function threatCry(phase: ThreatPhase, threatType: string, response: ThreatResponse | null): string | null {
  const name = threatType.replace(/_/g, ' ')
  switch (phase) {
    case 'engaged':
      return response === 'fight' ? `Stand back — I'll deal with this ${name}!` : `A ${name}! RUN!`
    case 'killed':
      return `The ${name} is dead. It's safe now.`
    case 'escaped':
      return `Lost the ${name} — I'm clear.`
    case 'overwhelmed':
      return `HELP! The ${name} is too much for me!`
    default:
      return null // spotted stays quiet — the engage cry carries the drama
  }
}

/** The slice of the world the watcher reads — structural, tests fake it. */
export interface ThreatBot {
  alive: boolean
  health(): number
  position(): Position | null
  /** hostiles the client tracks within the vertical threat band */
  hostiles(): TrackedHostile[]
  /** every tracked hostile, band ignored — the damage-promotion fallback
   *  (a cliff sniper the band hides must still be nameable when it hits) */
  allHostiles(): TrackedHostile[]
  /** carries any sword or axe */
  armed(): boolean
}

/** The maneuver half (combat.ts) as the watcher sees it. */
export interface ManeuverDriver {
  /** false = the fleet fight cap is full — downgrade to flee, never queue */
  tryFight(targetId: number, ctx: { abandoned: boolean }): Promise<'killed' | 'lost' | 'abandoned'> | null
  flee(ctx: { abandoned: boolean }): Promise<'escaped' | 'cornered' | 'abandoned'>
}

interface ThreatLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface ThreatWatcherDeps {
  bot(): ThreatBot | null
  getBusy(): BusyState
  setBusy(state: 'combat' | null): void
  /** an open trap episode outranks combat (priority: escape > combat) */
  hazardOpen(): boolean
  emit(
    phase: ThreatPhase,
    threatType: string,
    response: ThreatResponse | null,
    count: number,
    dist: number,
    position: Position,
    detail: string | null,
  ): void
  driver: ManeuverDriver
  stance(): Stance
  cry(line: string): void
  recordEpisode(outcome: 'killed' | 'escaped' | 'aborted'): void
  recordResponse(response: ThreatResponse, outcome: string): void
  generation(): number
  log: ThreatLog
  config: {
    alertRadius: number
    /** backoff between maneuvers within one episode (the hazard
     *  escapeRetryMs pattern). The FIRST maneuver runs immediately; a flee
     *  that ended cornered waits this long before the next attempt — at
     *  night the whole fleet flees perpetually, and back-to-back 12s flee
     *  cycles × 20 bots pinned the event loop (measured 2026-07-17,
     *  99.9% CPU on the first night). */
    maneuverCooldownMs: number
  }
}

interface Episode {
  openedAt: number
  generation: number
  threatType: string
  response: ThreatResponse | null
  clearPasses: number
  lastOverwhelmedAt: number
  /** 0 until the first maneuver ends — feeds the maneuver cooldown */
  lastManeuverEndedAt: number
  /** per-target failed fights — feeds the decision table's blacklist row */
  failedFights: Map<number, number>
  /** set by a victorious fight; the close emits killed instead of escaped */
  lastKill: boolean
}

/**
 * Per-bot episode machine. check() is the only entry — a 1s sibling interval.
 * Opens on 2 consecutive alert-range passes, INSTANTLY inside a danger
 * radius; closes after 3 clear passes beyond alert+4. The maneuver runs
 * fire-and-forget with its own deadline inside combat.ts; the watcher only
 * claims/releases the busy seam around it.
 */
export class ThreatWatcher {
  private pendingHits = 0
  private episode: Episode | null = null
  private maneuverInFlight = false
  private lastHealth: number | null = null
  /** last pass's view, cached for the snapshot's nearbyHostiles — zero extra scanning */
  private lastSeen: Array<{ type: string; count: number; nearestDistance: number }> = []

  constructor(private readonly deps: ThreatWatcherDeps) {}

  /** consumed by eat.ts's gate and BotSession's snapshot pass */
  get episodeOpen(): boolean {
    return this.episode !== null
  }

  nearbyHostiles(): Array<{ type: string; count: number; nearestDistance: number }> {
    return this.lastSeen
  }

  check(): void {
    try {
      const bot = this.deps.bot()
      if (!bot?.alive) {
        this.pendingHits = 0
        this.lastSeen = []
        this.lastHealth = null
        return
      }
      if (this.episode && this.deps.generation() !== this.episode.generation) {
        // Death mid-episode: the respawned body is elsewhere and unhurt — a
        // lying "escaped" would poison the ledger. Drop silently.
        this.episode = null
        this.maneuverInFlight = false
        this.lastHealth = null
      }
      const health = bot.health()
      // ignore regen upticks and float noise — only a real hit promotes
      const tookDamage = this.lastHealth !== null && health < this.lastHealth - 0.4
      this.lastHealth = health
      const inAlert = bot
        .hostiles()
        .filter((h) => h.distance <= this.deps.config.alertRadius + (this.episode ? CLOSE_HYSTERESIS : 0))
        .sort((a, b) => a.distance - b.distance)
      this.cacheSeen(inAlert)

      if (!this.episode) {
        if (tookDamage) {
          // Damage promotion: something the band/classification hid landed a
          // hit — open immediately against the best-named suspect. The one
          // damage-triggered path in the design (covers aggroed endermen,
          // cliff snipers, anything unmapped).
          const suspect = inAlert[0] ?? bot.allHostiles()[0]
          if (suspect) {
            this.openEpisode(bot, suspect, Math.max(1, inAlert.length))
            return
          }
        }
        if (inAlert.length === 0) {
          this.pendingHits = 0
          return
        }
        const nearest = inAlert[0]!
        const instant = inAlert.some((h) => h.distance <= dangerRadius(h.name))
        this.pendingHits += 1
        if (!instant && this.pendingHits < HITS_TO_OPEN) {
          return
        }
        this.openEpisode(bot, nearest, inAlert.length)
        return // the maneuver starts next pass — spotted is the mind's preemption window
      }

      if (inAlert.length === 0) {
        this.episode.clearPasses += 1
        if (this.episode.clearPasses >= CLEAR_PASSES_TO_CLOSE) {
          this.closeEpisode(bot)
        }
        return
      }
      this.episode.clearPasses = 0
      this.maybeManeuver(bot, inAlert)
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'threat watch pass failed')
    }
  }

  private cacheSeen(inAlert: readonly TrackedHostile[]): void {
    const byType = new Map<string, { count: number; nearestDistance: number }>()
    for (const h of inAlert) {
      const entry = byType.get(h.name)
      if (entry) {
        entry.count += 1
        entry.nearestDistance = Math.min(entry.nearestDistance, h.distance)
      } else {
        byType.set(h.name, { count: 1, nearestDistance: h.distance })
      }
    }
    this.lastSeen = [...byType.entries()].map(([type, v]) => ({
      type,
      count: v.count,
      nearestDistance: round1(v.nearestDistance),
    }))
  }

  private openEpisode(bot: ThreatBot, nearest: TrackedHostile, count: number): void {
    this.pendingHits = 0
    this.episode = {
      openedAt: Date.now(),
      generation: this.deps.generation(),
      threatType: nearest.name,
      response: null,
      clearPasses: 0,
      lastOverwhelmedAt: 0,
      lastManeuverEndedAt: 0,
      failedFights: new Map(),
      lastKill: false,
    }
    const position = this.position(bot)
    this.deps.log.info({ threatType: nearest.name, distance: round1(nearest.distance), count }, 'threat spotted')
    this.deps.emit(
      'spotted',
      nearest.name,
      null,
      count,
      round1(nearest.distance),
      position,
      `a ${nearest.name} ${Math.round(nearest.distance)} blocks off`,
    )
  }

  private closeEpisode(bot: ThreatBot): void {
    const episode = this.episode
    if (!episode) {
      return
    }
    this.episode = null
    const phase: ThreatPhase = episode.lastKill ? 'killed' : 'escaped'
    const seconds = Math.round((Date.now() - episode.openedAt) / 1_000)
    const detail = episode.lastKill
      ? `the ${episode.threatType} is dead after ~${seconds}s`
      : `broke contact after ~${seconds}s (response: ${episode.response ?? 'none needed'})`
    this.deps.recordEpisode(episode.lastKill ? 'killed' : 'escaped')
    this.deps.emit(phase, episode.threatType, episode.response, 1, this.deps.config.alertRadius, this.position(bot), detail)
    const cry = threatCry(phase, episode.threatType, episode.response)
    if (cry) {
      this.deps.cry(cry)
    }
  }

  private maybeManeuver(bot: ThreatBot, inAlert: readonly TrackedHostile[]): void {
    const episode = this.episode
    if (!episode || this.maneuverInFlight) {
      return
    }
    if (this.deps.getBusy() !== null || this.deps.hazardOpen()) {
      return // v1 = no preemption: a running action keeps the body until its watchdog window
    }
    if (
      episode.lastManeuverEndedAt !== 0 &&
      Date.now() - episode.lastManeuverEndedAt < this.deps.config.maneuverCooldownMs
    ) {
      return // backoff between attempts — a flee that just failed re-fails hot
    }
    const nearest = inAlert[0]!
    episode.threatType = nearest.name // the episode narrates the current nearest
    const response = decideResponse({
      nearest,
      count: inAlert.length,
      health: bot.health(),
      armed: bot.armed(),
      stance: this.deps.stance(),
      failedFights: episode.failedFights.get(nearest.id) ?? 0,
    })
    if (response !== episode.response) {
      episode.response = response
      const position = this.position(bot)
      this.deps.emit(
        'engaged',
        nearest.name,
        response,
        inAlert.length,
        round1(nearest.distance),
        position,
        response === 'fight' ? `standing to fight the ${nearest.name}` : `running from the ${nearest.name}`,
      )
      const cry = threatCry('engaged', nearest.name, response)
      if (cry) {
        this.deps.cry(cry)
      }
    }
    this.maneuverInFlight = true
    this.deps.setBusy('combat')
    void this.runManeuver(bot, nearest, inAlert.length, response)
  }

  /** Owns the maneuver lifecycle: delegate to the driver (which owns its own
   *  deadline), record, emit overwhelmed when it isn't working, ALWAYS
   *  release the busy claim. Never rejects. */
  private async runManeuver(
    bot: ThreatBot,
    nearest: TrackedHostile,
    count: number,
    response: ThreatResponse,
  ): Promise<void> {
    const episode = this.episode
    const ctx = { abandoned: false }
    try {
      if (response === 'fight') {
        const fight = this.deps.driver.tryFight(nearest.id, ctx)
        if (fight === null) {
          // Fleet fight cap full — downgrade, never queue (queues hide wedges).
          this.deps.recordResponse('fight', 'cap_downgraded')
          if (episode) {
            episode.response = 'flee'
          }
          const outcome = await this.deps.driver.flee(ctx)
          this.deps.recordResponse('flee', outcome)
          this.afterManeuver(bot, outcome === 'cornered')
          return
        }
        const outcome = await fight
        this.deps.recordResponse('fight', outcome)
        if (outcome === 'killed' && episode) {
          episode.lastKill = true
          episode.failedFights.delete(nearest.id)
        } else if (outcome === 'lost' && episode) {
          episode.failedFights.set(nearest.id, (episode.failedFights.get(nearest.id) ?? 0) + 1)
        }
        this.afterManeuver(bot, outcome === 'lost')
        return
      }
      const outcome = await this.deps.driver.flee(ctx)
      this.deps.recordResponse('flee', outcome)
      this.afterManeuver(bot, outcome === 'cornered')
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'threat maneuver crashed')
    } finally {
      ctx.abandoned = true
      if (this.episode) {
        this.episode.lastManeuverEndedAt = Date.now()
      }
      this.deps.setBusy(null)
      this.maneuverInFlight = false
    }
  }

  /** A maneuver that didn't work may emit overwhelmed — rate-limited, episode
   *  stays open (the retry happens naturally next pass). */
  private afterManeuver(bot: ThreatBot, struggling: boolean): void {
    const episode = this.episode
    if (!episode || !struggling) {
      return
    }
    const now = Date.now()
    if (now - episode.lastOverwhelmedAt < OVERWHELMED_MIN_INTERVAL_MS) {
      return
    }
    episode.lastOverwhelmedAt = now
    const liveBot = this.deps.bot()
    const position = this.position(liveBot)
    const inAlert = (liveBot?.hostiles() ?? []).filter((h) => h.distance <= this.deps.config.alertRadius + CLOSE_HYSTERESIS)
    this.deps.emit(
      'overwhelmed',
      episode.threatType,
      episode.response,
      Math.max(1, inAlert.length),
      round1(inAlert[0]?.distance ?? 0),
      position,
      'the maneuver is not working — cornered or out-matched',
    )
    const cry = threatCry('overwhelmed', episode.threatType, episode.response)
    if (cry) {
      this.deps.cry(cry)
    }
  }

  private position(bot: ThreatBot | null): Position {
    const p = bot?.position()
    return p ? roundPos(p) : { x: 0, y: 0, z: 0 }
  }
}

/** Distance helper for adapters building TrackedHostile lists. */
export function hostileDistance(origin: Position, hostile: Position): number {
  return distance(origin, hostile)
}
