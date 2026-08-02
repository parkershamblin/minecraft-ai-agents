import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Same CJS default-import discipline as BotSession — identity-compare what
// wire() hands to loadPlugin against the very module objects it destructures.
import mineflayerPathfinder from 'mineflayer-pathfinder'
import mineflayerCollectBlock from 'mineflayer-collectblock'
import mineflayerTool from 'mineflayer-tool'
import mineflayerPvp from 'mineflayer-pvp'
import mineflayerAutoEat from 'mineflayer-auto-eat'
import armorManagerPlugin from 'mineflayer-armor-manager'
import { BotSession } from '../src/bots/BotSession.ts'
import { resolveReflexRouting } from '../src/bots/reflexRouting.ts'
import { EatWatcher } from '../src/bots/eat.ts'
import { ArmorWatcher } from '../src/bots/armor.ts'
import { FightSlots } from '../src/bots/combat.ts'
import { loadConfig } from '../src/config.ts'

const { pathfinder } = mineflayerPathfinder
const { plugin: collectBlockPlugin } = mineflayerCollectBlock
const { plugin: toolPlugin } = mineflayerTool
const { plugin: pvpPlugin } = mineflayerPvp
const { plugin: autoEatPlugin } = mineflayerAutoEat

describe('plugin import shapes', () => {
  it('every destructured plugin export is a real function (kills the vacuous toContain(undefined) pass)', () => {
    // If CJS interop ever resolved these to undefined, the identity
    // assertions below would still pass (loadPlugin(undefined) recorded on
    // both sides) while the live fleet crashed at connect. Pin the shape.
    for (const plugin of [pathfinder, collectBlockPlugin, toolPlugin, pvpPlugin, autoEatPlugin, armorManagerPlugin]) {
      expect(typeof plugin).toBe('function')
    }
  })
})

/** env shorthand: all five plugin flags at once */
const allFlags = (value: '0' | '1'): Record<string, string> => ({
  PLUGIN_COLLECTBLOCK: value,
  PLUGIN_TOOL: value,
  PLUGIN_PVP: value,
  PLUGIN_AUTO_EAT: value,
  PLUGIN_ARMOR_MANAGER: value,
})

/** The private seams this structural test drives — BotSession never connects
 *  a real bot here; wire()/the watcher starters are exercised directly. */
interface SessionInternals {
  wire(bot: unknown): void
  startEatWatch(): void
  startArmorWatch(): void
  stopSnapshots(): void
  eatTimer: NodeJS.Timeout | null
  eatWatcher: EatWatcher | null
  armorTimer: NodeJS.Timeout | null
  armorWatcher: ArmorWatcher | null
}

function makeFakeBot() {
  // Minimal _client so installProtocolErrorSuppression (wired first) can
  // wrap emit without needing a real minecraft-protocol connection.
  const listeners = new Map<string | symbol, Set<(...args: unknown[]) => void>>()
  const client = {
    emit(event: string | symbol, ...args: unknown[]): boolean {
      const set = listeners.get(event)
      if (!set) return false
      for (const fn of set) fn(...args)
      return true
    },
    on(event: string | symbol, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
      return client
    },
  }
  return {
    loadPlugin: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    _client: client,
  }
}

function makeSession(env: Record<string, string> = {}) {
  const config = loadConfig(env as NodeJS.ProcessEnv)
  const deps = {
    config,
    producer: { publish: vi.fn(async () => {}) },
    redis: { set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) },
    onChat: vi.fn(),
    others: () => [],
    fightSlots: new FightSlots(0),
  } as unknown as ConstructorParameters<typeof BotSession>[2]
  const session = new BotSession('villager-1', 'Elara', deps)
  return { session, internals: session as unknown as SessionInternals }
}

function loadedPlugins(bot: ReturnType<typeof makeFakeBot>): unknown[] {
  return bot.loadPlugin.mock.calls.map((call) => call[0])
}

describe('resolveReflexRouting', () => {
  it('all flags 1 routes everything to the plugin path', () => {
    expect(
      resolveReflexRouting({
        PLUGIN_COLLECTBLOCK: 1,
        PLUGIN_TOOL: 1,
        PLUGIN_PVP: 1,
        PLUGIN_AUTO_EAT: 1,
        PLUGIN_ARMOR_MANAGER: 1,
      }),
    ).toEqual({
      loadCollectBlock: true,
      loadTool: true,
      loadPvp: true,
      useAutoEatPlugin: true,
      useArmorManagerPlugin: true,
    })
  })

  it('all flags 0 routes everything to the hand-rolled fallback', () => {
    expect(
      resolveReflexRouting({
        PLUGIN_COLLECTBLOCK: 0,
        PLUGIN_TOOL: 0,
        PLUGIN_PVP: 0,
        PLUGIN_AUTO_EAT: 0,
        PLUGIN_ARMOR_MANAGER: 0,
      }),
    ).toEqual({
      loadCollectBlock: false,
      loadTool: false,
      loadPvp: false,
      useAutoEatPlugin: false,
      useArmorManagerPlugin: false,
    })
  })

  it('flags are independent — one off flips only its own route', () => {
    const routing = resolveReflexRouting({
      PLUGIN_COLLECTBLOCK: 1,
      PLUGIN_TOOL: 1,
      PLUGIN_PVP: 1,
      PLUGIN_AUTO_EAT: 0,
      PLUGIN_ARMOR_MANAGER: 1,
    })
    expect(routing.useAutoEatPlugin).toBe(false)
    expect(routing.loadCollectBlock).toBe(true)
    expect(routing.loadTool).toBe(true)
    expect(routing.loadPvp).toBe(true)
    expect(routing.useArmorManagerPlugin).toBe(true)
  })

  it('the config defaults are plugin-path ON (the owner decision)', () => {
    // loadConfig({}) = pure defaults; the plugin path must be the default.
    expect(resolveReflexRouting(loadConfig({} as NodeJS.ProcessEnv))).toEqual({
      loadCollectBlock: true,
      loadTool: true,
      loadPvp: true,
      useAutoEatPlugin: true,
      useArmorManagerPlugin: true,
    })
  })
})

