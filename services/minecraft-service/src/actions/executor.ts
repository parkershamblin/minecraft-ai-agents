import type { EventEnvelope, ActionRequestedPayload } from '@civ/events/ts'
import type { Position } from '../world/position.ts'
import type { BusyState } from '../bots/hazard.ts'
import type { GatherResult } from '../bots/BotSession.ts'
import type { CraftResult } from '../world/crafting.ts'
import type { HuntResult } from '../world/hunting.ts'
import { logger } from '../logging.ts'
import { commandsProcessed } from '../metrics.ts'

/** The slice of BotSession the executor drives — mockable in tests. */
export interface SessionActions {
  active: boolean
  position: Position | null
  /** body ownership: 'action' while a command runs, 'escape' while the hazard
   *  reflex digs — the executor claims and releases the former here */
  busy: BusyState
  moveTo(to: Position, range: number): Promise<{ finalPosition: Position; blocksTraveled: number }>
  chat(message: string): void
  gather(resource: string, maxDistance: number, count: number): Promise<GatherResult>
  craft(item: string): Promise<CraftResult>
  hunt(animal: string, maxDistance: number): Promise<HuntResult>
  stopMoving(): void
}

export interface ExecutorDeps {
  getSession(villagerId: string): SessionActions | undefined
  spawn(villagerId: string, username: string): Promise<{ alreadyActive: boolean; spawnReason: string }>
  despawn(villagerId: string): Promise<boolean>
  /** true = fresh commandId (now marked); false = duplicate delivery, skip */
  isFresh(commandId: string): Promise<boolean>
  /** commands older than this are dead intents — dropped with STALE_COMMAND */
  maxCommandAgeMs: number
  /** watchdog ceiling: payload.timeoutMs is clamped to this — an oversized
   *  wire value must never pin the partition behind one body */
  maxTimeoutMs: number
  publishOutcome(
    command: EventEnvelope,
    eventType: 'ActionCompleted' | 'ActionFailed',
    extra: Record<string, unknown>,
  ): Promise<void>
}

class ActionError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

/** The reflex-ownership bounce table (SV-6): commands arriving while a
 *  reflex holds the body fast-fail with an honest, retryable, named reason.
 *  The messages are the villager's next percept — each teaches what the body
 *  is doing and when to try again. */
const BUSY_BOUNCE = {
  escape: {
    errorCode: 'HAZARD_ESCAPE_IN_PROGRESS',
    errorMessage: 'the body is busy digging itself out of powder snow — retry shortly',
    outcome: 'hazard_escape',
  },
  eat: {
    errorCode: 'BODY_BUSY',
    errorMessage: 'the body is busy eating — a few seconds at most; retry shortly',
    outcome: 'body_busy',
  },
  combat: {
    errorCode: 'SELF_DEFENSE_IN_PROGRESS',
    errorMessage: 'the body is fighting or fleeing a hostile — retry when the danger passes',
    outcome: 'self_defense',
  },
} as const

/**
 * Prescriptive TIMEOUT prose (SV-2). This string is the villager's next
 * percept — the M2-1 lesson applies: the diagnosis must carry the fix. The
 * bare "no outcome within Nms" taught nothing; counted gather sessions make
 * timeouts a normal part of ambition, so the message has to say what a
 * smaller ask looks like.
 */
export function timeoutMessage(action: string, timeoutMs: number): string {
  const budget = `${Math.round(timeoutMs / 1_000)}s`
  switch (action) {
    case 'gather':
      return `the gathering trip ran past its ${budget} limit and was called off mid-session — blocks already dug are in your pack even if unannounced; ask for fewer blocks (count) or a nearer target (smaller maxDistance), or move toward the resource first`
    case 'move':
    case 'follow':
      return `you did not arrive within ${budget} and stopped where you stood — the destination may be unreachable from here; pick a nearer or different spot and try again`
    case 'craft':
      return `the crafting errand ran past its ${budget} limit and was called off — if the walk to a crafting table ate the time, move nearer to one (or carry your own) and try again`
    case 'hunt':
      return `the hunt ran past its ${budget} limit and was called off — chase nearer game (smaller maxDistance) or move toward the herds before hunting`
    default:
      return `'${action}' ran past its ${budget} limit and was abandoned — try again with a smaller version of the same intent`
  }
}

