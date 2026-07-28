// Mastery selection policy — depth over breadth with an explicit escape
// hatch. Four pure rules over one stats table: a gate on the curriculum
// proposer, a refinement ranking, the superseded/broken split, and UCB1
// selection with a tunable novelty fraction, plus the retrieval ordering the
// schema layer consumes. No weights, no I/O, no Date.now() — the only entropy
// source is the injected rng, so every decision replays deterministically.
//
// This unit imports nothing from the kernel at runtime: it operates purely on
// aggregated stats rows. The row shape is declared STRUCTURALLY here —
// stats.ts (a parallel unit) owns the canonical table, aggregated from
// SkillInvocationRecord (src/skills/types.ts); TypeScript matches on shape,
// so the two files merge independently and the assembly commit reconciles
// nothing but names.

/**
 * Structural mirror of one mastery stats row. `successRate` is lifetime
 * successes/attempts; `trailingRate` is the success rate over the trailing
 * window stats.ts maintains (the freshness signal — a skill can be 0.8
 * lifetime and 0.1 lately, and the split below turns exactly on that).
 */
export interface SkillStatsLike {
  skill: string
  attempts: number
  successes: number
  successRate: number
  trailingRate: number
  meanCostMs: number
  distinctContexts: number
  lastAt: string // ISO-8601
  /**
   * Declared outcome family ("logs", "cooked_food", …). Two skills with the
   * same tag compete for the same slot in a plan; supersession is only
   * meaningful inside a tag — without one a skill can never be superseded.
   */
  outcomeTag?: string
}

/** UCB1 exploration constant when opts leave it unset. */
export const DEFAULT_EXPLORATION_BONUS = Math.SQRT2

/** System-default novelty fraction — an explicit knob, not emergent hope. */
export const DEFAULT_NOVELTY_FRACTION = 0.1

const attemptsOf = (stats: Map<string, SkillStatsLike>, skill: string): number =>
  stats.get(skill)?.attempts ?? 0

/**
 * UCB1 score: successRate + c * sqrt(ln(totalAttempts) / attempts).
 * Zero-attempt skills score +Infinity so each gets tried once before any
 * exploitation argument applies.
 */
function ucbScore(
  row: SkillStatsLike | undefined,
  totalAttempts: number,
  c: number,
): number {
  const attempts = row?.attempts ?? 0
  if (attempts === 0) return Number.POSITIVE_INFINITY
  const exploration =
    totalAttempts > 0 ? c * Math.sqrt(Math.log(totalAttempts) / attempts) : 0
  return (row?.successRate ?? 0) + exploration
}

// ---------------------------------------------------------------------------
// Rule 1 — mastery gate: a filter on the curriculum proposer's candidate list.
// ---------------------------------------------------------------------------

export interface MasteryGateOpts {
  /** trailingRate a goal-path skill must reach before new skills unlock */
  masteryThreshold: number
}

export interface MasteryGateResult {
  allowed: string[]
  blocked: Array<{ skill: string; reason: string }>
}

/**
 * Depth over breadth: while any ATTEMPTED goal-path skill's trailingRate sits
 * below masteryThreshold, new-skill candidates (zero attempts in stats) are
 * blocked; refining/repeating existing skills is always allowed. This is a
 * gate on the proposer, not a model change — blocked candidates come back
 * with a reason the curriculum can log.
 *
 * A goal-path skill with NO attempts does not hold the gate shut: gate
 * activation requires observed evidence, otherwise a never-attempted
 * goal-path skill would deadlock the curriculum (it could never be attempted
 * because it is itself a blocked new skill).
 */
export function masteryGate(
  candidates: string[],
  goalPathSkills: string[],
  stats: Map<string, SkillStatsLike>,
  opts: MasteryGateOpts,
): MasteryGateResult {
  const unmastered = goalPathSkills.filter((skill) => {
    const row = stats.get(skill)
    return (
      row !== undefined &&
      row.attempts > 0 &&
      row.trailingRate < opts.masteryThreshold
    )
  })
  if (unmastered.length === 0) {
    return { allowed: [...candidates], blocked: [] }
  }

  const allowed: string[] = []
  const blocked: Array<{ skill: string; reason: string }> = []
  const unmasteredList = unmastered.map((skill) => `"${skill}"`).join(', ')
  for (const candidate of candidates) {
    if (attemptsOf(stats, candidate) === 0) {
      blocked.push({
        skill: candidate,
        reason:
          `mastery gate: goal-path skill${unmastered.length > 1 ? 's' : ''} ` +
          `${unmasteredList} below trailingRate ${opts.masteryThreshold} — ` +
          'refine existing skills before adding new ones',
      })
    } else {
      allowed.push(candidate)
    }
  }
  return { allowed, blocked }
}

