import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from '@civ/events/ts'
import { AttemptTracker, MILESTONES, deriveMilestones } from '../src/attempt/attemptTracker.ts'
import { buildEnvelope } from '../src/events/envelope.ts'

const RED = ['red-1', 'red-2', 'red-3']
const BLUE = ['blue-1', 'blue-2', 'blue-3']
const TEAMS = [
  { teamId: 'red', villagerIds: RED },
  { teamId: 'blue', villagerIds: BLUE },
]

function worldEvent(eventType: string, villagerId: string, payload: Record<string, unknown>): EventEnvelope {
  return buildEnvelope({ eventType, aggregateId: villagerId, payload: { villagerId, ...payload } })
}

const gathered = (villagerId: string, resourceType: string, quantity = 1) =>
  worldEvent('ResourceGathered', villagerId, { resourceType, quantity, position: { x: 0, y: 60, z: 0 } })

const crafted = (villagerId: string, result: Record<string, unknown>) =>
  worldEvent('ActionCompleted', villagerId, { commandId: 'c', action: 'craft', result, durationMs: 100 })

function harness() {
  const published: EventEnvelope[] = []
  const tracker = new AttemptTracker((envelope) => published.push(envelope))
  return { tracker, published }
}

describe('contract tripwire', () => {
  it('the mapper emits exactly the committed milestone enum', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../../packages/events/schemas/world/ProgressionMilestone.v1.schema.json', import.meta.url),
        'utf8',
      ),
    )
    expect([...MILESTONES]).toEqual(schema.properties.milestone.enum)
  })
})

describe('deriveMilestones', () => {
  it('coal and iron blocks map to their firsts; other resources map to nothing', () => {
    expect(deriveMilestones(gathered('v', 'deepslate_coal_ore', 2))[0]?.milestone).toBe('first_coal')
    expect(deriveMilestones(gathered('v', 'iron_ore', 1))[0]?.milestone).toBe('first_iron_ore')
    expect(deriveMilestones(gathered('v', 'oak_log', 4))).toEqual([])
  })

  it('a zero-yield ghost dig earns nothing (the honesty rule)', () => {
    expect(deriveMilestones(gathered('v', 'iron_ore', 0))).toEqual([])
  })

  it('one chain-resolution craft can cross three milestones, in ladder order', () => {
    const milestones = deriveMilestones(
      crafted('v', { item: 'iron_pickaxe', crafted: 1, smelted: 3, furnacePlaced: true, furnaceUsed: true }),
    ).map((m) => m.milestone)
    expect(milestones).toEqual(['furnace_placed', 'first_ingot', 'iron_pickaxe'])
  })

  it('a looted pickaxe can never win: only craft completions derive iron_pickaxe', () => {
    expect(deriveMilestones(worldEvent('ActionCompleted', 'v', { action: 'gather', result: { item: 'iron_pickaxe' } }))).toEqual([])
    expect(deriveMilestones(crafted('v', { item: 'iron_pickaxe', crafted: 0 }))).toEqual([])
  })

  // Attempt 5b, live: three red furnaces crafted-to-carry (the path the race
  // prompt teaches), zero rungs lit — the mapper only honored the placement
  // route. All three honest routes must cross furnace_placed.
  it('crafting a furnace to carry crosses furnace_placed', () => {
    const derived = deriveMilestones(crafted('v', { item: 'furnace', crafted: 1, furnacePlaced: false, furnaceUsed: false }))
    expect(derived.map((m) => m.milestone)).toEqual(['furnace_placed'])
    expect(derived[0]!.detail).toBe('crafted a furnace')
  })

  it('reusing a found furnace during a smelt crosses furnace_placed (never a 4/5 win)', () => {
    const derived = deriveMilestones(
      crafted('v', { item: 'iron_pickaxe', crafted: 1, smelted: 3, furnacePlaced: false, furnaceUsed: true }),
    ).map((m) => m.milestone)
    expect(derived).toEqual(['furnace_placed', 'first_ingot', 'iron_pickaxe'])
  })

  it('a furnace craft that yields nothing earns nothing', () => {
    expect(deriveMilestones(crafted('v', { item: 'furnace', crafted: 0 }))).toEqual([])
  })
})

