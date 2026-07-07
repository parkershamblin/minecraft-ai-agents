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

/** One directed edge from GET /villagers/{id}/relationships (agent-service). */
export interface RelationshipEdge {
  villagerId: string
  targetId: string
  affinity: number
  trust: number
  interactionCount: number
  lastReason: string | null
  lastReasonAt: string | null
  lastInteractionAt: string | null
  updatedAt: string
}

/** RelationshipChanged.v1 payload (packages/events/schemas/social). */
export interface RelationshipChangedPayload {
  villagerId: string
  targetId: string
  previousAffinity: number
  newAffinity: number
  previousTrust: number
  newTrust: number
  reason: string
  source: 'deliberation' | 'heuristic'
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
