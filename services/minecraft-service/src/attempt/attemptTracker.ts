import { v7 as uuidv7 } from 'uuid'
import type { EventEnvelope } from '@civ/events/ts'
import { buildEnvelope } from '../events/envelope.ts'
import { progressionMilestones } from '../metrics.ts'

/**
 * The RB-1 attempt lifecycle + milestone mapper (ADR-10). One attempt is one
 * self-describing, replayable slice of the ledger: AttemptStarted carries the
 * roster, every ProgressionMilestone points (causationId) at the outcome
 * event that earned it, and AttemptEnded carries the honest-race deltas. The
 * mapper derives milestones from the service's OWN world.events at the
 * producer choke point — no second source of truth, so a milestone can never
 * disagree with the ledger it summarizes.
 */

/** The T1 ladder, canonical order. The contract enum, verbatim (tripwired). */
export const MILESTONES = ['first_coal', 'first_iron_ore', 'furnace_placed', 'first_ingot', 'iron_pickaxe'] as const
export type Milestone = (typeof MILESTONES)[number]

const COAL_BLOCKS = new Set(['coal_ore', 'deepslate_coal_ore'])
const IRON_BLOCKS = new Set(['iron_ore', 'deepslate_iron_ore'])

export interface DerivedMilestone {
  milestone: Milestone
  villagerId: string
  detail: string
}

/**
 * Which milestones one world event crosses, in ladder order. A single craft
 * can cross THREE (the chain-resolution places the furnace, smelts the first
 * ingots, and crafts the pickaxe inside one action) — the mapper emits each.
 * The iron_pickaxe rule reads ActionCompleted{action:craft} only, which
 * structurally excludes looted tools (the ADR's win-predicate argument).
 */
export function deriveMilestones(envelope: EventEnvelope): DerivedMilestone[] {
  const payload = envelope.payload as Record<string, unknown>
  if (envelope.eventType === 'ResourceGathered') {
    const { villagerId, resourceType, quantity } = payload as {
      villagerId: string
      resourceType: string
      quantity: number
    }
    if (quantity > 0 && COAL_BLOCKS.has(resourceType)) {
      return [{ milestone: 'first_coal', villagerId, detail: `mined coal (${quantity} from ${resourceType.replace(/_/g, ' ')})` }]
    }
    if (quantity > 0 && IRON_BLOCKS.has(resourceType)) {
      return [{ milestone: 'first_iron_ore', villagerId, detail: `mined iron ore (${quantity} raw iron from ${resourceType.replace(/_/g, ' ')})` }]
    }
    return []
  }
  if (envelope.eventType === 'ActionCompleted') {
    const { villagerId, action, result } = payload as {
      villagerId: string
      action: string
      result?: Record<string, unknown>
    }
    if (action !== 'craft' || !result) {
      return []
    }
    const out: DerivedMilestone[] = []
    // The rung means "this team has furnace access", and there are THREE
    // honest routes to it: the chain-resolution places one mid-craft
    // (furnacePlaced), the villager crafts one to carry (item: furnace —
    // the path the race prompt itself teaches, invisible on the scoreboard
    // until this line, caught live in attempt 5b), or the chain reuses a
    // furnace found in the world (furnaceUsed — without this, that path
    // would NEVER light the rung and the ladder would win at 4/5). The
    // per-team dedupe makes the overlap harmless.
    const craftedFurnace = result.item === 'furnace' && typeof result.crafted === 'number' && result.crafted > 0
    if (result.furnacePlaced === true || result.furnaceUsed === true || craftedFurnace) {
      const detail =
        result.furnacePlaced === true ? 'set up a furnace' : craftedFurnace ? 'crafted a furnace' : 'put a found furnace to work'
      out.push({ milestone: 'furnace_placed', villagerId, detail })
    }
    if (typeof result.smelted === 'number' && result.smelted > 0) {
      out.push({
        milestone: 'first_ingot',
        villagerId,
        detail: `smelted ${result.smelted} iron ingot${result.smelted === 1 ? '' : 's'}`,
      })
    }
    if (result.item === 'iron_pickaxe' && typeof result.crafted === 'number' && result.crafted > 0) {
      out.push({ milestone: 'iron_pickaxe', villagerId, detail: 'crafted an iron pickaxe — the winning craft' })
    }
    return out
  }
  return []
}

export interface TeamRoster {
  teamId: string
  villagerIds: string[]
}

export interface StartAttemptInput {
  label: string | null
  difficulty: string
  teams: TeamRoster[]
}

export interface HonestRaceDeltas {
  budgetTrippedDelta: number
  fakeProviderDelta: number
}

