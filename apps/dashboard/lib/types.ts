export interface Villager {
  id: string
  name: string
  minecraftUsername: string
  status: 'alive' | 'dead' | 'despawned'
  personality: {
    traits?: string[]
    values?: string[]
    speechStyle?: string
    quirks?: string[]
  }
  backstory?: string
}

/** The stored-event shape from event-service (envelope + ledger bookkeeping). */
export interface CivEvent {
  eventId: string
  eventType: string
  schemaVersion: number
  occurredAt: string
  recordedAt?: string
  source: string
  aggregateType: string
  aggregateId: string
  correlationId: string
  causationId: string | null
  topic: string
  payload: Record<string, unknown>
}
