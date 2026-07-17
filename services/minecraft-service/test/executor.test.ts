import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '@civ/events/ts'
import { CommandExecutor, timeoutMessage, type ExecutorDeps, type SessionActions } from '../src/actions/executor.ts'

/** A completed single-block session in the SV-2 result shape. */
function gatherResult(blockType = 'oak_log', collected = 1) {
  return {
    resource: 'wood',
    requested: 1,
    collected,
    blocksDug: collected > 0 ? 1 : 0,
    attempts: 1,
    byType: collected > 0 ? { [blockType]: collected } : {},
    blockType,
    position: { x: 0, y: 64, z: 0 },
    stoppedEarly: null,
  }
}

/** A completed craft in the SV-3 result shape. */
function craftResult(itemName = 'oak_planks', crafted = 4) {
  return {
    item: 'planks',
    itemName,
    crafted,
    tableUsed: false,
    tablePlaced: false,
    position: { x: 0, y: 64, z: 0 },
  }
}

/** A completed hunt in the survival-reflexes result shape. */
function huntResult(target = 'cow', collected = 2) {
  return {
    animal: 'any',
    target,
    killed: true,
    collected,
    drops: (collected > 0 ? { beef: collected } : {}) as Record<string, number>,
    position: { x: 12, y: 64, z: -3 },
    chaseSeconds: 6,
    note: 'raw beef sates hunger, if poorly — your body eats from the pack by itself when hungry',
  }
}

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
    busy: null,
    moveTo: vi.fn(async () => ({ finalPosition: { x: 10, y: 64, z: 0 }, blocksTraveled: 10 })),
    chat: vi.fn(),
    gather: vi.fn(async () => gatherResult()),
    craft: vi.fn(async () => craftResult()),
    hunt: vi.fn(async () => huntResult()),
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
    maxCommandAgeMs: 600_000,
    ...overrides,
  }
  return { executor: new CommandExecutor(deps), outcomes, session, seen }
}