describe('AttemptTracker', () => {
  it('start emits AttemptStarted with the embedded roster on the Attempt aggregate', async () => {
    const h = harness()
    const envelope = await h.tracker.start({ label: 'drill-1', difficulty: 'easy', teams: TEAMS })
    expect(envelope.eventType).toBe('AttemptStarted')
    expect(envelope.aggregateType).toBe('Attempt')
    expect(h.published).toEqual([envelope])
    expect((envelope.payload as { teams: unknown }).teams).toEqual(TEAMS)
  })

  it('milestones fire once per team, dedupe within the attempt, and ignore non-roster villagers', async () => {
    const h = harness()
    await h.tracker.start({ label: null, difficulty: 'easy', teams: TEAMS })
    h.tracker.observe(gathered('red-1', 'coal_ore'))
    h.tracker.observe(gathered('red-2', 'coal_ore')) // second coal for red — silent
    h.tracker.observe(gathered('blue-3', 'coal_ore')) // blue's own first — fires
    h.tracker.observe(gathered('stranger', 'coal_ore')) // spectators don't score
    const milestones = h.published.filter((e) => e.eventType === 'ProgressionMilestone')
    expect(milestones.map((e) => (e.payload as { teamId: string }).teamId)).toEqual(['red', 'blue'])
  })

  it('milestone envelopes point at their source event (causationId) and share its correlationId', async () => {
    const h = harness()
    await h.tracker.start({ label: null, difficulty: 'easy', teams: TEAMS })
    const source = gathered('red-1', 'iron_ore', 2)
    h.tracker.observe(source)
    const milestone = h.published.find((e) => e.eventType === 'ProgressionMilestone')!
    expect(milestone.causationId).toBe(source.eventId)
    expect(milestone.correlationId).toBe(source.correlationId)
    expect(milestone.aggregateId).toBe((h.tracker.status() as { attemptId: string }).attemptId)
  })

  it('the iron_pickaxe milestone records the win with the ledger-proof pointer', async () => {
    const h = harness()
    await h.tracker.start({ label: null, difficulty: 'normal', teams: TEAMS })
    const winning = crafted('blue-2', { item: 'iron_pickaxe', crafted: 1, smelted: 3, furnacePlaced: true })
    h.tracker.observe(winning)
    const status = h.tracker.status() as { win: { teamId: string; eventId: string } }
    expect(status.win.teamId).toBe('blue')
    expect(status.win.eventId).toBe(winning.eventId)
  })

  it('end{won} carries the winning pointers and honest-race deltas, then clears the attempt', async () => {
    const h = harness()
    await h.tracker.start({ label: null, difficulty: 'normal', teams: TEAMS })
    const winning = crafted('red-3', { item: 'iron_pickaxe', crafted: 1 })
    h.tracker.observe(winning)
    const ended = h.tracker.end({ outcome: 'won', honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 } })
    expect(ended.payload).toMatchObject({
      outcome: 'won',
      winningTeamId: 'red',
      winningVillagerId: 'red-3',
      winningEventId: winning.eventId,
      honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 },
    })
    expect(h.tracker.status()).toEqual({ active: false })
  })

  it("end{won} without a recorded winning milestone is refused — 'won' is a ledger claim", async () => {
    const h = harness()
    await h.tracker.start({ label: null, difficulty: 'normal', teams: TEAMS })
    expect(() => h.tracker.end({ outcome: 'won', honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 } })).toThrow(
      /no iron_pickaxe milestone/,
    )
  })

  it('an aborted attempt reports null winners even when a win was recorded', async () => {
    const h = harness()
    await h.tracker.start({ label: null, difficulty: 'easy', teams: TEAMS })
    h.tracker.observe(crafted('red-1', { item: 'iron_pickaxe', crafted: 1 }))
    const ended = h.tracker.end({ outcome: 'aborted', honestRace: { budgetTrippedDelta: 1, fakeProviderDelta: 0 } })
    expect(ended.payload).toMatchObject({ outcome: 'aborted', winningTeamId: null, winningEventId: null })
  })

  it('observing with no attempt running is a no-op; double-start is refused', async () => {
    const h = harness()
    h.tracker.observe(gathered('red-1', 'coal_ore'))
    expect(h.published).toEqual([])
    await h.tracker.start({ label: null, difficulty: 'easy', teams: TEAMS })
    await expect(h.tracker.start({ label: null, difficulty: 'easy', teams: TEAMS })).rejects.toThrow(/already running/)
  })

  it('derived events never re-derive: a ProgressionMilestone observed back is silent', async () => {
    const h = harness()
    await h.tracker.start({ label: null, difficulty: 'easy', teams: TEAMS })
    h.tracker.observe(gathered('red-1', 'coal_ore'))
    const before = h.published.length
    for (const e of [...h.published]) {
      h.tracker.observe(e) // the producer hook feeds everything back, including milestones
    }
    expect(h.published.length).toBe(before)
  })

  it('the pre-start guard runs before AttemptStarted exists; a throwing guard refuses the start', async () => {
    const published: EventEnvelope[] = []
    let calls = 0
    const tracker = new AttemptTracker((envelope) => published.push(envelope), {
      preStartGuard: async () => {
        calls += 1
        expect(published).toEqual([]) // the guard always precedes the publish
        if (calls === 1) {
          throw new Error('ledger unreachable')
        }
      },
    })
    await expect(tracker.start({ label: null, difficulty: 'easy', teams: TEAMS })).rejects.toThrow(/ledger unreachable/)
    expect(published).toEqual([]) // a refused start leaves nothing in the ledger…
    expect(tracker.status()).toEqual({ active: false }) // …and no half-open attempt
    const envelope = await tracker.start({ label: null, difficulty: 'easy', teams: TEAMS })
    expect(calls).toBe(2)
    expect(published).toEqual([envelope])
  })

  it('remembers every attempt it closed — the sweep consults this to never double-abort', async () => {
    const h = harness()
    const started = await h.tracker.start({ label: null, difficulty: 'easy', teams: TEAMS })
    const attemptId = (started.payload as { attemptId: string }).attemptId
    expect(h.tracker.isCurrentOrClosed(attemptId)).toBe(true) // running now
    h.tracker.end({ outcome: 'aborted', honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 } })
    expect(h.tracker.isCurrentOrClosed(attemptId)).toBe(true) // ended here
    expect(h.tracker.isCurrentOrClosed('not-ours')).toBe(false)
    h.tracker.noteClosed('not-ours') // a swept orphan joins the same memory
    expect(h.tracker.isCurrentOrClosed('not-ours')).toBe(true)
  })
})
