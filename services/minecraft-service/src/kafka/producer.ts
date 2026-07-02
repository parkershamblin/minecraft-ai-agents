import { Kafka, type Producer, logLevel } from 'kafkajs'
import type { EventEnvelope } from '@civ/events/ts'
import { logger } from '../logging.ts'
import { worldEventsEmitted } from '../metrics.ts'

export class EventProducer {
  private producer: Producer

  constructor(brokers: string[]) {
    const kafka = new Kafka({ clientId: 'minecraft-service', brokers, logLevel: logLevel.WARN })
    this.producer = kafka.producer({ allowAutoTopicCreation: true })
  }

  async connect(): Promise<void> {
    await this.producer.connect()
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect()
  }

  /** Publish one envelope; key = aggregateId keeps per-villager ordering. */
  async publish(topic: string, envelope: EventEnvelope): Promise<void> {
    await this.producer.send({
      topic,
      messages: [{ key: envelope.aggregateId, value: JSON.stringify(envelope) }],
    })
    worldEventsEmitted.inc({ type: envelope.eventType })
    logger.debug({ topic, eventType: envelope.eventType, eventId: envelope.eventId }, 'published')
  }
}
