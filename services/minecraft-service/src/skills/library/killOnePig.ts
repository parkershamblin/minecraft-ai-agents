// Port of Voyager trial1 killOnePig.js (MIT — attribution in ../VENDORED.md).
// The original equipped a wooden_sword via an unguarded mcData lookup, explored
// for a pig, ran killMob(bot, 'pig', 300), then pathfound to the corpse for the
// drops. The port delegates every one of those concerns to the killMob
// primitive — which owns weapon selection, target search, and drop collection —
// and propagates its failure codes intact. TOOL_REQUIRED is the typed successor
// to the original's hand-rolled sword check: the skill never pre-checks the
// inventory itself.

import { skillFail, skillOk } from '../types.ts'
import type {
  SkillInvocationContext,
  SkillResult,
  SkillSchemaStub,
} from '../types.ts'

/**
 * Structural view of the killMob primitive. Declared locally — the primitives
 * unit owns the implementation; this skill compiles against the shape only.
 */
export interface KillOnePigPrimitives {
  killMob(params: {
    mobName: string
    timeoutMs?: number
  }): Promise<SkillResult<{ killed: true; dropsCollected: number }>>
}

export interface KillOnePigParams {
  /** Overall hunt budget. Voyager used 300s; 60s matches our trip budgets. */
  timeoutMs?: number
}

export const KILL_ONE_PIG_DEFAULT_TIMEOUT_MS = 60_000

export async function killOnePig(
  primitives: KillOnePigPrimitives,
  params: KillOnePigParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<{ killed: true; dropsCollected: number }>> {
  const startedAt = Date.now()
  const result = await primitives.killMob({
    mobName: 'pig',
    timeoutMs: params.timeoutMs ?? KILL_ONE_PIG_DEFAULT_TIMEOUT_MS,
  })
  const costMs = Date.now() - startedAt
  if (!result.ok) {
    // First failure propagated intact — never remapped.
    return skillFail(result.failureCode, result.detail, costMs, ctx)
  }
  return skillOk(result.outcome, costMs, ctx)
}

export const killOnePigSchema: SkillSchemaStub = {
  name: 'killOnePig',
  description:
    'Hunt and kill one nearby pig and collect its drops. Fails ' +
    'TARGET_NOT_FOUND when no pig is reachable; propagates TOOL_REQUIRED ' +
    'when the combat primitive demands a weapon first.',
  params: {
    type: 'object',
    properties: {
      timeoutMs: {
        type: ['integer', 'null'],
        description:
          'Overall hunt budget in milliseconds; null uses the 60s default.',
      },
    },
    required: ['timeoutMs'],
    additionalProperties: false,
  },
  failureCodes: [
    'TARGET_NOT_FOUND',
    'PATH_NOT_FOUND',
    'TOOL_REQUIRED',
    'TIMEOUT',
    'ABORTED',
    'INTERNAL',
  ],
}
