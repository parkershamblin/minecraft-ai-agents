import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '@civ/events/ts'
import { CommandExecutor, type ExecutorDeps, type SessionActions } from '../src/actions/executor.ts'

function command(action: string, params: Record<string, unknown> = {}, timeoutMs = 5_000): EventEnvelope {
  return {
    eventId: '019f8e2c-0000-7000-8000-00000000c001',
    eventType: 'ActionRequested',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    source: 'agent-service',
    aggregateType: 'Villager',
    aggregateId: 'elara-id',
    correlationId: '019f8e2c-0000-7000-8000-00000000cccc',
    causationId: null,
    payload: { commandId: '019f8e2c-0000-7000-8000-00000000c001', villagerId: 'elara-id', action, params, timeoutMs },
  } as EventEnvelope
}

interface Harness {
  executor: CommandExecutor
  outcomes: Array<{ eventType: string; extra: Record<string, unknown> }>
  session: SessionActions
  seen: Set<string>
}

function harness(overrides: Partial<ExecutorDeps> = {}, sessionOverrides: Partial<SessionActions> = {}): Harness {
  const outcomes: Harness['outcomes'] = []
  const seen = new Set<string>()
  const session: SessionActions = {
    active: true,
    position: { x: 0, y: 64, z: 0 },
    moveTo: vi.fn(async () => ({ finalPosition: { x: 10, y: 64, z: 0 }, blocksTraveled: 10 })),
    chat: vi.fn(),
    stopMoving: vi.fn(),
    ...sessionOverrides,
  }
  const deps: ExecutorDeps = {
    getSession: () => session,
    spawn: vi.fn(async () => ({ alreadyActive: false, spawnReason: 'seed' })),
    despawn: vi.fn(async () => true),
    isFresh: async (id) => {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    },
    publishOutcome: async (_command, eventType, extra) => {
      outcomes.push({ eventType, extra })
    },
    ...overrides,
  }
  return { executor: new CommandExecutor(deps), outcomes, session, seen }
}

describe('CommandExecutor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('duplicate commandIds never execute twice (idempotent executor)', async () => {
    const h = harness()
    await h.executor.execute(command('chat', { message: 'hello' }))
    await h.executor.execute(command('chat', { message: 'hello' })) // same commandId redelivered
    expect(h.session.chat).toHaveBeenCalledTimes(1)
    expect(h.outcomes).toHaveLength(1) // and only one outcome
  })

  it('watchdog emits ActionFailed{TIMEOUT} and cancels the action', async () => {
    const h = harness(
      {},
      { moveTo: vi.fn(() => new Promise<never>(() => {})) }, // hangs forever
    )
    const run = h.executor.execute(command('move', { to: { x: 100, y: 64, z: 0 } }, 5_000))
    await vi.advanceTimersByTimeAsync(5_001)
    expect(h.outcomes).toHaveLength(1)
    expect(h.outcomes[0]!.eventType).toBe('ActionFailed')
    expect(h.outcomes[0]!.extra.errorCode).toBe('TIMEOUT')
    expect(h.session.stopMoving).toHaveBeenCalled()
    void run // intentionally unresolved — the hanging promise never settles
  })

  it('a late completion after timeout is suppressed — exactly one outcome', async () => {
    let finish!: () => void
    const slow = new Promise<{ finalPosition: { x: number; y: number; z: number }; blocksTraveled: number }>(
      (resolve) => {
        finish = () => resolve({ finalPosition: { x: 5, y: 64, z: 0 }, blocksTraveled: 5 })
      },
    )
    const h = harness({}, { moveTo: vi.fn(() => slow) })
    const run = h.executor.execute(command('move', { to: { x: 5, y: 64, z: 0 } }, 1_000))
    await vi.advanceTimersByTimeAsync(1_001) // watchdog fires
    finish() // the walk "arrives" late
    await run
    expect(h.outcomes).toHaveLength(1)
    expect(h.outcomes[0]!.extra.errorCode).toBe('TIMEOUT')
  })

  it('completion clears the watchdog — one ActionCompleted, no late TIMEOUT', async () => {
    const h = harness()
    await h.executor.execute(command('move', { to: { x: 10, y: 64, z: 0 } }, 5_000))
    await vi.advanceTimersByTimeAsync(10_000) // long past the deadline
    expect(h.outcomes).toHaveLength(1)
    expect(h.outcomes[0]!.eventType).toBe('ActionCompleted')
    const result = h.outcomes[0]!.extra.result as { blocksTraveled: number }
    expect(result.blocksTraveled).toBe(10)
  })

  it('invalid params fail fast without touching the bot', async () => {
    const h = harness()
    await h.executor.execute(command('move', { to: { x: 'not-a-number' } }))
    expect(h.outcomes[0]!.eventType).toBe('ActionFailed')
    expect(h.outcomes[0]!.extra.errorCode).toBe('INVALID_PARAMS')
    expect(h.session.moveTo).not.toHaveBeenCalled()
  })

  it('no active session -> BOT_DISCONNECTED and retryable', async () => {
    const h = harness({ getSession: () => undefined })
    await h.executor.execute(command('chat', { message: 'anyone there?' }))
    expect(h.outcomes[0]!.extra.errorCode).toBe('BOT_DISCONNECTED')
    expect(h.outcomes[0]!.extra.retryable).toBe(true)
  })

  it('follow resolves the target position and moves within range', async () => {
    const target: SessionActions = {
      active: true,
      position: { x: 50, y: 64, z: 50 },
      moveTo: vi.fn(),
      chat: vi.fn(),
      stopMoving: vi.fn(),
    }
    const mover: SessionActions = {
      active: true,
      position: { x: 0, y: 64, z: 0 },
      moveTo: vi.fn(async () => ({ finalPosition: { x: 49, y: 64, z: 50 }, blocksTraveled: 70 })),
      chat: vi.fn(),
      stopMoving: vi.fn(),
    }
    const h = harness({ getSession: (id) => (id === 'bram-id' ? target : mover) })
    await h.executor.execute(command('follow', { targetVillagerId: 'bram-id', range: 2 }))
    expect(mover.moveTo).toHaveBeenCalledWith({ x: 50, y: 64, z: 50 }, 2)
    expect(h.outcomes[0]!.eventType).toBe('ActionCompleted')
  })

  it('idle terminates like every other command', async () => {
    const h = harness()
    await h.executor.execute(command('idle'))
    expect(h.outcomes[0]!.eventType).toBe('ActionCompleted')
  })

  it('gather is honestly NOT_IMPLEMENTED until M1', async () => {
    const h = harness()
    await h.executor.execute(command('gather'))
    expect(h.outcomes[0]!.extra.errorCode).toBe('NOT_IMPLEMENTED')
  })
})
