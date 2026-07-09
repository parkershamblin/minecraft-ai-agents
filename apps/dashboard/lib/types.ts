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

/** Election shapes from government-service (GET /elections, /elections/{id}). */
export interface ElectionCandidate {
  candidateId: string
  villagerId: string
  platform: string | null
  registeredAt: string
  votes: number
}

export interface ElectionVote {
  voteId: string
  candidateId: string
  voterId: string
  reason: string | null
  castAt: string
}

export interface Election {
  electionId: string
  office: string
  status: 'scheduled' | 'nominating' | 'voting' | 'decided' | 'annulled'
  governmentId: string | null
  startsAt: string
  nominatingEndsAt: string
  endsAt: string
  winnerCandidateId: string | null
  winnerVillagerId: string | null
  annulledReason: string | null
  candidates: ElectionCandidate[]
  totalVotes: number
  votes: ElectionVote[] | null
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