/**
 * Executes one ActionRequested and guarantees the World invariant: every
 * command terminates in EXACTLY one ActionCompleted or ActionFailed. The
 * watchdog fires ActionFailed{TIMEOUT} at timeoutMs and cancels the action; a
 * `settled` latch suppresses any late outcome, so timeout + eventual
 * completion can never double-emit.
 */
export class CommandExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(command: EventEnvelope): Promise<void> {
    const payload = command.payload as unknown as ActionRequestedPayload
    const log = logger.child({
      correlationId: command.correlationId,
      commandId: payload.commandId,
      action: payload.action,
    })

    if (!(await this.deps.isFresh(payload.commandId))) {
      commandsProcessed.inc({ action: payload.action, outcome: 'duplicate' })
      log.info('duplicate command skipped (idempotent executor)')
      return
    }

    // Freshness guard: a command is an intent for NOW. Committed consumer
    // offsets survive crashes/redeploys, and dedupe only covers commands that
    // already executed — a stale-offset resume would otherwise replay the
    // past into the live world (the M1-8 connect storm killed the consumer
    // silently; the next boot replayed 3.5h of dead intents). Same failure
    // class as agent-service's percept guard, other topic.
    const ageMs = Date.now() - Date.parse(command.occurredAt)
    if (ageMs > this.deps.maxCommandAgeMs) {
      commandsProcessed.inc({ action: payload.action, outcome: 'stale' })
      log.warn({ ageMs }, 'stale command dropped — intent expired unexecuted')
      await this.deps.publishOutcome(command, 'ActionFailed', {
        commandId: payload.commandId,
        villagerId: payload.villagerId,
        action: payload.action,
        errorCode: 'STALE_COMMAND',
        errorMessage: `command aged ${Math.round(ageMs / 1_000)}s in the queue (max ${Math.round(this.deps.maxCommandAgeMs / 1_000)}s)`,
        retryable: false,
      })
      return
    }

    // A reflex owns the body for bounded stretches (≤ its own deadline).
    // Never queue behind one — the mind hears a retryable failure now
    // instead of a silent stall (a single-partition topic must never block
    // on one body). The BUSY_BOUNCE table names each reflex honestly:
    // "terrain trapped me" reads differently from "something is attacking me".
    const session = this.deps.getSession(payload.villagerId)
    const bounce = session?.busy ? BUSY_BOUNCE[session.busy as keyof typeof BUSY_BOUNCE] : undefined
    if (bounce) {
      commandsProcessed.inc({ action: payload.action, outcome: bounce.outcome })
      log.info({ busy: session?.busy }, 'command rejected — a reflex owns the body')
      await this.deps.publishOutcome(command, 'ActionFailed', {
        commandId: payload.commandId,
        villagerId: payload.villagerId,
        action: payload.action,
        errorCode: bounce.errorCode,
        errorMessage: bounce.errorMessage,
        retryable: true,
      })
      return
    }
    if (session) {
      session.busy = 'action' // claimed before any await — the reflex reads this between passes
    }

    const startedAt = Date.now()
    let settled = false
    /** @return false when a prior outcome already settled this command */
    const outcome = async (
      eventType: 'ActionCompleted' | 'ActionFailed',
      extra: Record<string, unknown>,
    ): Promise<boolean> => {
      if (settled) {
        return false
      }
      settled = true
      await this.deps.publishOutcome(command, eventType, {
        commandId: payload.commandId,
        villagerId: payload.villagerId,
        action: payload.action,
        ...extra,
      })
      return true
    }

