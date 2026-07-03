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
    await this.consumer.connect()
    await this.consumer.subscribe({ topic: 'commands.minecraft' })
    await this.consumer.run({
      partitionsConsumedConcurrently: 3,
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