describe('BotSession plugin wiring (structural — fake bot, no mineflayer connection)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flags ON: wire() loads pathfinder plus all five Tier 1 plugins', () => {
    const { internals } = makeSession() // defaults = all ON
    const bot = makeFakeBot()
    internals.wire(bot)
    const loaded = loadedPlugins(bot)
    expect(loaded[0]).toBe(pathfinder) // pathfinder stays first
    expect(loaded).toContain(collectBlockPlugin)
    expect(loaded).toContain(toolPlugin)
    expect(loaded).toContain(pvpPlugin)
    expect(loaded).toContain(autoEatPlugin)
    expect(loaded).toContain(armorManagerPlugin)
    expect(bot.loadPlugin).toHaveBeenCalledTimes(6)
    // 26.2 body reliability: PartialReadError tally is on the bot after wire()
    const withTally = bot as unknown as {
      getSuppressedProtocolErrors: () => { total: number; byPacket: Record<string, number> }
    }
    expect(typeof withTally.getSuppressedProtocolErrors).toBe('function')
    expect(withTally.getSuppressedProtocolErrors()).toEqual({ total: 0, byPacket: {} })
  })

  it('flags OFF: wire() loads pathfinder only', () => {
    const { internals } = makeSession(allFlags('0'))
    const bot = makeFakeBot()
    internals.wire(bot)
    expect(loadedPlugins(bot)).toEqual([pathfinder])
  })

  it('per-flag routing: only the flagged-off plugin is skipped', () => {
    const { internals } = makeSession({ PLUGIN_PVP: '0' })
    const bot = makeFakeBot()
    internals.wire(bot)
    const loaded = loadedPlugins(bot)
    expect(loaded).not.toContain(pvpPlugin)
    expect(loaded).toContain(collectBlockPlugin)
    expect(loaded).toContain(toolPlugin)
    expect(loaded).toContain(autoEatPlugin)
    expect(loaded).toContain(armorManagerPlugin)
  })

  it('PLUGIN_AUTO_EAT=1: the hand-rolled EatWatcher does NOT start, even with its interval configured', () => {
    // EAT_CHECK_INTERVAL_MS keeps its default (2000) — the plugin route must
    // win over the watcher's own enablement knob.
    const { internals } = makeSession()
    internals.startEatWatch()
    expect(internals.eatWatcher).toBeNull()
    expect(internals.eatTimer).toBeNull()
  })

  it('PLUGIN_AUTO_EAT=0: the hand-rolled EatWatcher starts exactly as before', () => {
    const { internals } = makeSession({ PLUGIN_AUTO_EAT: '0' })
    internals.startEatWatch()
    expect(internals.eatWatcher).toBeInstanceOf(EatWatcher)
    expect(internals.eatTimer).not.toBeNull()
    internals.stopSnapshots()
  })

  it('PLUGIN_ARMOR_MANAGER=1: the hand-rolled ArmorWatcher does NOT start', () => {
    const { internals } = makeSession()
    internals.startArmorWatch()
    expect(internals.armorWatcher).toBeNull()
    expect(internals.armorTimer).toBeNull()
  })

  it('PLUGIN_ARMOR_MANAGER=0: the hand-rolled ArmorWatcher starts exactly as before', () => {
    const { internals } = makeSession({ PLUGIN_ARMOR_MANAGER: '0' })
    internals.startArmorWatch()
    expect(internals.armorWatcher).toBeInstanceOf(ArmorWatcher)
    expect(internals.armorTimer).not.toBeNull()
    internals.stopSnapshots()
  })

  it('routing switches are independent: auto-eat off restores its watcher while armor stays on the plugin', () => {
    const { internals } = makeSession({ PLUGIN_AUTO_EAT: '0' })
    const bot = makeFakeBot()
    internals.wire(bot)
    internals.startEatWatch()
    internals.startArmorWatch()
    expect(loadedPlugins(bot)).not.toContain(autoEatPlugin)
    expect(loadedPlugins(bot)).toContain(armorManagerPlugin)
    expect(internals.eatWatcher).toBeInstanceOf(EatWatcher)
    expect(internals.armorWatcher).toBeNull()
    internals.stopSnapshots()
  })

  it('the auto-eat plugin path never claims the busy seam', () => {
    // The only code that ever mapped eating to busy ('eat') is the
    // EatWatcher; on the plugin route it is never constructed and no eat
    // interval exists — so nothing can claim busy on the villager's behalf.
    const { session, internals } = makeSession()
    const bot = makeFakeBot()
    internals.wire(bot)
    internals.startEatWatch()
    internals.startArmorWatch()
    vi.advanceTimersByTime(120_000)
    expect(session.busy).toBeNull()
    expect(internals.eatTimer).toBeNull()
    expect(internals.armorTimer).toBeNull()
  })
})
