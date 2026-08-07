// mineflayer-pathfinder rejects with bare `Error(string)` — no code, no class.
// Every one of those reaching the executor's catch-all became `INTERNAL`, and
// INTERNAL is substantive: three of them in a row abandoned the villager's
// intent. The ledger showed what that cost (2026-08-07, event_db, all history):
//
//   Took to long to decide path to goal!                   12,067
//   No path to the goal!                                    2,278
//   Digging aborted                                           207
//   The goal was changed before it could be completed!        125
//
// ~14.6k of the ~14.7k INTERNAL corpus was pathfinder prose, not executor
// faults — the class `docs/architecture/10-skill-tool-schema.md` §3.1 flagged
// and left undesigned. Two of those strings already had honest codes on the
// wire (PATH_NOT_FOUND, ABORTED) and were simply never mapped.
//
// This module is the single, pure translation layer. It lives at the ONE
// choke point every walk funnels through (the executor's catch) rather than
// at the ten-odd `pathfinder.goto` call sites, so a new call site is covered
// the day it is written.
import type { SkillFailureCode } from '../skills/types.ts'
import { isRetryable } from './skillVerbs.ts'

export interface ClassifiedPathfinderError {
  code: SkillFailureCode
  /** The villager's next percept — names the cause AND the move that could
   *  land differently, per the prescriptive-message rule. */
  message: string
  retryable: boolean
}

/**
 * Fragments are matched case-insensitively against the error message.
 *
 * `Took to long` is mineflayer-pathfinder's own spelling (sic — the typo is in
 * the upstream string); `too long` is matched alongside it so an upstream
 * spelling fix cannot silently reopen the 12k-event hole.
 */
const RULES: ReadonlyArray<{
  fragments: readonly string[]
  code: SkillFailureCode
  message: string
}> = [
  {
    // A* gave up inside its own compute budget. Says nothing about whether a
    // route exists — punishing the intent for it is what §3.1 called wrong.
    fragments: ['took to long to decide path', 'took too long to decide path'],
    code: 'PATH_SEARCH_EXHAUSTED',
    message:
      'the route search ran out of thinking time before it found a way there — ' +
      'this is a search budget, not a verdict on the target. Move to open ground ' +
      'nearer the goal and ask again, or pick a closer target.',
  },
  {
    // The world's verdict: no walkable route. Substantive and NOT retryable —
    // the identical command fails identically until the villager moves.
    fragments: ['no path to the goal'],
    code: 'PATH_NOT_FOUND',
    message:
      'no walkable route to that spot — it may be across water, underground, ' +
      'walled in, or off a cliff. Choose somewhere you can walk to, or clear ' +
      'a way there first.',
  },
  {
    // Our own stop() (watchdog, supersede, reflex preemption) or a newer goal.
    // Pure plumbing: the world never refused anything.
    fragments: [
      'goal was changed before it could be completed',
      'path was stopped before it could be completed',
      'digging aborted',
    ],
    code: 'ABORTED',
    message:
      'the movement was cut short by a newer order or a reflex — nothing about ' +
      'the task itself failed.',
  },
]

/**
 * Classify a raw thrown value from the pathfinder.
 *
 * Returns null for anything unrecognised — the caller must keep those as
 * INTERNAL. Guessing a tidy code for an unknown throw would hide a real
 * executor bug behind an honest-looking percept, the same rule that keeps
 * `runSkillVerb` from swallowing uncoded errors.
 */
export function classifyPathfinderError(err: unknown): ClassifiedPathfinderError | null {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!raw) return null
  const haystack = raw.toLowerCase()
  for (const rule of RULES) {
    if (rule.fragments.some((f) => haystack.includes(f))) {
      return { code: rule.code, message: rule.message, retryable: isRetryable(rule.code) }
    }
  }
  return null
}
