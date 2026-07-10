import { describe, expect, it, vi } from 'vitest'
import { InventoryTracker } from '../src/world/inventoryTracker.ts'

function harness() {
  const gauge = { set: vi.fn(), remove: vi.fn() }
  const counter = { inc: vi.fn() }
  return { tracker: new InventoryTracker({ gauge, counter }), gauge, counter }
}

const inv = (entries: Array<[string, number]>) => new Map(entries)

describe('InventoryTracker', () => {
  it('mirrors the first observation into gauges without counting anything', () => {
    const h = harness()
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 5], ['bread', 3]]))
    expect(h.gauge.set).toHaveBeenCalledWith({ player: 'Cassia', item: 'oak_log', kind: 'villager' }, 5)
    expect(h.gauge.set).toHaveBeenCalledWith({ player: 'Cassia', item: 'bread', kind: 'villager' }, 3)
    expect(h.counter.inc).not.toHaveBeenCalled()
  })

  it('counts positive deltas only from the third observation of a generation', () => {
    const h = harness()
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 5]]))
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 7]])) // second poll arms, never counts
    expect(h.counter.inc).not.toHaveBeenCalled()
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 12]]))
    expect(h.counter.inc).toHaveBeenCalledWith({ player: 'Cassia', item: 'oak_log', kind: 'villager' }, 5)
  })

  it('never books the post-spawn inventory sync as a haul (empty first poll)', () => {
    const h = harness()
    h.tracker.update('Cassia', 'villager', 1, inv([])) // pre-sync read
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 30]])) // sync landed
    expect(h.counter.inc).not.toHaveBeenCalled()
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 31]]))
    expect(h.counter.inc).toHaveBeenCalledWith({ player: 'Cassia', item: 'oak_log', kind: 'villager' }, 1)
  })

  it('ignores decreases but keeps the gauge honest', () => {
    const h = harness()
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 10]]))
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 10]]))
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 4]])) // deposited into a chest
    expect(h.counter.inc).not.toHaveBeenCalled()
    expect(h.gauge.set).toHaveBeenLastCalledWith({ player: 'Cassia', item: 'oak_log', kind: 'villager' }, 4)
  })

  it('removes the gauge series when an item vanishes from the inventory', () => {
    const h = harness()
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 10], ['bread', 1]]))
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 10]]))
    expect(h.gauge.remove).toHaveBeenCalledWith({ player: 'Cassia', item: 'bread', kind: 'villager' })
  })

  it('re-baselines on a new generation (reconnect zero-then-restore is not a haul)', () => {
    const h = harness()
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 10]]))
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 10]]))
    h.tracker.update('Cassia', 'villager', 2, inv([])) // reconnected, inventory not yet synced
    h.tracker.update('Cassia', 'villager', 2, inv([['oak_log', 10]])) // restored
    expect(h.counter.inc).not.toHaveBeenCalled()
    h.tracker.update('Cassia', 'villager', 2, inv([['oak_log', 13]]))
    expect(h.counter.inc).toHaveBeenCalledWith({ player: 'Cassia', item: 'oak_log', kind: 'villager' }, 3)
  })

  it('remove() clears every series for the player and forgets them', () => {
    const h = harness()
    h.tracker.update('ParkerShamblin', 'player', 1, inv([['iron_pickaxe', 1], ['oak_log', 64]]))
    h.tracker.remove('ParkerShamblin')
    expect(h.gauge.remove).toHaveBeenCalledWith({ player: 'ParkerShamblin', item: 'iron_pickaxe', kind: 'player' })
    expect(h.gauge.remove).toHaveBeenCalledWith({ player: 'ParkerShamblin', item: 'oak_log', kind: 'player' })
    expect(h.tracker.tracked('player')).toEqual([])
    // re-appearing starts a fresh baseline: still nothing counted
    h.tracker.update('ParkerShamblin', 'player', 1, inv([['oak_log', 99]]))
    expect(h.counter.inc).not.toHaveBeenCalled()
  })

  it('tracked() filters by kind', () => {
    const h = harness()
    h.tracker.update('Cassia', 'villager', 1, inv([['oak_log', 1]]))
    h.tracker.update('ParkerShamblin', 'player', 1, inv([['stone', 1]]))
    expect(h.tracker.tracked('villager')).toEqual(['Cassia'])
    expect(h.tracker.tracked('player')).toEqual(['ParkerShamblin'])
  })
})

