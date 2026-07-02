import { Kafka, type Consumer, logLevel } from 'kafkajs'
import type { EventEnvelope, ActionRequestedPayload } from '@civ/events/ts'
import { logger } from '../logging.ts'
import { commandsProcessed } from '../metrics.ts'
import { buildEnvelope } from '../events/envelope.ts'
import type { EventProducer } from '../kafka/producer.ts'
import type { BotRegistry } from '../bots/BotRegistry.ts'

/**
 * The single executor of commands.minecraft (consumer group
 * minecraft-service.command-executor). CIV-4 implements the session commands
 * (spawn/despawn); in-world actions (move/gather/chat/follow/idle) are CIV-5
 * and answer ActionFailed{NOT_IMPLEMENTED} until then — every command still
 * terminates in exactly one outcome.
 */
export class CommandConsumer {
  private consumer: Consumer

  constructor(
    brokers: string[],
    private readonly registry: BotRegistry,
    private readonly producer: EventProducer,
  ) {
    const kafka = new Kafka({ clientId: 'minecraft-service', brokers, logLevel: logLevel.WARN })
    this.consumer = kafka.consumer({ groupId: 'minecraft-service.command-executor' })
  }

  async start(): Promise<void> {
    await this.consumer.connect()
    await this.consumer.subscribe({ topic: 'commands.minecraft' })
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const raw = message.value?.toString()
        if (!raw) {
          return
        }
        let envelope: EventEnvelope
        try {
          envelope = JSON.parse(raw) as EventEnvelope
        } catch {
          logger.warn({ raw: raw.slice(0, 200) }, 'parked non-JSON command')
          return
        }
        if (envelope.eventType !== 'ActionRequested') {
          logger.warn({ eventType: envelope.eventType }, 'parked non-command on commands.minecraft')
          return
        }
        await this.execute(envelope)
      },
    })
    logger.info('command consumer running')
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect()
  }

  private async execute(command: EventEnvelope): Promise<void> {
    const payload = command.payload as unknown as ActionRequestedPayload
    const log = logger.child({ correlationId: command.correlationId, action: payload.action, commandId: payload.commandId })
    const startedAt = Date.now()

    const outcome = (eventType: 'ActionCompleted' | 'ActionFailed', extra: Record<string, unknown>) =>
      this.producer.publish(
        'world.events',
        buildEnvelope({
          eventType,
          aggregateId: payload.villagerId,
          correlationId: command.correlationId,
          causationId: command.eventId,
          payload: {
            commandId: payload.commandId,
            villagerId: payload.villagerId,
            action: payload.action,
            ...extra,
          },
        }),
      )

    try {
      switch (payload.action) {
        case 'spawn': {
          const params = payload.params as { minecraftUsername?: string }
          if (!params.minecraftUsername) {
            await outcome('ActionFailed', {
              errorCode: 'INVALID_PARAMS',
              errorMessage: 'spawn requires params.minecraftUsername',
              retryable: false,
            })
            commandsProcessed.inc({ action: payload.action, outcome: 'failed' })
            return
          }
          const result = await this.registry.spawn(payload.villagerId, params.minecraftUsername)
          await outcome('ActionCompleted', { result, durationMs: Date.now() - startedAt })
          commandsProcessed.inc({ action: payload.action, outcome: 'completed' })
          log.info({ result }, 'spawn completed')
          return
        }
        case 'despawn': {
          const existed = await this.registry.despawn(payload.villagerId)
          await outcome('ActionCompleted', { result: { existed }, durationMs: Date.now() - startedAt })
          commandsProcessed.inc({ action: payload.action, outcome: 'completed' })
          return
        }
        default: {
          await outcome('ActionFailed', {
            errorCode: 'NOT_IMPLEMENTED',
            errorMessage: `${payload.action} ships with CIV-5`,
            retryable: false,
          })
          commandsProcessed.inc({ action: payload.action, outcome: 'failed' })
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const timedOut = message.includes('timeout')
      await outcome('ActionFailed', {
        errorCode: timedOut ? 'TIMEOUT' : 'INTERNAL',
        errorMessage: message,
        retryable: true,
      })
      commandsProcessed.inc({ action: payload.action, outcome: 'failed' })
      log.error({ err: message }, 'command failed')
    }
  }
}
