// Mastery stats over skill invocation records — the bookkeeping that fixes
// Voyager's actual weakness: a skill frozen after one success, in a library
// that only ever grows. This table tracks success across DISTINCT contexts
// (biome × tool tier × day/night), trailing-vs-lifetime rates, and failure
// burden, so callers can tell "mastered" from "got lucky once in one forest"
// and aim refinement at the skills that hurt the most.
//
// Pure functions only: no I/O, no clock reads — records carry timestamps, and
// every result is deterministic given its inputs.

import type {
  SkillFailureCode,
  SkillInvocationContext,
  SkillInvocationRecord,
} from './types.ts'

// Exhaustiveness-checked mirror of the SkillFailureCode union: a member added
// to (or removed from) types.ts breaks this object at compile time, so the
// ledger adapter's 1:1 mapping can never silently drift from the vocabulary.
const ALL_FAILURE_CODES: Record<SkillFailureCode, null> = {
  RESOURCE_NOT_FOUND: null,
  PATH_NOT_FOUND: null,
  TOOL_REQUIRED: null,
  TOOL_TIER_REQUIRED: null,
  TIMEOUT: null,
  INTERNAL: null,
  UNSUPPORTED_NAME: null,
  RECIPE_UNAVAILABLE: null,
  MISSING_MATERIALS: null,
  PLACE_FAILED: null,
  CONTAINER_NOT_FOUND: null,
  TARGET_NOT_FOUND: null,
  INVENTORY_FULL: null,
  ABORTED: null,
}

const SKILL_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
  Object.keys(ALL_FAILURE_CODES),
)

// Canonical plumbing set, mirrored from agent-service's
// src/agent_service/brain/awareness.py (_PLUMBING_CODES) — different
// language, so copied rather than imported; keep the two in sync. These
// codes say nothing about the skill itself (the queue superseded it, the
// body was busy, the bot wasn't in the world), so counting them as skill
// failures would teach the table to distrust skills the world never
// actually refused.
const PLUMBING_CODES: ReadonlySet<string> = new Set([
  'SUPERSEDED',
  'STALE_COMMAND',
  'BODY_BUSY',
  'HAZARD_ESCAPE_IN_PROGRESS',
  'SELF_DEFENSE_IN_PROGRESS',
  'BOT_DISCONNECTED',
])

/**
 * True when a raw ledger errorCode is plumbing, not a substantive refusal.
 * Callers filter ledger events with this BEFORE seedFromLedger/foldStats —
 * after the adapter runs, unknown codes have collapsed into INTERNAL and the
 * original string is gone, so the filter cannot be applied later.
 */
export function isPlumbingCode(code: string): boolean {
  return PLUMBING_CODES.has(code)
}

export type ToolTier =
  | 'none'
  | 'wooden'
  | 'stone'
  | 'iron'
  | 'diamond'
  | 'netherite'
  | 'other'

const TOOL_TIER_PREFIXES: ReadonlySet<string> = new Set([
  'wooden',
  'stone',
  'iron',
  'diamond',
  'netherite',
])

function toolTier(heldTool: string | null): ToolTier {
  if (heldTool === null || heldTool === '') return 'none'
  const prefix = heldTool.split('_')[0] ?? heldTool
  return TOOL_TIER_PREFIXES.has(prefix) ? (prefix as ToolTier) : 'other'
}

function dayNight(timeOfDay: number): 'day' | 'night' {
  // Normalize raw world ticks into one MC day: 0-12000 day, 12001-23999 night.
  const t = ((timeOfDay % 24000) + 24000) % 24000
  return t <= 12000 ? 'day' : 'night'
}

/**
 * Coarse context bucket: biome × tool tier × day/night. Deliberately coarse —
 * mastery needs "worked in meaningfully different situations", not a fresh
 * bucket per coordinate. A null context (ledger-seeded history) is the single
 * bucket 'unknown', so seeded history alone can never demonstrate breadth.
 */
export function contextKey(ctx: SkillInvocationContext | null): string {
  if (ctx === null) return 'unknown'
  return `${ctx.biome ?? 'unknown'}|${toolTier(ctx.heldTool)}|${dayNight(ctx.timeOfDay)}`
}

export interface SkillStats {
  skill: string
  attempts: number
  successes: number
  successRate: number
  /** Success rate over the last windowSize records (chronological). */
  trailingRate: number
  meanCostMs: number
  /** Nearest-rank 90th percentile of costMs across all attempts. */
  p90CostMs: number
  /** Distinct context buckets seen across ALL attempts, failures included. */
  distinctContexts: number
  /** Successes per context bucket — the mastery evidence isMastered reads. */
  successesByContext: Map<string, number>
  failureCounts: Map<SkillFailureCode, number>
  lastAt: string
  firstAt: string
}

/**
 * Fold raw invocation records into per-skill stats. Records are ordered by
 * their own timestamps (stable on ties), so caller ordering never changes the
 * trailing window or firstAt/lastAt.
 */