// ---------------------------------------------------------------------------
// Rule 2 — refinement queue: where practice pays off most.
// ---------------------------------------------------------------------------

/**
 * Ranked by burden = invocation frequency x failure rate
 * (attempts * (1 - successRate)), descending. Frequency weighting is the
 * point: a skill failing 60% of the time at 100 attempts (burden 60) outranks
 * one failing 90% at 10 attempts (burden 9) — the workhorse's failures cost
 * the colony more than the rarity's. Zero-attempt skills carry no burden and
 * are omitted. Ties break by skill name for determinism.
 */
export function refinementQueue(
  stats: Map<string, SkillStatsLike>,
): Array<{ skill: string; burden: number }> {
  const rows: Array<{ skill: string; burden: number }> = []
  for (const row of stats.values()) {
    if (row.attempts === 0) continue
    rows.push({ skill: row.skill, burden: row.attempts * (1 - row.successRate) })
  }
  rows.sort((a, b) => {
    if (a.burden !== b.burden) return b.burden - a.burden
    return a.skill.localeCompare(b.skill)
  })
  return rows
}

// ---------------------------------------------------------------------------
// Rule 3 — deprecation: the superseded/broken split.
// ---------------------------------------------------------------------------

export interface DeprecationOpts {
  /** lifetime successRate at/above this counts as "it worked once" */
  brokenHealthyRate: number
  /** trailingRate at/below this counts as "it stopped working" */
  brokenCollapsedRate: number
  /** rows (and dominators) with fewer attempts are too noisy to judge */
  minAttempts: number
}

export interface DeprecationVerdict {
  skill: string
  verdict: 'superseded' | 'broken'
  evidence: string
}

/**
 * The split that matters, because the two verdicts demand opposite responses:
 *
 * - `broken` = worked-then-stopped (lifetime successRate high, trailing rate
 *   collapsed) -> a REPAIR signal. Something in the world or the skill's
 *   assumptions changed; send it to the refinement bench, do not bury it.
 * - `superseded` = strictly dominated by another skill with the same declared
 *   outcomeTag — better trailingRate AND lower meanCostMs -> a RANKING
 *   signal only.
 *
 * Superseded skills are NEVER deleted — they only drop retrieval priority
 * (retrievalOrder demotes them to the tail). The respawn case is why:
 * punch-a-tree is strictly dominated the moment iron axes exist, but delete
 * the early game and a dead agent respawning with an empty inventory has no
 * skill left that can bootstrap it back to an axe.
 *
 * A skill qualifying as both is reported `broken` only — repair outranks
 * demotion, and a broken skill's collapsed trailingRate would make almost
 * any same-tag peer "dominate" it spuriously.
 */
export function deprecation(
  stats: Map<string, SkillStatsLike>,
  opts: DeprecationOpts,
): DeprecationVerdict[] {
  const verdicts: DeprecationVerdict[] = []
  const rows = [...stats.values()]

  for (const row of rows) {
    if (row.attempts < opts.minAttempts) continue

    if (
      row.successRate >= opts.brokenHealthyRate &&
      row.trailingRate <= opts.brokenCollapsedRate
    ) {
      verdicts.push({
        skill: row.skill,
        verdict: 'broken',
        evidence:
          `worked then stopped: lifetime successRate ${row.successRate.toFixed(2)} ` +
          `over ${row.attempts} attempts, trailing rate ${row.trailingRate.toFixed(2)} ` +
          `<= ${opts.brokenCollapsedRate}`,
      })
      continue
    }

    if (row.outcomeTag === undefined) continue
    const dominator = rows.find(
      (other) =>
        other.skill !== row.skill &&
        other.attempts >= opts.minAttempts &&
        other.outcomeTag === row.outcomeTag &&
        other.trailingRate > row.trailingRate &&
        other.meanCostMs < row.meanCostMs,
    )
    if (dominator) {
      verdicts.push({
        skill: row.skill,
        verdict: 'superseded',
        evidence:
          `strictly dominated by "${dominator.skill}" (outcomeTag "${row.outcomeTag}"): ` +
          `trailingRate ${dominator.trailingRate.toFixed(2)} > ${row.trailingRate.toFixed(2)}, ` +
          `meanCostMs ${Math.round(dominator.meanCostMs)} < ${Math.round(row.meanCostMs)}`,
      })
    }
  }
  return verdicts
}

