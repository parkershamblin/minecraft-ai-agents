import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'
import { InventoryPoller, type BotInventoryView, type RconConnection } from '../src/world/inventoryPoller.ts'
import { InventoryTracker } from '../src/world/inventoryTracker.ts'

interface Harness {
  poller: InventoryPoller
  gauge: { set: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
  counter: { inc: ReturnType<typeof vi.fn> }
  polls: { inc: ReturnType<typeof vi.fn> }
  trackedGauge: { set: ReturnType<typeof vi.fn> }
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
}

function harness(overrides: {
  botViews?: () => BotInventoryView[]
  humanNames?: () => string[] | null
  connectRcon?: () => Promise<RconConnection>
  intervalMs?: number
}): Harness {
  const gauge = { set: vi.fn(), remove: vi.fn() }
  const counter = { inc: vi.fn() }
  const polls = { inc: vi.fn() }
  const trackedGauge = { set: vi.fn() }
  const log = { info: vi.fn(), warn: vi.fn() }
  const poller = new InventoryPoller({
    intervalMs: overrides.intervalMs ?? 15_000,
    botViews: overrides.botViews ?? (() => []),
    humanNames: overrides.humanNames ?? (() => []),
    connectRcon: overrides.connectRcon,
    tracker: new InventoryTracker({ gauge, counter }),
    polls,
    trackedGauge,
    log: log as unknown as Logger,
  })
  return { poller, gauge, counter, polls, trackedGauge, log }
}

/** Fake RCON answering per-slot data-get probes from a mutable item list. */
function scriptedRcon(items: Array<{ id: string; count: number }>): RconConnection & { close: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async (command: string) => {
      const match = /Inventory\[(\d+)\]\.(id|count)$/.exec(command)
      const slot = Number(match![1])
      const item = items[slot]
      if (!item) {
        return `Found no elements matching Inventory[${slot}]`
      }
      return match![2] === 'id'
        ? `Parker has the following entity data: "minecraft:${item.id}"`
        : `Parker has the following entity data: ${item.count}`
    }),
    close: vi.fn(),
  }
}