    // The deadline is the wire value CLAMPED to the ceiling: timeoutMs comes
    // off the topic unvalidated, and one oversized value would hold the busy
    // claim — and the partition, and every partition-mate — for its whole
    // duration. The message speaks the applied deadline, not the ask.
    const timeoutMs = Math.min(payload.timeoutMs, this.deps.maxTimeoutMs)
    let watchdog: NodeJS.Timeout | undefined
    const watchdogFired = new Promise<void>((resolve) => {
      watchdog = setTimeout(() => {
        this.deps.getSession(payload.villagerId)?.stopMoving()
        commandsProcessed.inc({ action: payload.action, outcome: 'timeout' })
        log.warn({ timeoutMs }, 'command timed out — watchdog emitted the outcome')
        void outcome('ActionFailed', {
          errorCode: 'TIMEOUT',
          errorMessage: timeoutMessage(payload.action, timeoutMs),
          retryable: true,
        }).finally(resolve)
      }, timeoutMs)
    })

    // The action runs in its own closure that handles BOTH outcomes, so a
    // late settle after a timeout is silent (the latch suppresses it) and
    // can never produce an unhandled rejection.
    const running = (async () => {
      try {
        const result = await this.run(payload)
        if (await outcome('ActionCompleted', { result, durationMs: Date.now() - startedAt })) {
          commandsProcessed.inc({ action: payload.action, outcome: 'completed' })
          log.info({ durationMs: Date.now() - startedAt }, 'command completed')
        }
      } catch (err) {
        const failure =
          err instanceof ActionError
            ? err
            : new ActionError('INTERNAL', err instanceof Error ? err.message : String(err), true)
        const emitted = await outcome('ActionFailed', {
          errorCode: failure.errorCode,
          errorMessage: failure.message,
          retryable: failure.retryable,
        })
        if (emitted) {
          commandsProcessed.inc({ action: payload.action, outcome: 'failed' })
          log.warn({ errorCode: failure.errorCode, err: failure.message }, 'command failed')
        } // else: the watchdog already settled this command; the late error is expected fallout of cancellation
      }
    })()