export function foldStats(
  records: SkillInvocationRecord[],
  opts: { windowSize: number },
): Map<string, SkillStats> {
  const { windowSize } = opts
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new RangeError(`windowSize must be a positive integer, got ${windowSize}`)
  }

  const bySkill = new Map<string, SkillInvocationRecord[]>()
  for (const record of records) {
    const bucket = bySkill.get(record.skill)
    if (bucket) bucket.push(record)
    else bySkill.set(record.skill, [record])
  }

  const stats = new Map<string, SkillStats>()
  for (const [skill, rows] of bySkill) {
    const ordered = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    const attempts = ordered.length

    let successes = 0
    let costSum = 0
    const contexts = new Set<string>()
    const successesByContext = new Map<string, number>()
    const failureCounts = new Map<SkillFailureCode, number>()
    for (const row of ordered) {
      costSum += row.costMs
      const key = contextKey(row.context)
      contexts.add(key)
      if (row.ok) {
        successes += 1
        successesByContext.set(key, (successesByContext.get(key) ?? 0) + 1)
      } else {
        // A failure without a code is a bookkeeping anomaly; bucket it as
        // INTERNAL so failureCounts always totals attempts − successes.
        const code = row.failureCode ?? 'INTERNAL'
        failureCounts.set(code, (failureCounts.get(code) ?? 0) + 1)
      }
    }

    const window = ordered.slice(-windowSize)
    let windowSuccesses = 0
    for (const row of window) if (row.ok) windowSuccesses += 1

    const sortedCosts = ordered.map((row) => row.costMs).sort((a, b) => a - b)
    const p90Index = Math.ceil(0.9 * attempts) - 1

    stats.set(skill, {
      skill,
      attempts,
      successes,
      successRate: successes / attempts,
      trailingRate: windowSuccesses / window.length,
      meanCostMs: costSum / attempts,
      p90CostMs: sortedCosts[p90Index] ?? 0,
      distinctContexts: contexts.size,
      successesByContext,
      failureCounts,
      lastAt: ordered[attempts - 1]?.at ?? '',
      firstAt: ordered[0]?.at ?? '',
    })
  }
  return stats
}

/**
 * Mastery = succeeded at least minSuccesses times across at least minContexts
 * DISTINCT context buckets. Twenty successes in one forest is overfit, not
 * mastery. Only contexts that actually saw a success count — distinctContexts
 * includes failure-only buckets and deliberately does not qualify.
 */
export function isMastered(
  stats: SkillStats,
  opts: { minSuccesses: number; minContexts: number },
): boolean {
  return (
    stats.successes >= opts.minSuccesses &&
    stats.successesByContext.size >= opts.minContexts
  )
}

/**
 * Structural shape of the ledger events this adapter reads — defined locally
 * so stats.ts stays free of wire-type imports. Matches the fields it needs
 * from ActionCompleted/ActionFailed v1 payloads.
 */
export interface LedgerEventLike {
  eventType: 'ActionCompleted' | 'ActionFailed'
  occurredAt: string
  payload: {
    action: string
    durationMs?: number
    errorCode?: string
  }
}

const SEEDABLE_ACTIONS: ReadonlySet<string> = new Set(['gather', 'craft', 'hunt'])

function toFailureCode(errorCode: string | undefined): SkillFailureCode {
  if (errorCode !== undefined && SKILL_FAILURE_CODE_SET.has(errorCode)) {
    return errorCode as SkillFailureCode
  }
  // Wire codes outside the skill vocabulary (SMELT_FAILED, UNKNOWN_ACTION, …)
  // collapse to INTERNAL — the record type requires a SkillFailureCode.
  return 'INTERNAL'
}

/**
 * Seed the stats table from existing gather/craft/hunt ledger history.
 * Context is null for all seeded rows (history predates context capture), so
 * they share the single 'unknown' bucket and cannot fake context breadth.
 *
 * NOTE: plumbing failures (SUPERSEDED, STALE_COMMAND, BODY_BUSY, … — the
 * canonical set lives in agent-service's awareness.py) should be FILTERED OUT
 * by the caller before folding: drop ActionFailed events whose
 * payload.errorCode satisfies isPlumbingCode BEFORE calling this adapter,
 * because afterwards those codes have collapsed into INTERNAL.
 */
export function seedFromLedger(events: LedgerEventLike[]): SkillInvocationRecord[] {
  const records: SkillInvocationRecord[] = []
  for (const event of events) {
    if (!SEEDABLE_ACTIONS.has(event.payload.action)) continue
    const ok = event.eventType === 'ActionCompleted'
    records.push({
      skill: `ledger:${event.payload.action}`,
      at: event.occurredAt,
      ok,
      failureCode: ok ? null : toFailureCode(event.payload.errorCode),
      costMs: event.payload.durationMs ?? 0,
      context: null,
    })
  }
  return records
}

/**
 * Raw material for the refinement policy layer (policy.ts — owned elsewhere;
 * no ranking policy here). failureBurden = attempts × (1 − successRate), i.e.
 * the absolute failure count: a frequent skill failing moderately outranks a
 * rare skill failing always, because fixing it buys back more attempts.
 * Sorted descending by failureBurden; ties break by frequency then name so
 * the ordering is fully deterministic.
 */
export function refinementInputs(
  stats: Map<string, SkillStats>,
): Array<{ skill: string; frequency: number; failureBurden: number }> {
  const rows = [...stats.values()].map((s) => ({
    skill: s.skill,
    frequency: s.attempts,
    // attempts × (1 − successRate) algebraically — computed as the integer
    // attempts − successes so float error can never perturb the sort order.
    failureBurden: s.attempts - s.successes,
  }))
  rows.sort(
    (a, b) =>
      b.failureBurden - a.failureBurden ||
      b.frequency - a.frequency ||
      (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0),
  )
  return rows
}