export interface EndAttemptInput {
  outcome: 'won' | 'stalled' | 'aborted'
  honestRace: HonestRaceDeltas
}

interface ActiveAttempt {
  attemptId: string
  label: string | null
  difficulty: string
  startedAtMs: number
  teams: TeamRoster[]
  teamOf: Map<string, string>
  /** `${teamId}:${milestone}` — 'first' means first for that team, this attempt */
  fired: Set<string>
  win: { teamId: string; villagerId: string; eventId: string; occurredAt: string } | null
}

export class AttemptTracker {
  private active: ActiveAttempt | null = null

  constructor(private readonly publish: (envelope: EventEnvelope) => void) {}

  /** For GET /internal/attempt — the harness polls this to spot the win. */
  status(): Record<string, unknown> {
    if (!this.active) {
      return { active: false }
    }
    return {
      active: true,
      attemptId: this.active.attemptId,
      label: this.active.label,
      difficulty: this.active.difficulty,
      startedAt: new Date(this.active.startedAtMs).toISOString(),
      teams: this.active.teams,
      milestones: [...this.active.fired].sort(),
      win: this.active.win,
    }
  }

  start(input: StartAttemptInput): EventEnvelope {
    if (this.active) {
      throw new Error(`attempt ${this.active.attemptId} is already running — end it first`)
    }
    const attemptId = uuidv7()
    this.active = {
      attemptId,
      label: input.label,
      difficulty: input.difficulty,
      startedAtMs: Date.now(),
      teams: input.teams,
      teamOf: new Map(input.teams.flatMap((team) => team.villagerIds.map((v) => [v, team.teamId] as const))),
      fired: new Set(),
      win: null,
    }
    const envelope = buildEnvelope({
      eventType: 'AttemptStarted',
      aggregateType: 'Attempt',
      aggregateId: attemptId,
      payload: { attemptId, label: input.label, difficulty: input.difficulty, teams: input.teams },
    })
    this.publish(envelope)
    return envelope
  }

  /**
   * Called for every published world event. Milestones publish back through
   * the same producer — safe because derived types (ProgressionMilestone,
   * Attempt*) never derive further milestones.
   */
  observe(envelope: EventEnvelope): void {
    const attempt = this.active
    if (!attempt) {
      return
    }
    for (const derived of deriveMilestones(envelope)) {
      const teamId = attempt.teamOf.get(derived.villagerId)
      if (!teamId) {
        continue // not on any roster — spectators don't score
      }
      const key = `${teamId}:${derived.milestone}`
      if (attempt.fired.has(key)) {
        continue
      }
      attempt.fired.add(key)
      progressionMilestones.inc({ milestone: derived.milestone, team: teamId })
      if (derived.milestone === 'iron_pickaxe' && !attempt.win) {
        // The win-proof pointer: the source ActionCompleted's eventId, with
        // occurredAt (and UUIDv7 order) as the tiebreak record.
        attempt.win = {
          teamId,
          villagerId: derived.villagerId,
          eventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
        }
      }
      this.publish(
        buildEnvelope({
          eventType: 'ProgressionMilestone',
          aggregateType: 'Attempt',
          aggregateId: attempt.attemptId,
          correlationId: envelope.correlationId,
          causationId: envelope.eventId,
          payload: {
            attemptId: attempt.attemptId,
            teamId,
            villagerId: derived.villagerId,
            milestone: derived.milestone,
            detail: derived.detail,
          },
        }),
      )
    }
  }

  end(input: EndAttemptInput): EventEnvelope {
    const attempt = this.active
    if (!attempt) {
      throw new Error('no attempt is running')
    }
    if (input.outcome === 'won' && !attempt.win) {
      // The honesty rule: 'won' is a ledger claim, not an operator opinion —
      // it requires the recorded winning milestone.
      throw new Error("outcome 'won' claimed but no iron_pickaxe milestone was recorded this attempt")
    }
    const win = input.outcome === 'won' ? attempt.win : null
    const envelope = buildEnvelope({
      eventType: 'AttemptEnded',
      aggregateType: 'Attempt',
      aggregateId: attempt.attemptId,
      payload: {
        attemptId: attempt.attemptId,
        outcome: input.outcome,
        winningTeamId: win?.teamId ?? null,
        winningVillagerId: win?.villagerId ?? null,
        winningEventId: win?.eventId ?? null,
        durationSeconds: Math.round((Date.now() - attempt.startedAtMs) / 100) / 10,
        honestRace: input.honestRace,
      },
    })
    this.active = null
    this.publish(envelope)
    return envelope
  }
}