describe('InventoryPoller', () => {
  it('tracks bot inventories: gauges from the first tick, deltas from the third', async () => {
    const items = [{ name: 'oak_log', count: 4 }, { name: 'oak_log', count: 2 }] // two stacks — grouped
    const h = harness({ botViews: () => [{ username: 'Cassia', generation: 1, items }] })
    await h.poller.tick()
    expect(h.gauge.set).toHaveBeenCalledWith({ player: 'Cassia', item: 'oak_log', kind: 'villager' }, 6)
    await h.poller.tick()
    items.push({ name: 'oak_log', count: 5 })
    await h.poller.tick()
    expect(h.counter.inc).toHaveBeenCalledWith({ player: 'Cassia', item: 'oak_log', kind: 'villager' }, 5)
    expect(h.polls.inc).toHaveBeenCalledWith({ source: 'bots', outcome: 'ok' })
    expect(h.trackedGauge.set).toHaveBeenCalledWith({ kind: 'villager' }, 1)
  })

  it('evicts bots that left the registry', async () => {
    let views: BotInventoryView[] = [{ username: 'Cassia', generation: 1, items: [{ name: 'bread', count: 1 }] }]
    const h = harness({ botViews: () => views })
    await h.poller.tick()
    views = []
    await h.poller.tick()
    expect(h.gauge.remove).toHaveBeenCalledWith({ player: 'Cassia', item: 'bread', kind: 'villager' })
  })

  it('polls humans over RCON and closes the connection each cycle', async () => {
    const items = [{ id: 'stone', count: 12 }]
    const rcon = scriptedRcon(items)
    const connectRcon = vi.fn(async () => rcon)
    const h = harness({ humanNames: () => ['Parker'], connectRcon })
    await h.poller.tick()
    expect(h.gauge.set).toHaveBeenCalledWith({ player: 'Parker', item: 'stone', kind: 'player' }, 12)
    expect(rcon.close).toHaveBeenCalledTimes(1)
    await h.poller.tick()
    items[0] = { id: 'stone', count: 20 }
    await h.poller.tick()
    expect(h.counter.inc).toHaveBeenCalledWith({ player: 'Parker', item: 'stone', kind: 'player' }, 8)
    expect(h.polls.inc).toHaveBeenCalledWith({ source: 'rcon', outcome: 'ok' })
  })

  it('discards torn human scans: no update, no eviction, an unstable-outcome tick', async () => {
    // .count responses per call: tick 1 scans agree (5,5); tick 2 tears (7 vs 9)
    const countQueue = [5, 5, 7, 9]
    const send = vi.fn(async (command: string) => {
      const match = /Inventory\[(\d+)\]\.(id|count)$/.exec(command)
      if (!match || Number(match[1]) > 0) {
        return 'Found no elements matching that path'
      }
      return match[2] === 'id'
        ? 'Parker has the following entity data: "minecraft:stone"'
        : `Parker has the following entity data: ${countQueue.shift()}`
    })
    const h = harness({ humanNames: () => ['Parker'], connectRcon: async () => ({ send, close: vi.fn() }) })
    await h.poller.tick()
    expect(h.gauge.set).toHaveBeenCalledWith({ player: 'Parker', item: 'stone', kind: 'player' }, 5)
    h.gauge.set.mockClear()
    await h.poller.tick() // torn scan
    expect(h.gauge.set).not.toHaveBeenCalled()
    expect(h.gauge.remove).not.toHaveBeenCalled() // still online — never evicted
    expect(h.polls.inc).toHaveBeenCalledWith({ source: 'rcon', outcome: 'unstable' })
  })

  it('evicts humans who logged off (empty tab list, no RCON needed)', async () => {
    let humans: string[] = ['Parker']
    const rcon = scriptedRcon([{ id: 'stone', count: 1 }])
    const h = harness({ humanNames: () => humans, connectRcon: async () => rcon })
    await h.poller.tick()
    humans = []
    await h.poller.tick()
    expect(h.gauge.remove).toHaveBeenCalledWith({ player: 'Parker', item: 'stone', kind: 'player' })
  })

  it('keeps state untouched when the tab list is unreadable (no active bots)', async () => {
    const rcon = scriptedRcon([{ id: 'stone', count: 1 }])
    const connectRcon = vi.fn(async () => rcon)
    let humans: string[] | null = ['Parker']
    const h = harness({ humanNames: () => humans, connectRcon })
    await h.poller.tick()
    humans = null
    await h.poller.tick()
    expect(h.gauge.remove).not.toHaveBeenCalled()
    expect(connectRcon).toHaveBeenCalledTimes(1)
  })

  it('skips human polling entirely when RCON is not configured', async () => {
    const h = harness({ humanNames: () => ['Parker'] })
    await h.poller.tick()
    expect(h.polls.inc).toHaveBeenCalledTimes(1) // bots only
    expect(h.polls.inc).toHaveBeenCalledWith({ source: 'bots', outcome: 'ok' })
  })

  it('logs an RCON outage once, not once per cycle, and recovers loudly', async () => {
    let failing = true
    const rcon = scriptedRcon([])
    const h = harness({
      humanNames: () => ['Parker'],
      connectRcon: async () => {
        if (failing) {
          throw new Error('ECONNREFUSED')
        }
        return rcon
      },
    })
    await h.poller.tick()
    await h.poller.tick()
    expect(h.log.warn).toHaveBeenCalledTimes(1)
    expect(h.polls.inc).toHaveBeenCalledWith({ source: 'rcon', outcome: 'error' })
    failing = false
    await h.poller.tick()
    expect(h.log.info).toHaveBeenCalledWith('rcon inventory polling recovered')
  })

  describe('scheduling', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('ticks on its interval and stops cleanly', async () => {
      const botViews = vi.fn(() => [])
      const h = harness({ botViews, intervalMs: 15_000 })
      h.poller.start()
      await vi.advanceTimersByTimeAsync(45_100)
      expect(botViews).toHaveBeenCalledTimes(3)
      h.poller.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(botViews).toHaveBeenCalledTimes(3)
    })

    it('interval 0 disables the poller', async () => {
      const botViews = vi.fn(() => [])
      const h = harness({ botViews, intervalMs: 0 })
      h.poller.start()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(botViews).not.toHaveBeenCalled()
    })
  })
})
