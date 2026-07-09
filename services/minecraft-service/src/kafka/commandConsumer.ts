import { Kafka, type Consumer, logLevel } from 'kafkajs'
import type { EventEnvelope } from '@civ/events/ts'
import { logger } from '../logging.ts'
import type { CommandExecutor } from '../actions/executor.ts'

/**
 * The single executor group for commands.minecraft. Parses envelopes and hands
 * them to the CommandExecutor, which owns dedupe, the timeout watchdog, and
 * the exactly-one-outcome invariant. Partitions are consumed concurrently;
 * WITHIN a partition commands run sequentially — which is exactly the
 * per-villager ordering guarantee (partition key = villagerId).
 */
export class CommandConsumer {
  private consumer: Consumer

  constructor(
    brokers: string[],
    private readonly executor: CommandExecutor,
  ) {
    const kafka = new Kafka({ clientId: 'minecraft-service', brokers, logLevel: logLevel.WARN })
    this.consumer = kafka.consumer({ groupId: 'minecraft-service.command-executor' })
  }

  async start(): Promise<void> {
    // A consumer that dies quietly leaves a healthy-looking container with a
    // frozen world (M1-8's connect storm did exactly that). If kafkajs won't
    // self-restart, fail LOUD and let the restart policy recover — a restart
    // is visible in `docker ps`; a zombie isn't.
    this.consumer.on(this.consumer.events.CRASH, ({ payload }) => {
      logger.error({ err: payload.error?.message, willRestart: payload.restart }, 'kafka consumer crashed')
      if (!payload.restart) {
        process.exit(1)
      }
    })
    await this.consumer.connect()
    await this.consumer.subscribe({ topic: 'commands.minecraft' })
    await this.consumer.run({
      // Matches the provisioned partition count (M2-4, scripts/provision-topics.mjs)
      // so no partition ever waits behind another villager's slow action.
      partitionsConsumedConcurrently: 6,
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
        await this.executor.execute(envelope)
      },
    })
    logger.info('command consumer running')
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect()
  }
}
