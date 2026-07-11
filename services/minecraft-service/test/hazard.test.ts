import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  type BusyState,
  type HazardBlock,
  type HazardBot,
  type HazardConfig,
  type HazardPhase,
  HazardWatcher,
  hardenMovements,
  hazardPayload,
} from '../src/bots/hazard.ts'
import type { Position } from '../src/world/position.ts'

const key = (p: Position) => `${p.x},${p.y},${p.z}`

/** A three-cell-deep world the reflex can read, dig, and walk through. */
class FakeBot implements HazardBot {
  world = new Map<string, { name: string; boundingBox: string }>()
  digs: string[] = []
  looks: Array<{ yaw: number; pitch: number }> = []
  controls = new Map<string, boolean>()
  entityPosition: Position | null = { x: 0.5, y: 64, z: 0.5 }
  /** test hook: fired when forward engages — the fake's stand-in for physics */
  onForward: (() => void) | null = null
  /** test hook: overrides digging (e.g. a promise that never settles) */
  digImpl: ((block: HazardBlock) => Promise<void>) | null = null

  get entity(): { position: Position } | undefined {
    return this.entityPosition ? { position: this.entityPosition } : undefined
  }

  set(p: Position, name: string, boundingBox: 'block' | 'empty'): void {
    this.world.set(key(p), { name, boundingBox })
  }

  blockAt(p: Position): HazardBlock | null {
    const spec = this.world.get(key(p))
    return spec ? { name: spec.name, boundingBox: spec.boundingBox, position: { ...p } } : null
  }

  async dig(block: HazardBlock): Promise<void> {
    if (this.digImpl) {
      return this.digImpl(block)
    }
    this.digs.push(key(block.position))
    this.set(block.position, 'air', 'empty')
  }

  async look(yaw: number, pitch: number): Promise<void> {
    this.looks.push({ yaw, pitch })
  }

  setControlState(control: 'forward', state: boolean): void {
    this.controls.set(control, state)
    if (state) {
      this.onForward?.()
    }
  }
}

/** Bury the bot at (0,64,0): powder snow at feet, head, AND under the feet —
 *  digging its own cells alone never satisfies the solid-floor check.
 *  (boundingBox 'empty' is the real minecraft-data value for powder snow —
 *  the exact reason the pathfinder walks bots into it.) */
function bury(bot: FakeBot): void {
  bot.set({ x: 0, y: 64, z: 0 }, 'powder_snow', 'empty')
  bot.set({ x: 0, y: 65, z: 0 }, 'powder_snow', 'empty')
  bot.set({ x: 0, y: 63, z: 0 }, 'powder_snow', 'empty')
}

interface Harness {
  watcher: HazardWatcher
  bot: FakeBot
  emitted: Array<{ phase: HazardPhase; position: Position; detail: string | null }>
  stopMoving: ReturnType<typeof vi.fn>
  busy: () => BusyState
  setBusy: (state: BusyState) => void
}

function harness(bot: FakeBot, config: Partial<HazardConfig> = {}): Harness {
  const emitted: Harness['emitted'] = []
  let busy: BusyState = null
  const stopMoving = vi.fn()
  const watcher = new HazardWatcher({
    bot: () => bot,
    emit: (phase, position, detail) => emitted.push({ phase, position, detail }),
    stopMoving,
    getBusy: () => busy,
    setBusy: (state) => {
      busy = state
    },
    log: { info: vi.fn(), warn: vi.fn() },
    config: { escapeRetryMs: 15_000, digBudget: 12, escapeTimeoutMs: 25_000, ...config },
  })
  return {
    watcher,
    bot,
    emitted,
    stopMoving,
    busy: () => busy,
    setBusy: (state) => {
      busy = state
    },
  }
}

const phases = (h: Harness) => h.emitted.map((e) => e.phase)

describe('hardenMovements', () => {
  it('adds the powder_snow block id to blocksToAvoid', () => {
    const movements = { blocksToAvoid: new Set([101]) }
    hardenMovements(movements, { blocksByName: { powder_snow: { id: 960 } } })
    expect(movements.blocksToAvoid.has(960)).toBe(true)
    expect(movements.blocksToAvoid.has(101)).toBe(true) // existing avoidances survive
  })

  it('tolerates the block missing from the registry', () => {
    const movements = { blocksToAvoid: new Set<number>() }
    expect(() => hardenMovements(movements, { blocksByName: {} })).not.toThrow()
    expect(movements.blocksToAvoid.size).toBe(0)
  })
})

describe('hazardPayload', () => {
  // Producer-side tripwire against the REAL committed contract, like envelope.test.ts.
  const schema = JSON.parse(
    readFileSync(
      new URL('../../../packages/events/schemas/world/HazardEncountered.v1.schema.json', import.meta.url),
      'utf8',
    ),
  )
  const ajv = new Ajv2020({ allErrors: true })
  addFormats(ajv)
  const validate = ajv.compile(schema)

  it('validates against the committed contract schema, detail string or null', () => {
    const villagerId = '019f8e2c-0000-7000-8000-00000000e1a1'
    expect(validate(hazardPayload(villagerId, 'trapped', { x: 12.5, y: 110, z: -3.5 }, 'sunk into powder snow'))).toBe(
      true,
    )
    expect(validate(hazardPayload(villagerId, 'escaped', { x: 0, y: 64, z: 0 }, null))).toBe(true)
    expect(validate.errors ?? []).toEqual([])
  })
})

