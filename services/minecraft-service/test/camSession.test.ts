import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Bot } from 'mineflayer'
import { CamSession, type CamDeps } from '../src/pov/camSession.ts'
import type { CamAssignment } from '../src/pov/roster.ts'
import type { RconGate } from '../src/pov/rconGate.ts'

const assignment: CamAssignment = { racer: 'Elara', camName: 'pov_cam_1', port: 3100, index: 0 }

interface FakeBot extends EventEmitter {
  physicsEnabled: boolean
  entity: { position: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void }; yaw: number; pitch: number; onGround: boolean }
  players: Record<string, { entity?: { position: { x: number; y: number; z: number }; yaw: number; pitch: number } } | undefined>
  viewer?: { close: () => void }
  quit: () => void
  closedCount: () => number
  quitCount: () => number
}

const fakeBot = (): FakeBot => {
  const bot = new EventEmitter() as FakeBot
  let closed = 0
  let quits = 0
  const pos = {
    x: 0,
    y: 0,
    z: 0,
    set(x: number, y: number, z: number) {
      this.x = x
      this.y = y
      this.z = z
    },
  }
  bot.physicsEnabled = true
  bot.entity = { position: pos, yaw: 0, pitch: 0, onGround: true }
  bot.players = {}
  bot.viewer = { close: () => void closed++ }
  bot.quit = () => void quits++
  bot.closedCount = () => closed
  bot.quitCount = () => quits
  return bot
}

const fakeRcon = (over: Partial<RconGate> = {}): RconGate & { tpCalls: string[][] } => {
  const tpCalls: string[][] = []
  return {
    exec: vi.fn(async () => ''),
    ensureSpectator: vi.fn(async () => true),
    tp: vi.fn(async (cam: string, target: string) => {
      tpCalls.push([cam, target])
    }),
    close: vi.fn(),
    tpCalls,
    ...over,
  }
}

const harness = (depsOver: Partial<CamDeps> = {}) => {
  const bots: FakeBot[] = []
  const rcon = fakeRcon(depsOver.rcon ? (depsOver.rcon as never) : {})
  const viewerAttach = vi.fn()
  const deps: CamDeps = {
    createBot: () => {
      const bot = fakeBot()
      bots.push(bot)
      return bot as unknown as Bot
    },
    loadViewer: vi.fn(async () => ({ mineflayer: viewerAttach })),
    rcon,
    viewDistance: 4,
    ...depsOver,
  }
  const session = new CamSession(assignment, deps)
  return { session, bots, rcon, viewerAttach, deps }
}

// flush the microtask chain behind fake timers (async onSpawn)
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CamSession', () => {
  it('never attaches the viewer before spectator gamemode is verified', async () => {
    const { session, bots, viewerAttach, rcon } = harness({
      rcon: fakeRcon({ ensureSpectator: vi.fn(async () => false) }),
    })
    session.start()
    bots[0]!.emit('spawn')
    await flush()
    expect(viewerAttach).not.toHaveBeenCalled()
    expect(session.state).toBe('failed_spectator')
    expect(rcon.ensureSpectator).toHaveBeenCalledWith('pov_cam_1')
  })

  it('retries the spectator gate on a 60s cycle while failed', async () => {
    const ensureSpectator = vi.fn(async () => false)
    const { session, bots } = harness({ rcon: fakeRcon({ ensureSpectator }) })
    session.start()
    bots[0]!.emit('spawn')
    await flush()
    expect(ensureSpectator).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(ensureSpectator).toHaveBeenCalledTimes(2)
    expect(session.state).toBe('failed_spectator')
  })

  it('verified spectator → ghost mode + viewer attached on the assigned port', async () => {
    const { session, bots, viewerAttach } = harness()
    session.start()
    bots[0]!.emit('spawn')
    await flush()
    expect(bots[0]!.physicsEnabled).toBe(false)
    expect(viewerAttach).toHaveBeenCalledWith(bots[0], { port: 3100, firstPerson: true, viewDistance: 4 })
    expect(session.state).toBe('acquiring')
  })

  it('tracking copies the racer eye view onto the cam with a forward offset', async () => {
    const { session, bots } = harness()
    session.start()
    const bot = bots[0]!
    bot.emit('spawn')
    await flush()
    bot.players.Elara = { entity: { position: { x: 10, y: 64, z: -5 }, yaw: 0, pitch: 0 } }
    await vi.advanceTimersByTimeAsync(100)
    expect(session.state).toBe('tracking')
    // yaw 0, pitch 0 → forward is -z in mineflayer's basis
    expect(bot.entity.position.x).toBeCloseTo(10)
    expect(bot.entity.position.y).toBeCloseTo(64 + 1.62)
    expect(bot.entity.position.z).toBeCloseTo(-5 - 0.6)
    expect(bot.entity.yaw).toBe(0)
    expect(bot.entity.onGround).toBe(false)
    expect(session.lastMoveTs).not.toBeNull()
  })

  it('racer online but out of range → rescue tp, throttled to one per 5s', async () => {
    const { session, bots, rcon } = harness()
    session.start()
    const bot = bots[0]!
    bot.emit('spawn')
    await flush()
    bot.players.Elara = {} // in tab list, no entity
    await vi.advanceTimersByTimeAsync(2_000) // 20 follow ticks
    expect(session.state).toBe('acquiring')
    expect(rcon.tp).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_100)
    expect(rcon.tp).toHaveBeenCalledTimes(2)
  })

  it('racer offline → idle, zero tp spam', async () => {
    const { session, bots, rcon } = harness()
    session.start()
    const bot = bots[0]!
    bot.emit('spawn')
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(session.state).toBe('idle')
    expect(rcon.tp).not.toHaveBeenCalled()
  })

  it("'end' closes the viewer (frees the port) and reconnects with backoff", async () => {
    const { session, bots } = harness()
    session.start()
    const first = bots[0]!
    first.emit('spawn')
    await flush()
    first.emit('end', 'socketClosed')
    expect(first.closedCount()).toBe(1)
    expect(session.state).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(bots).toHaveLength(2) // reconnected with a fresh bot
  })

  it('stop() is idempotent and quits the bot without reconnecting', async () => {
    const { session, bots } = harness()
    session.start()
    const bot = bots[0]!
    bot.emit('spawn')
    await flush()
    session.stop()
    session.stop()
    expect(bot.quitCount()).toBe(1)
    expect(session.state).toBe('stopped')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(bots).toHaveLength(1) // no reconnect after stop
  })

  it('a viewer attach failure leaves the tile dark but the cam session alive', async () => {
    const { session, bots } = harness({
      loadViewer: vi.fn(async () => {
        throw new Error('EADDRINUSE :3100')
      }),
    })
    session.start()
    const bot = bots[0]!
    bot.emit('spawn')
    await flush()
    expect(session.state).toBe('acquiring') // follow loop still runs
    bot.players.Elara = { entity: { position: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 0 } }
    await vi.advanceTimersByTimeAsync(100)
    expect(session.state).toBe('tracking')
  })
})