// ---------------------------------------------------------------------------
// Rule 4 — selection: UCB1 with the novelty escape hatch.
// ---------------------------------------------------------------------------

export interface SelectSkillOpts {
  /** UCB1 exploration constant c (default sqrt(2)) */
  explorationBonus?: number
  /**
   * Probability of ignoring the mastery-derived ranking entirely and picking
   * uniformly among the least-attempted candidates. An explicit knob, not
   * emergent hope — the system default is DEFAULT_NOVELTY_FRACTION (0.1).
   */
  noveltyFraction: number
  /** sole entropy source; inject a seeded fake in tests */
  rng: () => number
}

/**
 * Draws rng once for the novelty gate; a novelty pick draws once more for the
 * uniform choice. Otherwise UCB1 over per-skill success statistics —
 * zero-attempt skills score +Infinity so each gets tried once. Ties keep the
 * earliest candidate in `eligible` order (deterministic).
 */
export function selectSkill(
  eligible: string[],
  stats: Map<string, SkillStatsLike>,
  opts: SelectSkillOpts,
): { skill: string; via: 'ucb' | 'novelty' } {
  if (eligible.length === 0) {
    throw new Error('selectSkill: eligible list is empty')
  }

  if (opts.rng() < opts.noveltyFraction) {
    const fewest = Math.min(...eligible.map((skill) => attemptsOf(stats, skill)))
    const pool = eligible.filter((skill) => attemptsOf(stats, skill) === fewest)
    const index = Math.min(pool.length - 1, Math.floor(opts.rng() * pool.length))
    // pool is non-empty: fewest is attained by at least one eligible skill
    return { skill: pool[index]!, via: 'novelty' }
  }

  const c = opts.explorationBonus ?? DEFAULT_EXPLORATION_BONUS
  const totalAttempts = eligible.reduce(
    (sum, skill) => sum + attemptsOf(stats, skill),
    0,
  )
  let best = eligible[0]!
  let bestScore = ucbScore(stats.get(best), totalAttempts, c)
  for (const skill of eligible.slice(1)) {
    const score = ucbScore(stats.get(skill), totalAttempts, c)
    if (score > bestScore) {
      best = skill
      bestScore = score
    }
  }
  return { skill: best, via: 'ucb' }
}

// ---------------------------------------------------------------------------
// Rule 5 — retrieval order: the exposed-tool surface the schema layer reads.
// ---------------------------------------------------------------------------

export interface RetrievalOrderOpts {
  /** maximum skills surfaced (~30 — a small deep surface beats a large shallow one) */
  cap: number
}

/**
 * UCB-ranked (same score as selectSkill, default exploration constant;
 * zero-attempt skills float to the top for their one try), with superseded
 * skills demoted to the tail — never removed from the library, only from
 * priority; `broken` verdicts do not demote (they are repair work, and their
 * lifetime successRate already carries their rank). Finally capped at
 * opts.cap: the cap bounds the SURFACE handed to the schema layer, not the
 * library — a superseded skill past the cap is still on the shelf for the
 * respawn case documented on deprecation(). Ties break by skill name.
 */
export function retrievalOrder(
  stats: Map<string, SkillStatsLike>,
  deprecations: DeprecationVerdict[],
  opts: RetrievalOrderOpts,
): string[] {
  const superseded = new Set(
    deprecations
      .filter((verdict) => verdict.verdict === 'superseded')
      .map((verdict) => verdict.skill),
  )
  const rows = [...stats.values()]
  const totalAttempts = rows.reduce((sum, row) => sum + row.attempts, 0)
  const scored = rows.map((row) => ({
    skill: row.skill,
    score: ucbScore(row, totalAttempts, DEFAULT_EXPLORATION_BONUS),
  }))
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.skill.localeCompare(b.skill)
  })
  const head: string[] = []
  const tail: string[] = []
  for (const { skill } of scored) {
    ;(superseded.has(skill) ? tail : head).push(skill)
  }
  return [...head, ...tail].slice(0, opts.cap)
}
