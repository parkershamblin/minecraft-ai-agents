/**
 * Armor auto-equip reflex (SV-14-lite, the guard arc): the body wears the
 * best armor it carries without being asked — a mind's job is acquiring
 * armor, not dressing itself. Hand-rolled (the armor-manager dep stays out
 * per 09-survival-plan §SV-14); the EatWatcher sibling pattern: one
 * check() on an interval, gates when the body is spoken for, never claims
 * the busy seam (a sub-second inventory transaction; combat holds busy, so
 * mid-fight equips are impossible by gate).
 */

/** slot names chosen to equal mineflayer equip destinations exactly */
export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet'

export const ARMOR_SLOTS: readonly ArmorSlot[] = ['head', 'torso', 'legs', 'feet']

/** best first — index is rank */
export const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'] as const

const SLOT_SUFFIX: Record<ArmorSlot, string> = {
  head: '_helmet',
  torso: '_chestplate',
  legs: '_leggings',
  feet: '_boots',
}

/** How long one failed piece stays untried (the eat-reflex blacklist mirror). */
export const ARMOR_FAILURE_BLACKLIST_MS = 60_000

/** rank of an armor item name for its slot; null = not armor we understand
 *  (turtle_helmet and friends stay ignored — never met, never worn) */
export function armorRank(item: string, slot: ArmorSlot): number | null {
  if (!item.endsWith(SLOT_SUFFIX[slot])) {
    return null
  }
  const material = item.slice(0, -SLOT_SUFFIX[slot].length)
  const rank = (ARMOR_TIERS as readonly string[]).indexOf(material)
  return rank === -1 ? null : rank
}

export interface ArmorUpgrade {
  slot: ArmorSlot
  item: string
}

/**
 * The single best upgrade the pack offers, or null. Deterministic slot
 * order head→feet; skips equal-or-better equipped (the dedupe); respects
 * the failure blacklist. One piece per call — the watcher's
 * one-per-pass throttle and error isolation live in the plan, not the loop.
 */
export function planArmorUpgrade(
  carried: readonly string[],
  equipped: (slot: ArmorSlot) => string | null,
  blacklist: ReadonlyMap<string, number>,
  now: number,
): ArmorUpgrade | null {
  for (const slot of ARMOR_SLOTS) {
    const wornRank = (() => {
      const worn = equipped(slot)
      return worn === null ? Number.POSITIVE_INFINITY : (armorRank(worn, slot) ?? Number.POSITIVE_INFINITY)
    })()
    let best: { item: string; rank: number } | null = null
    for (const item of carried) {
      const until = blacklist.get(item)
      if (until !== undefined && now < until) {
        continue
      }
      const rank = armorRank(item, slot)
      if (rank !== null && rank < wornRank && (best === null || rank < best.rank)) {
        best = { item, rank }
      }
    }
    if (best) {
      return { slot, item: best.item }
    }
  }
  return null
}

export interface ArmorBot {
  alive: boolean
  carried(): string[]
  equipped(slot: ArmorSlot): string | null
  /** raced against the equip timeout by the watcher — never trusted to settle */
  equip(item: string, destination: ArmorSlot): Promise<void>
}

export interface ArmorWatcherDeps {
  bot(): ArmorBot | null
  getBusy(): string | null
  generation(): number
  recordEquip(slot: ArmorSlot, outcome: 'equipped' | 'failed' | 'timeout'): void
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void }
  config: { equipTimeoutMs: number }
}

export class ArmorWatcher {
  private failureBlacklist = new Map<string, number>()
  private attemptInFlight = false

  constructor(private readonly deps: ArmorWatcherDeps) {}

  check(): void {
    try {
      const bot = this.deps.bot()
      if (!bot?.alive || this.attemptInFlight) {
        return
      }
      // Busy-gate ONLY (drill lesson, 2026-07-18: a 17-minute siege held the
      // old threatOpen gate closed while Elara stood at 1 HP with a helmet
      // in her bag — an open episode is exactly when armor matters most).
      // Maneuvers hold busy='combat', so the equip still never races the
      // fight's own hand-equip; between maneuvers the body is free for a
      // sub-second inventory transaction.
      if (this.deps.getBusy() !== null) {
        return
      }
      const upgrade = planArmorUpgrade(bot.carried(), (slot) => bot.equipped(slot), this.failureBlacklist, Date.now())
      if (!upgrade) {
        return
      }
      this.attemptInFlight = true
      void this.attempt(bot, upgrade).finally(() => {
        this.attemptInFlight = false
      })
    } catch (err) {
      // A reflex never throws into its interval — but silence is not
      // success (the exit-night lesson): a persistent throw here would be
      // an invisible dead reflex. Say what broke; the interval carries on.
      this.deps.log.warn({ err: String(err) }, 'armor check crashed')
    }
  }

  private async attempt(bot: ArmorBot, upgrade: ArmorUpgrade): Promise<void> {
    const generation = this.deps.generation()
    // Re-check the seam immediately before the world touch: check() and a
    // command's busy claim interleave only at await points, and there are
    // none between the gate above and here — but the attempt itself is
    // async, so a claim can land between passes. Cheap and honest.
    if (this.deps.getBusy() !== null) {
      return
    }
    try {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('equip timeout')), this.deps.config.equipTimeoutMs)
      })
      try {
        // Never await a mineflayer promise un-raced (corollary 3).
        await Promise.race([bot.equip(upgrade.item, upgrade.slot), timeout])
      } finally {
        clearTimeout(timer)
      }
      if (this.deps.generation() !== generation) {
        return // died mid-equip — count nothing (the spawn-generation honesty rule)
      }
      this.deps.recordEquip(upgrade.slot, 'equipped')
      this.deps.log.info({ item: upgrade.item, slot: upgrade.slot }, 'armor equipped')
    } catch (err) {
      if (this.deps.generation() !== generation) {
        return
      }
      const timedOut = err instanceof Error && err.message === 'equip timeout'
      this.failureBlacklist.set(upgrade.item, Date.now() + ARMOR_FAILURE_BLACKLIST_MS)
      this.deps.recordEquip(upgrade.slot, timedOut ? 'timeout' : 'failed')
      this.deps.log.warn({ item: upgrade.item, slot: upgrade.slot, err: String(err) }, 'armor equip failed')
    }
  }
}
