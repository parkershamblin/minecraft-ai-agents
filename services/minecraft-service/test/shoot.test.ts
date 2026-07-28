import { describe, expect, it } from 'vitest'
import {
  SHOOT_SEARCH_RADIUS,
  shoot,
  type HawkeyeShotResult,
  type ShootDeps,
} from '../src/skills/primitives/shoot.ts'
import type { SkillInvocationContext } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'savanna',
  timeOfDay: 13000,
  heldTool: 'bow',
  hostileCount: 2,
  position: { x: -30, y: 70, z: 100 },
}

interface RigOptions {
  hasWeapon?: boolean
  targetPresent?: boolean
  result?: HawkeyeShotResult
  rejects?: boolean
}

function rig(opts: RigOptions = {}) {
  const { hasWeapon = true, targetPresent = true, result = 'hit', rejects = false } = opts
  let t = 0
  const calls: string[] = []
  const deps: ShootDeps = {
    findNearestMob: (name, maxDistance) => {
      calls.push(`find:${name}:${maxDistance}`)
      return targetPresent ? { id: 42, position: { x: -10, y: 70, z: 120 } } : null
    },
    hasWeapon: (weapon) => {
      calls.push(`hasWeapon:${weapon}`)
      return hasWeapon
    },
    hawkeyeShoot: async (targetId, weapon) => {
      calls.push(`shoot:${targetId}:${weapon}`)
      t += 1_500 // an engagement takes time
      if (rejects) throw new Error('hawkeye exploded')
      return result
    },
    now: () => t,
  }
  return { deps, calls }
}

describe('shoot (hawkeye ranged path)', () => {
  it('hit -> ok with the target id, engagement measured in costMs', async () => {
    const { deps, calls } = rig({ result: 'hit' })
    const r = await shoot(deps, { mobName: 'pig', weapon: 'bow' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ hit: true, targetId: 42 })
      expect(r.costMs).toBe(1_500)
      expect(r.context).toBe(ctx)
    }
    expect(calls).toEqual([
      'hasWeapon:bow',
      `find:pig:${SHOOT_SEARCH_RADIUS}`,
      'shoot:42:bow',
    ])
  })

  it('crossbow passes through to the engagement untranslated', async () => {
    const { deps, calls } = rig()
    const r = await shoot(deps, { mobName: 'skeleton', weapon: 'crossbow' }, ctx)
    expect(r.ok).toBe(true)
    expect(calls).toContain('shoot:42:crossbow')
  })

  it('no launcher in inventory -> TOOL_REQUIRED before anything is aimed', async () => {
    const { deps, calls } = rig({ hasWeapon: false })
    const r = await shoot(deps, { mobName: 'pig', weapon: 'crossbow' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TOOL_REQUIRED')
      expect(r.detail).toContain('crossbow')
    }
    expect(calls.some((c) => c.startsWith('find:'))).toBe(false)
    expect(calls.some((c) => c.startsWith('shoot:'))).toBe(false)
  })

  it('no target in range -> TARGET_NOT_FOUND, hawkeye never engaged', async () => {
    const { deps, calls } = rig({ targetPresent: false })
    const r = await shoot(deps, { mobName: 'cow', weapon: 'bow' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TARGET_NOT_FOUND')
      expect(r.detail).toContain('cow')
      expect(r.detail).toContain(String(SHOOT_SEARCH_RADIUS))
    }
    expect(calls.some((c) => c.startsWith('shoot:'))).toBe(false)
  })

  it('target vanished mid-aim -> TARGET_NOT_FOUND', async () => {
    const { deps } = rig({ result: 'lost' })
    const r = await shoot(deps, { mobName: 'chicken', weapon: 'bow' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TARGET_NOT_FOUND')
      expect(r.detail).toContain('mid-aim')
    }
  })

  it('quiver ran dry -> TOOL_REQUIRED', async () => {
    const { deps } = rig({ result: 'no_ammo' })
    const r = await shoot(deps, { mobName: 'sheep', weapon: 'bow' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TOOL_REQUIRED')
      expect(r.detail).toContain('ammunition')
    }
  })

  it('engagement rejection -> INTERNAL with the cause', async () => {
    const { deps } = rig({ rejects: true })
    const r = await shoot(deps, { mobName: 'pig', weapon: 'bow' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('hawkeye exploded')
    }
  })
})
