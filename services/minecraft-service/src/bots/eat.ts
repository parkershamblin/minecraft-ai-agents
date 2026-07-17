import type { Position } from '../world/position.ts'
import type { BusyState } from './hazard.ts'

/**
 * The eat reflex (SV-6). There is deliberately NO eat verb: a tick buys one
 * world action and acquisition is the mind's job — the body handles the
 * mechanical act of eating what's carried, the way it handles digging out of
 * powder snow. EatWatcher is a sibling interval of HazardWatcher, one polled
 * check gated on the busy seam; never bot.on('health') — that event goes
 * silent exactly at the food=0 steady state, and the polled check is the one
 * arbitration shape this codebase trusts.
 *
 * Facts discipline: routine eats are log + metric only (no ledger noise, no
 * percept-queue eviction). The CRISIS — starving AND helpless — reuses
 * HazardEncountered with hazardType='starvation': trapped once per episode,
 * escaped on recovery, escape_failed never.
 */

export type EatOutcome = 'ate' | 'ate_desperate' | 'no_effect' | 'failed' | 'timeout'

/** How long one failed food item stays off the menu (the gather-blacklist
 *  discipline, per item). */
const FOOD_FAILURE_BLACKLIST_MS = 60_000

/** Consecutive consume failures that mark the reflex helpless (crisis
 *  trigger #2 — trigger #1 is an empty pantry). */
const HELPLESS_AFTER_FAILURES = 3

/** The slice of a mineflayer Bot the reflex reads and drives — structural,
 *  so tests fake it. */
export interface EatBot {
  alive: boolean
  health(): number
  food(): number
  position(): Position | null
  /** carried stacks with the registry's food value; non-food = undefined */
  carriedFood(): Array<{ name: string; foodPoints: number }>
  equipFood(name: string): Promise<void>
  /** consume whatever is in hand — mineflayer's bot.consume() */
  consume(): Promise<void>
}

export interface EatConfig {
  /** peckish: eat when food ≤ this */
  foodThreshold: number
  /** starving: desperation foods unlock; the crisis can open */
  criticalFood: number
  /** the starvation crisis closes at food ≥ this (hysteresis) */
  recoverFood: number
  /** hurt modifier: also eat when health ≤ this AND food < 18 (regen gate); 0 disables */
  hurtHealthThreshold: number
  /** one equip+consume races this deadline */
  eatTimeoutMs: number
  /** backoff after a failed attempt */
  retryMs: number
  /** never eaten: damage or teleport-falsifies-position foods */
  bannedFoods: ReadonlySet<string>
  /** eaten only at the starving tier ("choked down rotten flesh" is the color) */
  desperationFoods: ReadonlySet<string>
}

/** food < 18 stops natural regen — a hardcoded game constant, not a knob. */
const REGEN_FOOD_GATE = 18

interface EatLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface EatWatcherDeps {
  bot(): EatBot | null
  getBusy(): BusyState
  setBusy(state: 'eat' | null): void
  /** an open trap episode locks the reflex out (priority: escape > combat > eat) */
  hazardOpen(): boolean
  /** an open threat episode does too */
  threatOpen(): boolean
  emitCrisis(phase: 'trapped' | 'escaped', position: Position, detail: string | null): void
  record(outcome: EatOutcome): void
  /** spawn generation — a death mid-episode/attempt is dropped silently
   *  (the respawned body is fresh; a lying "recovered" emit would poison
   *  the ledger) */
  generation(): number
  log: EatLog
  config: EatConfig
}

/** Rank carried food: most food points first (never saturation —
 *  minecraft-data's saturation values are non-vanilla scaled), name as the
 *  deterministic tie-break. Pure, exported for tests. */
export function pickFood(
  carried: readonly { name: string; foodPoints: number }[],
  opts: {
    starving: boolean
    bannedFoods: ReadonlySet<string>
    desperationFoods: ReadonlySet<string>
    blacklist: ReadonlyMap<string, number>
    now: number
  },
): { name: string; foodPoints: number; desperate: boolean } | null {
  let best: { name: string; foodPoints: number } | null = null
  for (const stack of carried) {
    if (opts.bannedFoods.has(stack.name)) {
      continue
    }
    const desperate = opts.desperationFoods.has(stack.name)
    if (desperate && !opts.starving) {
      continue
    }
    const until = opts.blacklist.get(stack.name)
    if (until !== undefined && until > opts.now) {
      continue
    }
    if (
      !best ||
      stack.foodPoints > best.foodPoints ||
      (stack.foodPoints === best.foodPoints && stack.name < best.name)
    ) {
      best = stack
    }
  }
  return best ? { ...best, desperate: opts.desperationFoods.has(best.name) } : null
}

interface Crisis {
  openedAt: number
  generation: number
}

/**
 * Per-bot hunger watch. check() is the only entry — wired to a setInterval
 * sibling of the snapshot/hazard loops. Each pass is two scalar reads; the
 * inventory scan runs only when a threshold trips. The pass catches
 * everything: no throw or rejection ever escapes the interval.
 */
export class EatWatcher {
  private attemptInFlight = false
  private lastFailureAt = 0
  private consecutiveFailures = 0
  private readonly failureBlacklist = new Map<string, number>()
  private crisis: Crisis | null = null

  constructor(private readonly deps: EatWatcherDeps) {}

