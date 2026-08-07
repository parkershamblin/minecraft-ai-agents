import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyPathfinderError } from '../src/world/pathfinderErrors.ts'

// Regression suite for the 2026-08-07 INTERNAL carve-out. Every string below
// is a VERBATIM mineflayer-pathfinder rejection counted in the live ledger
// (event_db, all history):
//   Took to long to decide path to goal!                12,067
//   No path to the goal!                                 2,278
//   Digging aborted                                        207
//   The goal was changed before it could be completed!     125
// All four arrived as INTERNAL — substantive — so ~14.6k infrastructure
// events were booking abandonment streaks against innocent intents.
describe('pathfinder error classification', () => {
  it('the 12,067-event string is PLUMBING and retryable — a search budget, not a verdict', () => {
    const c = classifyPathfinderError(new Error('Took to long to decide path to goal!'))
    expect(c?.code).toBe('PATH_SEARCH_EXHAUSTED')
    expect(c?.retryable).toBe(true)
  })

  it('survives an upstream fix of the "Took to long" typo', () => {
    // The misspelling is upstream's. If they ever correct it, the 12k-event
    // hole must not silently reopen.
    expect(classifyPathfinderError(new Error('Took too long to decide path to goal!'))?.code).toBe(
      'PATH_SEARCH_EXHAUSTED',
    )
  })

  it('"No path to the goal!" is the WORLD\'s verdict — substantive, not retryable', () => {
    const c = classifyPathfinderError(new Error('No path to the goal!'))
    expect(c?.code).toBe('PATH_NOT_FOUND')
    // The whole point of the split: same family, opposite retryability.
    expect(c?.retryable).toBe(false)
  })

  it('cancellation strings are ABORTED — our own stop(), not a refusal', () => {
    for (const raw of [
      'The goal was changed before it could be completed!',
      'Path was stopped before it could be completed! Thus, the goal was not reached.',
      'Digging aborted',
    ]) {
      expect(classifyPathfinderError(new Error(raw))?.code).toBe('ABORTED')
    }
  })

  it('every message names a cause AND something to do differently', () => {
    for (const raw of ['Took to long to decide path to goal!', 'No path to the goal!']) {
      const msg = classifyPathfinderError(new Error(raw))!.message
      expect(msg.length).toBeGreaterThan(40)
      expect(/move|choose|pick|clear/i.test(msg)).toBe(true)
    }
  })

  it('returns null for anything unrecognised — an unknown throw must stay INTERNAL', () => {
    // Hiding a real executor bug behind a tidy code is the failure mode this
    // guards; same rule that keeps runSkillVerb from swallowing uncoded throws.
    expect(classifyPathfinderError(new Error('cannot read id of undefined'))).toBeNull()
    expect(classifyPathfinderError(new Error(''))).toBeNull()
    expect(classifyPathfinderError(undefined)).toBeNull()
    expect(classifyPathfinderError({ weird: true })).toBeNull()
  })

  it('accepts a bare string throw, not just Error', () => {
    expect(classifyPathfinderError('No path to the goal!')?.code).toBe('PATH_NOT_FOUND')
  })

  it('every code it can emit is in the committed ActionFailed enum', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../../packages/events/schemas/world/ActionFailed.v1.schema.json', import.meta.url),
        'utf8',
      ),
    )
    const emitted = [
      'Took to long to decide path to goal!',
      'No path to the goal!',
      'Digging aborted',
    ].map((raw) => classifyPathfinderError(new Error(raw))!.code)
    for (const code of emitted) {
      expect(schema.properties.errorCode.enum).toContain(code)
    }
  })
})
