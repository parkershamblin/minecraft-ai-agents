import type { Counter, Gauge } from 'prom-client'

export type PlayerKind = 'villager' | 'player'

type InventoryLabels = 'player' | 'item' | 'kind'

export interface TrackerDeps {
  gauge: Pick<Gauge<InventoryLabels>, 'set' | 'remove'>
  counter: Pick<Counter<InventoryLabels>, 'inc'>
}

interface PlayerState {
  kind: PlayerKind
  generation: number
  /** counting starts on the third update of a generation — see below */
  armed: boolean
  counts: Map<string, number>
}

/**
 * Turns inventory observations into metrics: gauges mirror the current
 * inventory; positive deltas between consecutive observations count as
 * "collected". Two rules keep the counter honest (fabricated hauls poison the
 * leaderboard the way FakeProvider chat poisoned relationships):
 *
 * 1. A new `generation` (one per bot connection — reconnects bump it) always
 *    re-baselines: the tracker never compares across connections.
 * 2. The first TWO observations of a generation are baseline-only. Right after
 *    (re)spawn the server may not have synced the inventory yet, so the first
 *    poll can read empty; counting from it would book the entire restored
 *    inventory as a haul. The cost is one blind poll interval per connection.
 *
 * Negative deltas (deposits, drops, deaths, crafting inputs) never count.
 */
export class InventoryTracker {
  private players = new Map<string, PlayerState>()

  constructor(private readonly deps: TrackerDeps) {}

  update(player: string, kind: PlayerKind, generation: number, items: ReadonlyMap<string, number>): void {
    const prev = this.players.get(player)
    const fresh = prev === undefined || prev.generation !== generation || prev.kind !== kind
    if (fresh && prev) {
      // stale series from the previous generation/kind whose items vanished
      for (const item of prev.counts.keys()) {
        if (!items.has(item)) {
          this.deps.gauge.remove({ player, item, kind: prev.kind })
        }
      }
    }
    const counting = !fresh && prev.armed
    for (const [item, count] of items) {
      const before = fresh ? 0 : (prev.counts.get(item) ?? 0)
      if (counting && count > before) {
        this.deps.counter.inc({ player, item, kind }, count - before)
      }
      this.deps.gauge.set({ player, item, kind }, count)
    }
    if (!fresh) {
      for (const item of prev.counts.keys()) {
        if (!items.has(item)) {
          this.deps.gauge.remove({ player, item, kind })
        }
      }
    }
    this.players.set(player, { kind, generation, armed: !fresh, counts: new Map(items) })
  }

  /** Player left: drop their gauge series so the dashboard doesn't show ghosts. */
  remove(player: string): void {
    const state = this.players.get(player)
    if (!state) {
      return
    }
    for (const item of state.counts.keys()) {
      this.deps.gauge.remove({ player, item, kind: state.kind })
    }
    this.players.delete(player)
  }

  tracked(kind: PlayerKind): string[] {
    return [...this.players.entries()].filter(([, state]) => state.kind === kind).map(([player]) => player)
  }
}
