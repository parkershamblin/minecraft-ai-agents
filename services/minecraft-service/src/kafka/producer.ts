import { Kafka, type Producer, logLevel } from 'kafkajs'
import type { EventEnvelope } from '@civ/events/ts'
import { logger } from '../logging.ts'
import { worldEventsEmitted } from '../metrics.ts'

export class EventProducer {
  private producer: Producer
  private worldEventHook: ((envelope: EventEnvelope) => void) | null = null

  constructor(brokers: string[]) {
    const kafka = new Kafka({ clientId: 'minecraft-service', brokers, logLevel: logLevel.WARN })
    // Topics are provisioned by scripts/provision-topics.mjs — auto-creating
    // a 1-partition topic on a typo is the silent failure mode (the M2 plan's
    // partition-count lesson); a misprovisioned topic must fail loud instead.
    this.producer = kafka.producer({ allowAutoTopicCreation: false })
  }

  /** Observe every world.events publish (RB-1: the milestone mapper's single
   *  choke point — a milestone can only summarize what really reached the
   *  ledger). The hook must never throw into the publish path. */
  onWorldEvent(hook: (envelope: EventEnvelope) => void): void {
    this.worldEventHook = hook
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
      // acks=1 (leader ack): the local Redpanda is single-replica, so the
      // leader IS the full ISR — durability identical to the default acks=-1,
      // minus the extra round-trip on every world-fact publish.
      acks: 1,
      messages: [{ key: envelope.aggregateId, value: JSON.stringify(envelope) }],
    })
    worldEventsEmitted.inc({ type: envelope.eventType })
    logger.debug({ topic, eventType: envelope.eventType, eventId: envelope.eventId }, 'published')
    if (topic === 'world.events' && this.worldEventHook) {
      try {
        this.worldEventHook(envelope)
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'world-event hook failed — publish unaffected')
      }
    }
  }
}