    // Race, don't await: an action whose underlying promise NEVER settles (a
    // pathfinder mid-server-restart, a dead connection) must not wedge
    // eachMessage — one partition means one hung promise freezes EVERY bot
    // (it did, on 2026-07-07, twice). The watchdog emits the outcome; the
    // executor moves on; the zombie promise is abandoned by design.
    try {
      await Promise.race([running, watchdogFired])
    } finally {
      clearTimeout(watchdog)
      if (session) {
        session.busy = null // even on timeout — the abandoned zombie no longer owns the body
      }
    }
  }

  private async run(payload: ActionRequestedPayload): Promise<Record<string, unknown>> {
    switch (payload.action) {
      case 'spawn': {
        const { minecraftUsername } = payload.params as { minecraftUsername?: string }
        if (!minecraftUsername) {
          throw new ActionError('INVALID_PARAMS', 'spawn requires params.minecraftUsername', false)
        }
        return await this.deps.spawn(payload.villagerId, minecraftUsername)
      }
      case 'despawn': {
        return { existed: await this.deps.despawn(payload.villagerId) }
      }
      case 'move': {
        const session = this.requireSession(payload.villagerId)
        const { to, range } = payload.params as { to?: Position; range?: number }
        if (!to || typeof to.x !== 'number' || typeof to.y !== 'number' || typeof to.z !== 'number') {
          throw new ActionError('INVALID_PARAMS', 'move requires params.to {x,y,z}', false)
        }
        return await session.moveTo(to, range ?? 1)
      }
      case 'follow': {
        // One-shot follow: walk to within range of the target's CURRENT
        // position. Continuous shadowing is an agent-loop behavior (re-issued
        // per tick), not a never-terminating command.
        const session = this.requireSession(payload.villagerId)
        const { targetVillagerId, range } = payload.params as { targetVillagerId?: string; range?: number }
        if (!targetVillagerId) {
          throw new ActionError('INVALID_PARAMS', 'follow requires params.targetVillagerId', false)
        }
        const target = this.deps.getSession(targetVillagerId)
        if (!target?.active || !target.position) {
          throw new ActionError('PATH_NOT_FOUND', `target villager ${targetVillagerId} is not in the world`, true)
        }
        return { targetVillagerId, ...(await session.moveTo(target.position, range ?? 2)) }
      }
      case 'chat': {
        const session = this.requireSession(payload.villagerId)
        const { message } = payload.params as { message?: string }
        if (!message || message.length === 0 || message.length > 256) {
          throw new ActionError('INVALID_PARAMS', 'chat requires params.message (1..256 chars)', false)
        }
        session.chat(message)
        return { message }
      }
      case 'idle': {
        return { idled: true } // a deliberate choice to do nothing still terminates
      }
      case 'gather': {
        const session = this.requireSession(payload.villagerId)
        const { resource, maxDistance, count } = payload.params as {
          resource?: string
          maxDistance?: number
          count?: number
        }
        try {
          // Defaults mirror the contract (GatherParams): maxDistance 48
          // clamped 4..64, count 1 clamped 1..8 — the count cap is
          // load-bearing (a full session must fit inside the per-verb
          // timeout ceiling, TIMEOUT_TABLE_MAX_MS = 60s).
          return {
            ...(await session.gather(
              resource ?? 'wood',
              Math.min(Math.max(maxDistance ?? 48, 4), 64),
              Math.min(Math.max(Math.trunc(count ?? 1), 1), 8),
            )),
          }
        } catch (err) {
          const code = (err as Error & { code?: string }).code
          if (code === 'RESOURCE_NOT_FOUND') {
            // honest outcome: the world simply has none nearby — retryable
            // from a different spot on a future tick
            throw new ActionError('RESOURCE_NOT_FOUND', (err as Error).message, true)
          }
          if (code === 'TOOL_REQUIRED' || code === 'TOOL_TIER_REQUIRED') {
            // also honest, but NOT retryable: the same empty hands fail the
            // same way — the message says what would change that (for ores,
            // the tier ladder: which pickaxe to craft first)
            throw new ActionError(code, (err as Error).message, false)
          }
          throw err
        }
      }
      case 'craft': {
        const session = this.requireSession(payload.villagerId)
        const { item } = payload.params as { item?: string }
        if (!item || typeof item !== 'string') {
          throw new ActionError('INVALID_PARAMS', 'craft requires params.item — what to craft', false)
        }
        try {
          return { ...(await session.craft(item)) }
        } catch (err) {
          // The body throws coded, prescriptive failures (crafting.ts) —
          // pass code + retryability through untouched; the message is the
          // villager's next percept and must arrive verbatim.
          const { code, retryable } = err as Error & { code?: string; retryable?: boolean }
          if (code) {
            throw new ActionError(code, (err as Error).message, retryable ?? false)
          }
          throw err
        }
      }
      case 'hunt': {
        const session = this.requireSession(payload.villagerId)
        const { animal, maxDistance } = payload.params as { animal?: string; maxDistance?: number }
        try {
          // Defaults mirror the contract (HuntParams): animal 'any',
          // maxDistance 32 clamped 4..48 — a chase budget, not a sight limit.
          return {
            ...(await session.hunt(animal ?? 'any', Math.min(Math.max(maxDistance ?? 32, 4), 48))),
          }
        } catch (err) {
          const { code, retryable } = err as Error & { code?: string; retryable?: boolean }
          if (code) {
            throw new ActionError(code, (err as Error).message, retryable ?? false)
          }
          throw err
        }
      }
      default: {
        throw new ActionError('UNKNOWN_ACTION', `no handler for action '${payload.action}'`, false)
      }
    }
  }

  private requireSession(villagerId: string): SessionActions {
    const session = this.deps.getSession(villagerId)
    if (!session?.active) {
      throw new ActionError('BOT_DISCONNECTED', `no active bot session for villager ${villagerId}`, true)
    }
    return session
  }
}