describe('CommandExecutor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stale commands drop with ActionFailed{STALE_COMMAND} before touching the world', async () => {
    const h = harness()
    const stale = command('chat', { message: 'hello from the distant past' })
    ;(stale as { occurredAt: string }).occurredAt = new Date(Date.now() - 3_600_000).toISOString()
    await h.executor.execute(stale)
    expect(h.session.chat).not.toHaveBeenCalled()
    expect(h.outcomes).toHaveLength(1)
    expect(h.outcomes[0]!.eventType).toBe('ActionFailed')
    expect(h.outcomes[0]!.extra.errorCode).toBe('STALE_COMMAND')
    expect(h.outcomes[0]!.extra.retryable).toBe(false)
  })

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
    // Prescriptive prose (SV-2), not the bare "no outcome within Nms" — the
    // villager reads this verbatim next tick and it must teach the fix.
    expect(h.outcomes[0]!.extra.errorMessage).toBe(timeoutMessage('move', 5_000))
    expect(h.session.stopMoving).toHaveBeenCalled()
    // THE WEDGE REGRESSION (2026-07-07, twice): execute() must RESOLVE once
    // the watchdog settles the command — a never-settling action promise
    // previously froze eachMessage and, with one partition, every bot.
    await expect(run).resolves.toBeUndefined()
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
      busy: null,
      moveTo: vi.fn(),
      chat: vi.fn(),
      gather: vi.fn(async () => gatherResult()),
      craft: vi.fn(async () => craftResult()),
      hunt: vi.fn(async () => huntResult()),
      stopMoving: vi.fn(),
    }
    const mover: SessionActions = {
      active: true,
      position: { x: 0, y: 64, z: 0 },
      busy: null,
      moveTo: vi.fn(async () => ({ finalPosition: { x: 49, y: 64, z: 50 }, blocksTraveled: 70 })),
      chat: vi.fn(),
      gather: vi.fn(async () => gatherResult()),
      craft: vi.fn(async () => craftResult()),
      hunt: vi.fn(async () => huntResult()),
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

  it('gather defaults to wood within 48 blocks, count 1 (the contract defaults) and completes with the yield', async () => {
    const h = harness()
    await h.executor.execute(command('gather'))
    expect(h.session.gather).toHaveBeenCalledWith('wood', 48, 1)
    expect(h.outcomes[0]!.eventType).toBe('ActionCompleted')
    const result = h.outcomes[0]!.extra.result as { blockType: string; collected: number }
    expect(result.blockType).toBe('oak_log')
  })

  it('gather clamps maxDistance and count to the contract bounds', async () => {
    const h = harness()
    await h.executor.execute(command('gather', { resource: 'stone', maxDistance: 999, count: 99 }))
    // The count cap (8) is load-bearing: a full session must fit inside the
    // per-verb timeout ceiling (TIMEOUT_TABLE_MAX_MS = 60s, ruling 2).
    expect(h.session.gather).toHaveBeenCalledWith('stone', 64, 8)
  })

  it('gather passes a sustained-session count through to the body', async () => {
    const h = harness()
    await h.executor.execute(command('gather', { resource: 'wood', count: 5 }))
    expect(h.session.gather).toHaveBeenCalledWith('wood', 48, 5)
  })

  it('an empty world is an honest RESOURCE_NOT_FOUND, retryable, with the prescriptive text passed through', async () => {
    const prescriptive = 'no wood within 10 blocks of (312, 120, -87) — try maxDistance 48 (the cap is 64), or move somewhere new first'
    const h = harness(
      {},
      {
        gather: vi.fn(async () => {
          const err = new Error(prescriptive)
          ;(err as Error & { code?: string }).code = 'RESOURCE_NOT_FOUND'
          throw err
        }),
      },
    )
    await h.executor.execute(command('gather'))
    expect(h.outcomes[0]!.extra.errorCode).toBe('RESOURCE_NOT_FOUND')
    expect(h.outcomes[0]!.extra.retryable).toBe(true)
    expect(h.outcomes[0]!.extra.errorMessage).toBe(prescriptive) // the villager reads this verbatim next tick
  })

  it('hunt passes family + clamped chase budget through and completes with the body result', async () => {
    const h = harness()
    await h.executor.execute(command('hunt', { animal: 'cow', maxDistance: 99 }))
    expect(h.session.hunt).toHaveBeenCalledWith('cow', 48)
    expect(h.outcomes[0]!.eventType).toBe('ActionCompleted')
    const result = h.outcomes[0]!.extra.result as { target: string; collected: number }
    expect(result.target).toBe('cow')
    expect(result.collected).toBe(2)
  })

  it('hunt defaults to any animal within 32 blocks (the contract defaults)', async () => {
    const h = harness()
    await h.executor.execute(command('hunt'))
    expect(h.session.hunt).toHaveBeenCalledWith('any', 32)
  })

  it('an escaped quarry is TARGET_ESCAPED, retryable, with the teaching prose verbatim', async () => {
    const prose = 'the cow outran your chase after 20s — wounded game keeps its wounds, so hunting it again may finish the job; a sword in hand also ends chases faster'
    const h = harness(
      {},
      {
        hunt: vi.fn(async () => {
          const err = new Error(prose) as Error & { code?: string; retryable?: boolean }
          err.code = 'TARGET_ESCAPED'
          err.retryable = true
          throw err
        }),
      },
    )
    await h.executor.execute(command('hunt', { animal: 'cow' }))
    expect(h.outcomes[0]!.extra.errorCode).toBe('TARGET_ESCAPED')
    expect(h.outcomes[0]!.extra.retryable).toBe(true)
    expect(h.outcomes[0]!.extra.errorMessage).toBe(prose)
  })

  it('a command during a meal fast-fails BODY_BUSY and never steals the claim (the bounce table)', async () => {
    const h = harness({}, { busy: 'eat' })
    await h.executor.execute(command('chat', { message: 'anyone there?' }))
    expect(h.session.chat).not.toHaveBeenCalled()
    expect(h.outcomes[0]!.eventType).toBe('ActionFailed')
    expect(h.outcomes[0]!.extra.errorCode).toBe('BODY_BUSY')
    expect(h.outcomes[0]!.extra.retryable).toBe(true)
    expect(h.session.busy).toBe('eat')
  })

  it('a command during combat fast-fails SELF_DEFENSE_IN_PROGRESS', async () => {
    const h = harness({}, { busy: 'combat' })
    await h.executor.execute(command('gather'))
    expect(h.session.gather).not.toHaveBeenCalled()
    expect(h.outcomes[0]!.extra.errorCode).toBe('SELF_DEFENSE_IN_PROGRESS')
    expect(h.outcomes[0]!.extra.retryable).toBe(true)
    expect(h.session.busy).toBe('combat')
  })

  it('a timed-out hunt reads as prescriptive prose', async () => {
    const h = harness(
      {},
      { hunt: vi.fn(() => new Promise<never>(() => {})) },
    )
    const run = h.executor.execute(command('hunt', {}, 5_000))
    await vi.advanceTimersByTimeAsync(5_001)
    await run
    expect(h.outcomes[0]!.extra.errorCode).toBe('TIMEOUT')
    const message = h.outcomes[0]!.extra.errorMessage as string
    expect(message).toContain('maxDistance')
    expect(message).not.toContain('no outcome within')
  })

  it('a command during an escape fast-fails HAZARD_ESCAPE_IN_PROGRESS without touching the bot', async () => {
    const h = harness({}, { busy: 'escape' })
    await h.executor.execute(command('chat', { message: 'anyone there?' }))
    expect(h.session.chat).not.toHaveBeenCalled()
    expect(h.outcomes).toHaveLength(1)
    expect(h.outcomes[0]!.eventType).toBe('ActionFailed')
    expect(h.outcomes[0]!.extra.errorCode).toBe('HAZARD_ESCAPE_IN_PROGRESS')
    expect(h.outcomes[0]!.extra.retryable).toBe(true)
    expect(h.session.busy).toBe('escape') // the reflex keeps its claim — we never stole it
  })

  it('claims busy=action for the command lifetime and releases it after', async () => {
    const h = harness()
    let observedBusy: SessionActions['busy'] = null
    ;(h.session.moveTo as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      observedBusy = h.session.busy
      return { finalPosition: { x: 10, y: 64, z: 0 }, blocksTraveled: 10 }
    })
    await h.executor.execute(command('move', { to: { x: 10, y: 64, z: 0 } }))
    expect(observedBusy).toBe('action')
    expect(h.session.busy).toBeNull()
  })

  it('releases busy even when the watchdog times the command out', async () => {
    const h = harness(
      {},
      { moveTo: vi.fn(() => new Promise<never>(() => {})) }, // hangs forever
    )
    const run = h.executor.execute(command('move', { to: { x: 100, y: 64, z: 0 } }, 5_000))
    await vi.advanceTimersByTimeAsync(5_001)
    await run
    expect(h.session.busy).toBeNull() // the zombie promise no longer owns the body
  })

  it('a timed-out gather reads as prescriptive prose that names the levers', async () => {
    const h = harness(
      {},
      { gather: vi.fn(() => new Promise<never>(() => {})) }, // a session that never settles
    )
    const run = h.executor.execute(command('gather', { resource: 'wood', count: 8 }, 5_000))
    await vi.advanceTimersByTimeAsync(5_001)
    await run
    expect(h.outcomes[0]!.extra.errorCode).toBe('TIMEOUT')
    const message = h.outcomes[0]!.extra.errorMessage as string
    expect(message).toContain('count') // the ask-for-less lever
    expect(message).toContain('maxDistance') // the nearer-target lever
    expect(message).not.toContain('no outcome within') // the bare M1 line is gone
  })

  it('craft passes the item through and completes with the body result', async () => {
    const h = harness()
    await h.executor.execute(command('craft', { item: 'planks' }))
    expect(h.session.craft).toHaveBeenCalledWith('planks')
    expect(h.outcomes[0]!.eventType).toBe('ActionCompleted')
    const result = h.outcomes[0]!.extra.result as { itemName: string; crafted: number }
    expect(result.itemName).toBe('oak_planks')
    expect(result.crafted).toBe(4)
  })

  it('craft without params.item is INVALID_PARAMS without touching the bot', async () => {
    const h = harness()
    await h.executor.execute(command('craft'))
    expect(h.session.craft).not.toHaveBeenCalled()
    expect(h.outcomes[0]!.eventType).toBe('ActionFailed')
    expect(h.outcomes[0]!.extra.errorCode).toBe('INVALID_PARAMS')
  })

  it('coded craft failures carry code, retryability, and the prescriptive prose verbatim', async () => {
    const prose = 'crafting wooden pickaxe needs a crafting table — none stands within 16 blocks and you carry none; craft a crafting_table first (4 planks of any wood)'
    const h = harness(
      {},
      {
        craft: vi.fn(async () => {
          const err = new Error(prose) as Error & { code?: string; retryable?: boolean }
          err.code = 'TOOL_REQUIRED'
          err.retryable = false
          throw err
        }),
      },
    )
    await h.executor.execute(command('craft', { item: 'wooden_pickaxe' }))
    expect(h.outcomes[0]!.eventType).toBe('ActionFailed')
    expect(h.outcomes[0]!.extra.errorCode).toBe('TOOL_REQUIRED')
    expect(h.outcomes[0]!.extra.retryable).toBe(false)
    expect(h.outcomes[0]!.extra.errorMessage).toBe(prose) // the villager reads this verbatim next tick
  })

  it('a timed-out craft reads as prescriptive prose that names the table walk', async () => {
    const h = harness(
      {},
      { craft: vi.fn(() => new Promise<never>(() => {})) }, // a craft that never settles
    )
    const run = h.executor.execute(command('craft', { item: 'furnace' }, 5_000))
    await vi.advanceTimersByTimeAsync(5_001)
    await run
    expect(h.outcomes[0]!.extra.errorCode).toBe('TIMEOUT')
    const message = h.outcomes[0]!.extra.errorMessage as string
    expect(message).toContain('crafting table')
    expect(message).not.toContain('no outcome within')
  })

  it('a dig that cannot drop (stone, empty hands) is TOOL_REQUIRED and NOT retryable', async () => {
    const h = harness(
      {},
      {
        gather: vi.fn(async () => {
          const err = new Error('digging stone bare-handed drops nothing — it needs a pickaxe and you carry none; gather wood or dirt instead')
          ;(err as Error & { code?: string }).code = 'TOOL_REQUIRED'
          throw err
        }),
      },
    )
    await h.executor.execute(command('gather', { resource: 'stone' }))
    expect(h.outcomes[0]!.eventType).toBe('ActionFailed')
    expect(h.outcomes[0]!.extra.errorCode).toBe('TOOL_REQUIRED')
    expect(h.outcomes[0]!.extra.retryable).toBe(false)
  })
})

describe('timeoutMessage', () => {
  it('speaks the budget in seconds, not milliseconds', () => {
    expect(timeoutMessage('move', 30_000)).toContain('30s')
  })

  it('an unknown verb still gets teaching prose, never the bare deadline', () => {
    const message = timeoutMessage('spawn', 30_000)
    expect(message).toContain("'spawn'")
    expect(message).toContain('smaller')
    expect(message).not.toContain('no outcome within 30000ms')
  })
})
