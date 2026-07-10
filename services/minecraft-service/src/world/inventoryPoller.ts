import type { Counter, Gauge } from 'prom-client'
import type { Logger } from 'pino'
import type { InventoryTracker } from './inventoryTracker.ts'
import { fetchHumanInventoryStable } from './humanInventory.ts'
import type { RconLike } from './humanInventory.ts'

export interface BotInventoryView {
  username: string
  /** bumped per connection — the tracker re-baselines on change */
  generation: number
  items: Array<{ name: string; count: number }>
}

export interface RconConnection extends RconLike {
  close(): void
}

export interface PollerDeps {
  intervalMs: number
  botViews: () => BotInventoryView[]
  /** null = can't enumerate (no active bot to read the tab list from) */
  humanNames: () => string[] | null
  /** undefined = RCON disabled — bots-only mode */
  connectRcon?: () => Promise<RconConnection>
  tracker: InventoryTracker
  polls: Pick<Counter<'source' | 'outcome'>, 'inc'>
  trackedGauge: Pick<Gauge<'kind'>, 'set'>
  log: Logger
}

/**
 * One process-wide poll (NOT per-bot): bot inventories are in-memory reads,
 * humans are a short burst of per-slot RCON round-trips — both trivial for the
 * shared event loop, no shouldRescan-style gate needed. Humans use a fresh
 * RCON connection per cycle: no stale-connection states to manage, and a dead
 * Paper server costs one refused connect per cycle.
 */
export class InventoryPoller {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private rconHealthy = true

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    if (this.deps.intervalMs === 0) {
      this.deps.log.info('inventory poller disabled (INVENTORY_POLL_INTERVAL_MS=0)')
      return
    }
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs)
    this.deps.log.info(
      { intervalMs: this.deps.intervalMs, rcon: this.deps.connectRcon !== undefined },
      'inventory poller started',
    )
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** public for tests; overlap-guarded so an RCON stall can't stack ticks */
  async tick(): Promise<void> {
    if (this.ticking) {
      return
    }
    this.ticking = true
    try {
      this.pollBots()
      await this.pollHumans()
    } finally {
      this.ticking = false
    }
  }

  private pollBots(): void {
    const { botViews, tracker, polls, log } = this.deps
    try {
      const seen = new Set<string>()
      for (const view of botViews()) {
        const grouped = new Map<string, number>()
        for (const item of view.items) {
          grouped.set(item.name, (grouped.get(item.name) ?? 0) + item.count)
        }
        tracker.update(view.username, 'villager', view.generation, grouped)
        seen.add(view.username)
      }
      for (const player of tracker.tracked('villager')) {
        if (!seen.has(player)) {
          tracker.remove(player)
        }
      }
      this.deps.trackedGauge.set({ kind: 'villager' }, tracker.tracked('villager').length)
      polls.inc({ source: 'bots', outcome: 'ok' })
    } catch (err) {
      polls.inc({ source: 'bots', outcome: 'error' })
      log.warn({ err: (err as Error).message }, 'bot inventory poll failed')
    }
  }

  private async pollHumans(): Promise<void> {
    const { connectRcon, humanNames, tracker, polls, log } = this.deps
    if (!connectRcon) {
      return
    }
    const names = humanNames()
    if (names === null) {
      return // tab list unreadable — keep existing state rather than wrongly evicting
    }
    try {
      const seen = new Set<string>()
      if (names.length > 0) {
        const rcon = await connectRcon()
        try {
          for (const name of names) {
            const result = await fetchHumanInventoryStable(rcon, name)
            if (result.status === 'offline') {
              continue // dropped from `seen` → evicted below (tab-list lag)
            }
            seen.add(name) // online — an unstable scan must never evict
            if (result.status === 'ok') {
              // generation is constant for humans: RCON reads server truth, and
              // a leave/rejoin re-baselines via remove() below.
              tracker.update(name, 'player', 1, result.items)
            } else {
              polls.inc({ source: 'rcon', outcome: 'unstable' })
            }
          }
        } finally {
          rcon.close()
        }
      }
      for (const player of tracker.tracked('player')) {
        if (!seen.has(player)) {
          tracker.remove(player)
        }
      }
      this.deps.trackedGauge.set({ kind: 'player' }, tracker.tracked('player').length)
      polls.inc({ source: 'rcon', outcome: 'ok' })
      if (!this.rconHealthy) {
        this.rconHealthy = true
        log.info('rcon inventory polling recovered')
      }
    } catch (err) {
      polls.inc({ source: 'rcon', outcome: 'error' })
      if (this.rconHealthy) {
        this.rconHealthy = false
        // log once per outage, not once per cycle — a down Paper server is loud enough already
        log.warn({ err: (err as Error).message }, 'rcon inventory poll failed — will keep retrying quietly')
      }
    }
  }
}