  check(): void {
    try {
      const bot = this.deps.bot()
      if (!bot?.alive) {
        return
      }
      // A death since the crisis opened respawned a fresh body (food 20) —
      // close silently; emitting "escaped" would claim a recovery that never
      // happened (the spawn-generation honesty rule, from the inventory kit).
      if (this.crisis && this.deps.generation() !== this.crisis.generation) {
        this.crisis = null
        this.consecutiveFailures = 0
      }
      const food = bot.food()
      if (this.crisis && food >= this.deps.config.recoverFood) {
        this.closeCrisisRecovered(bot, food)
      }
      if (!this.shouldEat(food, bot.health())) {
        return
      }
      const now = Date.now()
      const choice = pickFood(bot.carriedFood(), {
        starving: food <= this.deps.config.criticalFood,
        bannedFoods: this.deps.config.bannedFoods,
        desperationFoods: this.deps.config.desperationFoods,
        blacklist: this.failureBlacklist,
        now,
      })
      if (!choice) {
        // Helpless by empty pantry. The reflex does NOTHING (the standing
        // directive owns acquisition pressure) — but if this is the starving
        // tier, the crisis wakes the mind.
        this.maybeOpenCrisis(bot, food, 'nothing edible carried')
        return
      }
      if (this.attemptInFlight || this.deps.getBusy() !== null) {
        return
      }
      if (this.deps.hazardOpen() || this.deps.threatOpen()) {
        return // the ladder: escape and combat outrank a meal
      }
      if (now - this.lastFailureAt < this.deps.config.retryMs) {
        return // backoff after a failure — the same pantry fails the same way
      }
      this.attemptInFlight = true
      this.deps.setBusy('eat')
      void this.runAttempt(bot, food, choice)
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'eat watch pass failed')
    }
  }

  /** An open starvation crisis — surfaced for symmetry with the other
   *  episode getters (observability, tests). */
  get starving(): boolean {
    return this.crisis !== null
  }

  private shouldEat(food: number, health: number): boolean {
    if (food <= this.deps.config.foodThreshold) {
      return true
    }
    const { hurtHealthThreshold } = this.deps.config
    // Hurt modifier: eating below the regen gate restarts natural healing —
    // that's the "not slain" loop (flee → eat → regen), not luxury dining.
    return hurtHealthThreshold > 0 && health <= hurtHealthThreshold && food < REGEN_FOOD_GATE
  }

  /** One equip+consume, raced against the deadline (never trust a mineflayer
   *  promise to settle). Always releases the busy claim. Never rejects. */
  private async runAttempt(
    bot: EatBot,
    foodBefore: number,
    choice: { name: string; foodPoints: number; desperate: boolean },
  ): Promise<void> {
    const generation = this.deps.generation()
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.deps.config.eatTimeoutMs)
    })
    try {
      const result = await Promise.race([
        (async () => {
          await bot.equipFood(choice.name)
          await bot.consume()
          return 'done' as const
        })(),
        timedOut,
      ])
      if (this.deps.generation() !== generation) {
        return // died mid-bite — the respawned body's food is not our delta
      }
      if (result === 'timeout') {
        this.recordFailure(bot, choice.name, 'timeout')
        return
      }
      const gained = bot.food() - foodBefore
      if (gained <= 0) {
        // The ghost-dig honesty rule applied to consume: it "worked" but the
        // hunger bar disagrees — count nothing, blacklist the item.
        this.recordFailure(bot, choice.name, 'no_effect')
        return
      }
      this.consecutiveFailures = 0
      this.deps.record(choice.desperate ? 'ate_desperate' : 'ate')
      this.deps.log.info(
        { food: bot.food(), item: choice.name, gained, desperate: choice.desperate },
        choice.desperate ? 'choked down desperation food' : 'ate from the pack',
      )
      if (this.crisis && bot.food() >= this.deps.config.recoverFood) {
        this.closeCrisisRecovered(bot, bot.food())
      }
    } catch (err) {
      if (this.deps.generation() === generation) {
        this.deps.log.warn({ err: (err as Error).message, item: choice.name }, 'eat attempt crashed')
        this.recordFailure(bot, choice.name, 'failed')
      }
    } finally {
      clearTimeout(timer)
      this.deps.setBusy(null)
      this.attemptInFlight = false
    }
  }

  private recordFailure(bot: EatBot, item: string, outcome: 'failed' | 'timeout' | 'no_effect'): void {
    this.failureBlacklist.set(item, Date.now() + FOOD_FAILURE_BLACKLIST_MS)
    this.lastFailureAt = Date.now()
    this.consecutiveFailures += 1
    this.deps.record(outcome)
    if (this.consecutiveFailures >= HELPLESS_AFTER_FAILURES) {
      this.maybeOpenCrisis(bot, bot.food(), `${this.consecutiveFailures} consume attempts failed in a row`)
    }
  }

  /** trapped emitted ONCE per episode, only at the starving tier. */
  private maybeOpenCrisis(bot: EatBot, food: number, why: string): void {
    if (this.crisis || food > this.deps.config.criticalFood) {
      return
    }
    this.crisis = { openedAt: Date.now(), generation: this.deps.generation() }
    const position = bot.position() ?? { x: 0, y: 0, z: 0 }
    this.deps.log.warn({ food, why }, 'starvation crisis opened')
    this.deps.emitCrisis('trapped', position, `food ${food}/20 and ${why} — the eat reflex is helpless until food is acquired`)
  }

  private closeCrisisRecovered(bot: EatBot, food: number): void {
    const crisis = this.crisis
    if (!crisis) {
      return
    }
    this.crisis = null
    this.consecutiveFailures = 0
    const seconds = Math.round((Date.now() - crisis.openedAt) / 1_000)
    const position = bot.position() ?? { x: 0, y: 0, z: 0 }
    this.deps.log.info({ food, seconds }, 'starvation crisis recovered')
    this.deps.emitCrisis('escaped', position, `ate back to food ${food}/20 after ~${seconds}s starving`)
  }
}
