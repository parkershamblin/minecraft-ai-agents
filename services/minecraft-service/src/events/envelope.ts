import { v7 as uuidv7 } from 'uuid'
import type { EventEnvelope } from '@civ/events/ts'

// The envelope builder lives here until a second TS producer exists, at which
// point it graduates to packages/shared-ts (recorded in the architecture docs).

export interface EnvelopeInput {
  eventType: string
  aggregateId: string
  payload: Record<string, unknown>
  correlationId?: string
  causationId?: string | null
  aggregateType?: string
}

export function buildEnvelope(input: EnvelopeInput): EventEnvelope {
  return {
    eventId: uuidv7(),
    eventType: input.eventType,
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    source: 'minecraft-service',
    aggregateType: input.aggregateType ?? 'Villager',
    aggregateId: input.aggregateId,
    correlationId: input.correlationId ?? uuidv7(),
    causationId: input.causationId ?? null,
    payload: input.payload,
  } as EventEnvelope
}
