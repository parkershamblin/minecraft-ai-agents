import type { EventEnvelope, ActionRequestedPayload } from '@civ/events/ts'
import type { Position } from '../world/position.ts'
import { logger } from '../logging.ts'
import { commandsProcessed } from '../metrics.ts'

/** The slice of BotSession the executor drives — mockable in tests. */
export interface SessionActions {
  active: boolean
  position: Position | null
  moveTo(to: Position, range: number): Promise<{ finalPosition: Position; blocksTraveled: number }>
  chat(message: string): void
  stopMoving(): void
}

export interface ExecutorDeps {
  getSession(villagerId: string): SessionActions | undefined
  spawn(villagerId: string, username: string): Promise<{ alreadyActive: boolean; spawnReason: string }>
  despawn(villagerId: string): Promise<boolean>
  /** true = fresh commandId (now marked); false = duplicate delivery, skip */
  isFresh(commandId: string): Promise<boolean>
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

    const watchdog = setTimeout(() => {
      this.deps.getSession(payload.villagerId)?.stopMoving()
      commandsProcessed.inc({ action: payload.action, outcome: 'timeout' })
      log.warn({ timeoutMs: payload.timeoutMs }, 'command timed out — watchdog emitted the outcome')
      void outcome('ActionFailed', {
        errorCode: 'TIMEOUT',
        errorMessage: `no outcome within ${payload.timeoutMs}ms`,
        retryable: true,
      })
    }, payload.timeoutMs)

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
    } finally {
      clearTimeout(watchdog)
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
        throw new ActionError('NOT_IMPLEMENTED', 'gather ships with M1', false)
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
