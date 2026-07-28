// Ported from Voyager skill_library/trial1/skill/code/mineWoodLog.js
// (MIT — see ../VENDORED.md). The original explored until any 1.19-era log
// family block appeared, then mined one. The port drives the mineBlock
// primitive (which owns exploration/pathfinding) across the full 1.21.6 log
// family from names.ts: first species that yields wins; only "that species is
// not around" falls through to the next.

import { WOOD_LOGS } from '../names.ts'
import {
  skillFail,
  skillOk,
  type SkillFailureCode,
  type SkillInvocationContext,
  type SkillResult,
  type SkillSchemaStub,
} from '../types.ts'

/**
 * Structural primitive surface this skill composes. Implementations arrive
 * via assembly wiring (built by the primitives unit) — never imported here.
 */
export interface MineWoodLogPrimitives {
  mineBlock(params: {
    name: string
    count?: number
  }): Promise<SkillResult<{ collected: number }>>
}

export interface MineWoodLogParams {
  /** Logs to collect; null/omitted -> 1. */
  count?: number | null
}

export interface MineWoodLogOutcome {
  collected: number
  /** Which log family member actually yielded. */
  log: string
}

export const MINE_WOOD_LOG_FAILURE_CODES: readonly SkillFailureCode[] = [
  'RESOURCE_NOT_FOUND',
  'PATH_NOT_FOUND',
  'TOOL_REQUIRED',
  'TOOL_TIER_REQUIRED',
  'TIMEOUT',
  'INVENTORY_FULL',
  'ABORTED',
  'INTERNAL',
]

export async function mineWoodLog(
  primitives: MineWoodLogPrimitives,
  params: MineWoodLogParams,
  ctx: SkillInvocationContext,
): Promise<SkillResult<MineWoodLogOutcome>> {
  // Normalize before it reaches a primitive: zero/negative/fractional counts
  // would otherwise let a mine of nothing report success.
  const count = Math.max(1, Math.floor(params.count ?? 1))
  let costMs = 0
  const misses: string[] = []
  for (const log of WOOD_LOGS) {
    const mined = await primitives.mineBlock({ name: log, count })
    costMs += mined.costMs
    if (mined.ok) {
      return skillOk({ collected: mined.outcome.collected, log }, costMs, ctx)
    }
    if (mined.failureCode !== 'RESOURCE_NOT_FOUND') {
      // A substantive failure (path, timeout, full inventory…) propagates
      // immediately with its code intact — never remapped.
      return skillFail(
        mined.failureCode,
        `mineWoodLog(${log}): ${mined.detail}`,
        costMs,
        ctx,
      )
    }
    misses.push(log)
  }
  return skillFail(
    'RESOURCE_NOT_FOUND',
    `no wood log of any family nearby (tried ${misses.join(', ')})`,
    costMs,
    ctx,
  )
}

export const mineWoodLogSchema: SkillSchemaStub = {
  name: 'mineWoodLog',
  description:
    'Mine wood logs of any 1.21.6 log family, trying each species in turn until one is found nearby.',
  params: {
    type: 'object',
    properties: {
      count: {
        type: ['integer', 'null'],
        description: 'Logs to collect; null means 1.',
      },
    },
    required: ['count'],
    additionalProperties: false,
  },
  failureCodes: [...MINE_WOOD_LOG_FAILURE_CODES],
}
