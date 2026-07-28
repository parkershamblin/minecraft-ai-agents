// Skill kernel — the shared contract every primitive, ported skill, and the
// mastery machinery compiles against. Batch workers import ONLY from this file
// and names.ts; implementations arrive via deps interfaces (the CraftFlowDeps
// convention), never via cross-imports between units.

/**
 * Closed failure vocabulary. The first group reuses the ActionFailed wire
 * vocabulary (packages/events/schemas/world/ActionFailed.v1.schema.json) so
 * skill outcomes speak the same language the ledger and awareness.py already
 * understand. The second group is skill-local. Never invent strings outside
 * this union — silent-escape codes are how SUPERSEDED slipped past the enum.
 */
export type SkillFailureCode =
  // shared with the ActionFailed enum
  | 'RESOURCE_NOT_FOUND'
  | 'PATH_NOT_FOUND'
  | 'TOOL_REQUIRED'
  | 'TOOL_TIER_REQUIRED'
  | 'TIMEOUT'
  | 'INTERNAL'
  // skill-local (candidates for the v-next contract PR, unit 10)
  | 'UNSUPPORTED_NAME'
  | 'RECIPE_UNAVAILABLE'
  | 'MISSING_MATERIALS'
  | 'PLACE_FAILED'
  | 'CONTAINER_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'INVENTORY_FULL'
  | 'ABORTED'

export interface SkillPosition {
  x: number
  y: number
  z: number
}

/**
 * Captured at invocation time by the harness (assembly wiring), embedded in
 * every SkillResult. Rides ActionCompleted.result — a free-form object on the
 * wire — so no contract change is needed. This is the context column set the
 * mastery stats table (stats.ts) buckets on: mastered means succeeded across
 * DISTINCT contexts, not N times in one forest.
 */
export interface SkillInvocationContext {
  biome: string | null
  timeOfDay: number
  heldTool: string | null
  hostileCount: number
  position: SkillPosition
}

export type SkillResult<T = Record<string, unknown>> =
  | { ok: true; outcome: T; costMs: number; context: SkillInvocationContext }
  | {
      ok: false
      failureCode: SkillFailureCode
      detail: string
      costMs: number
      context: SkillInvocationContext
    }

export function skillOk<T>(
  outcome: T,
  costMs: number,
  context: SkillInvocationContext,
): SkillResult<T> {
  return { ok: true, outcome, costMs, context }
}

export function skillFail<T = Record<string, unknown>>(
  failureCode: SkillFailureCode,
  detail: string,
  costMs: number,
  context: SkillInvocationContext,
): SkillResult<T> {
  return { ok: false, failureCode, detail, costMs, context }
}

/**
 * One row of raw material for the mastery stats table. Ledger-seeded history
 * (existing gather/craft/hunt ActionCompleted/ActionFailed events) maps into
 * this shape with context: null — context columns accrue going forward.
 */
export interface SkillInvocationRecord {
  skill: string
  at: string // ISO-8601
  ok: boolean
  failureCode: SkillFailureCode | null
  costMs: number
  context: SkillInvocationContext | null
}

/**
 * The LLM-facing schema stub co-located with each skill in library/*.ts.
 * Unit 10 (tool-schema design) consumes these; nothing is wired to the
 * decision contract in this batch. params is a JSON-Schema fragment and must
 * be strict-safe: required-nullable fields, anyOf(enum, null) for nullable
 * enums, additionalProperties: false, no free-form objects.
 */
export interface SkillSchemaStub {
  name: string
  description: string
  params: Record<string, unknown>
  failureCodes: SkillFailureCode[]
}