describe('HazardWatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  describe('detection', () => {
    it('two consecutive positive passes open the episode and emit trapped exactly once', async () => {
      const h = harness(new FakeBot())
      bury(h.bot)
      h.setBusy('action') // isolate detection — the reflex may not take the body
      h.watcher.check()
      expect(h.emitted).toHaveLength(0) // one pass can be a clipped corner
      h.watcher.check()
      expect(phases(h)).toEqual(['trapped'])
      expect(h.emitted[0]!.detail).toBe('sunk into powder snow')
      h.watcher.check()
      h.watcher.check()
      expect(phases(h)).toEqual(['trapped']) // an open episode never re-announces
    })

    it('one hit followed by a clear pass does nothing — the debounce demands consecutive hits', () => {
      const h = harness(new FakeBot())
      bury(h.bot)
      h.watcher.check() // hit 1
      h.bot.set({ x: 0, y: 64, z: 0 }, 'air', 'empty')
      h.bot.set({ x: 0, y: 65, z: 0 }, 'air', 'empty')
      h.watcher.check() // clear — resets
      bury(h.bot)
      h.watcher.check() // hit 1 again
      expect(h.emitted).toHaveLength(0)
    })

    it('head-level powder snow counts too', () => {
      const h = harness(new FakeBot())
      h.setBusy('action')
      h.bot.set({ x: 0, y: 65, z: 0 }, 'powder_snow', 'empty') // head only, feet unloaded
      h.watcher.check()
      h.watcher.check()
      expect(phases(h)).toEqual(['trapped'])
    })

    it('a missing entity (mid-respawn) is safe and resets the debounce', () => {
      const h = harness(new FakeBot())
      h.setBusy('action')
      bury(h.bot)
      h.watcher.check() // hit 1
      h.bot.entityPosition = null
      h.watcher.check() // no body — resets
      h.bot.entityPosition = { x: 0.5, y: 64, z: 0.5 }
      h.watcher.check() // hit 1 again
      expect(h.emitted).toHaveLength(0)
      h.watcher.check() // hit 2
      expect(phases(h)).toEqual(['trapped'])
    })
  })

  describe('escape', () => {
    it('digs its own cells and the cheapest exit, walks out, and emits escaped with the story', async () => {
      const h = harness(new FakeBot())
      bury(h.bot)
      // The only viable exit is east: snow feet (one dig), clear head, stone floor.
      h.bot.set({ x: 1, y: 64, z: 0 }, 'powder_snow', 'empty')
      h.bot.set({ x: 1, y: 65, z: 0 }, 'air', 'empty')
      h.bot.set({ x: 1, y: 63, z: 0 }, 'stone', 'block')
      h.bot.onForward = () => {
        h.bot.entityPosition = { x: 1.5, y: 64, z: 0.5 }
      }
      h.watcher.check()
      h.watcher.check() // opens the episode and starts the attempt
      expect(h.busy()).toBe('escape')
      await vi.advanceTimersByTimeAsync(500) // walk-poll notices the cell change
      expect(phases(h)).toEqual(['trapped', 'escaped'])
      // own head first (stops the freeze clock), own feet, then the exit's feet
      expect(h.bot.digs).toEqual(['0,65,0', '0,64,0', '1,64,0'])
      expect(h.emitted[1]!.detail).toMatch(/dug 3 powder snow blocks to get free after ~\d+s trapped/)
      expect(h.stopMoving).toHaveBeenCalledTimes(1)
      expect(h.bot.controls.get('forward')).toBe(false)
      expect(h.busy()).toBeNull()
    })

    it('no diggable exit fails the attempt, keeps the episode open, and retries only after backoff', async () => {
      const h = harness(new FakeBot())
      bury(h.bot) // floor is powder snow and every neighbor column is unloaded
      h.watcher.check()
      h.watcher.check()
      await vi.advanceTimersByTimeAsync(1)
      expect(phases(h)).toEqual(['trapped', 'escape_failed'])
      expect(h.emitted[1]!.detail).toMatch(/no diggable exit/)
      expect(h.bot.digs).toEqual(['0,65,0', '0,64,0']) // it DID clear its own cells first
      expect(h.busy()).toBeNull()
      await vi.advanceTimersByTimeAsync(1_000)
      h.watcher.check() // inside backoff — no new attempt
      await vi.advanceTimersByTimeAsync(1)
      expect(phases(h)).toEqual(['trapped', 'escape_failed'])
      await vi.advanceTimersByTimeAsync(15_000)
      h.watcher.check() // past backoff — retries and fails honestly again
      await vi.advanceTimersByTimeAsync(1)
      expect(phases(h)).toEqual(['trapped', 'escape_failed', 'escape_failed'])
    })

    it('the dig budget bounds an attempt', async () => {
      const h = harness(new FakeBot(), { digBudget: 1 })
      bury(h.bot)
      h.watcher.check()
      h.watcher.check()
      await vi.advanceTimersByTimeAsync(1)
      expect(phases(h)).toEqual(['trapped', 'escape_failed'])
      expect(h.emitted[1]!.detail).toMatch(/dig budget of 1 spent/)
      expect(h.bot.digs).toEqual(['0,65,0']) // spent the whole budget on the head cell
    })

    it('a walk that never leaves the cell fails the attempt', async () => {
      const h = harness(new FakeBot())
      bury(h.bot)
      h.bot.set({ x: 1, y: 64, z: 0 }, 'air', 'empty')
      h.bot.set({ x: 1, y: 65, z: 0 }, 'air', 'empty')
      h.bot.set({ x: 1, y: 63, z: 0 }, 'stone', 'block')
      // no onForward hook: the body never moves
      h.watcher.check()
      h.watcher.check()
      await vi.advanceTimersByTimeAsync(3_500) // the ~3s walk budget lapses
      expect(phases(h)).toEqual(['trapped', 'escape_failed'])
      expect(h.emitted[1]!.detail).toMatch(/never left the trapped cell/)
      expect(h.bot.controls.get('forward')).toBe(false)
      expect(h.busy()).toBeNull()
    })

    it('WEDGE SAFETY: a dig that never settles times out, releases everything, and a later attempt runs', async () => {
      const h = harness(new FakeBot())
      bury(h.bot)
      h.bot.digImpl = () => new Promise<never>(() => {}) // the dead-connection dig
      h.watcher.check()
      h.watcher.check()
      expect(h.busy()).toBe('escape')
      await vi.advanceTimersByTimeAsync(25_001) // the race deadline, not the dig, ends it
      expect(phases(h)).toEqual(['trapped', 'escape_failed'])
      expect(h.emitted[1]!.detail).toMatch(/timed out after 25000ms/)
      expect(h.busy()).toBeNull() // the zombie promise no longer owns the body
      expect(h.bot.controls.get('forward')).toBe(false)
      // the session stays reusable: digging recovers, the next attempt really runs
      h.bot.digImpl = null
      await vi.advanceTimersByTimeAsync(15_001)
      h.watcher.check()
      await vi.advanceTimersByTimeAsync(1)
      expect(h.bot.digs).toEqual(['0,65,0', '0,64,0'])
      expect(phases(h)).toEqual(['trapped', 'escape_failed', 'escape_failed'])
    })
  })

  describe('coordination', () => {
    it('never starts an escape while an action owns the body', async () => {
      const h = harness(new FakeBot())
      bury(h.bot)
      h.setBusy('action')
      h.watcher.check()
      h.watcher.check() // trapped may be announced any time…
      await vi.advanceTimersByTimeAsync(60_000)
      h.watcher.check()
      await vi.advanceTimersByTimeAsync(1)
      expect(phases(h)).toEqual(['trapped']) // …but the reflex never took the controls
      expect(h.bot.digs).toEqual([])
      expect(h.stopMoving).not.toHaveBeenCalled()
      expect(h.busy()).toBe('action')
    })

    it('incidental freedom closes the episode with escaped and re-arms detection', () => {
      const h = harness(new FakeBot())
      bury(h.bot)
      h.setBusy('action') // suppress attempts — freedom must come from the world
      h.watcher.check()
      h.watcher.check()
      h.bot.set({ x: 0, y: 64, z: 0 }, 'air', 'empty')
      h.bot.set({ x: 0, y: 65, z: 0 }, 'air', 'empty')
      h.bot.set({ x: 0, y: 63, z: 0 }, 'stone', 'block')
      h.watcher.check()
      expect(phases(h)).toEqual(['trapped', 'escaped'])
      expect(h.emitted[1]!.detail).toMatch(/came free without digging after ~\d+s trapped/)
      bury(h.bot) // trapped again — a fresh episode demands two fresh hits
      h.watcher.check()
      expect(h.emitted).toHaveLength(2)
      h.watcher.check()
      expect(phases(h)).toEqual(['trapped', 'escaped', 'trapped'])
    })

    it('clear feet over a powder snow floor is NOT freedom — the episode holds', async () => {
      const h = harness(new FakeBot())
      bury(h.bot)
      h.setBusy('action')
      h.watcher.check()
      h.watcher.check()
      h.bot.set({ x: 0, y: 64, z: 0 }, 'air', 'empty')
      h.bot.set({ x: 0, y: 65, z: 0 }, 'air', 'empty') // cells clear, but the floor is still snow
      h.watcher.check()
      expect(phases(h)).toEqual(['trapped']) // still sinking — no escaped
    })
  })
})
