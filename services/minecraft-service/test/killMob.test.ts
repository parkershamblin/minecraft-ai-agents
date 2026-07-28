import { describe, expect, it } from 'vitest'
import {
  KILL_MOB_DEFAULT_TIMEOUT_MS,
  KILL_MOB_SEARCH_RADIUS,
  killMob,
  type KillMobDeps,
  type KillMobParams,
} from '../src/skills/primitives/killMob.ts'
import type { SkillInvocationContext } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'plains',
  timeOfDay: 6000,
  heldTool: 'iron_sword',
  hostileCount: 1,
  position: { x: 10, y: 64, z: -4 },
}

interface RigOptions {
  mobPresent?: boolean
  /** virtual ms after start at which the mob leaves the world; null = never */
  goneAtMs?: number | null
  drops?: number
  attackRejects?: boolean
  collectRejects?: boolean
}

function rig(opts: RigOptions = {}) {
  const {
    mobPresent = true,
    goneAtMs = 500,
    drops = 2,
    attackRejects = false,
    collectRejects = false,
  } = opts
  let t = 0
  const calls: string[] = []
  const deps: KillMobDeps = {
    findNearestMob: (name, maxDistance) => {
      calls.push(`find:${name}:${maxDistance}`)
      return mobPresent ? { id: 7, position: { x: 12, y: 64, z: -2 } } : null
    },
    pvpAttack: async (mobId) => {
      calls.push(`attack:${mobId}`)
      if (attackRejects) throw new Error('pvp plugin exploded')
    },
    pvpStop: async () => {
      calls.push('stop')
    },
    mobGone: () => goneAtMs !== null && t >= goneAtMs,
    collectNearbyDrops: async () => {
      calls.push('collect')
      if (collectRejects) throw new Error('collector exploded')
      return drops
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms
    },
  }
  return { deps, calls, clock: () => t }
}

describe('killMob (melee path)', () => {
  it('kills, disengages, THEN collects drops — in that order', async () => {
    const { deps, calls } = rig({ goneAtMs: 500, drops: 3 })
    const r = await killMob(deps, { mobName: 'zombie' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ killed: true, dropsCollected: 3 })
      expect(r.costMs).toBe(500)
      expect(r.context).toBe(ctx)
    }
    // stop strictly before collect: collection must not fight
    expect(calls).toEqual([
      `find:zombie:${KILL_MOB_SEARCH_RADIUS}`,
      'attack:7',
      'stop',
      'collect',
    ])
  })

  it('mob already gone at engagement start still counts as a kill', async () => {
    const { deps, calls } = rig({ goneAtMs: 0 })
    const r = await killMob(deps, { mobName: 'zombie' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.costMs).toBe(0)
    expect(calls).toContain('stop')
  })

  it('no mob within 48 blocks -> TARGET_NOT_FOUND, no attack', async () => {
    const { deps, calls } = rig({ mobPresent: false })
    const r = await killMob(deps, { mobName: 'creeper' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TARGET_NOT_FOUND')
      expect(r.detail).toContain('creeper')
      expect(r.detail).toContain(String(KILL_MOB_SEARCH_RADIUS))
    }
    expect(calls.some((c) => c.startsWith('attack:'))).toBe(false)
    expect(calls).not.toContain('collect')
  })

  it('timeout mid-fight -> TIMEOUT, engagement stopped, nothing collected', async () => {
    const { deps, calls, clock } = rig({ goneAtMs: null })
    const r = await killMob(deps, { mobName: 'enderman', timeoutMs: 1_000 }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TIMEOUT')
      expect(r.detail).toContain('enderman')
      expect(r.costMs).toBe(1_000)
    }
    expect(clock()).toBe(1_000) // the final sleep is clamped to the remainder
    expect(calls.filter((c) => c === 'stop')).toHaveLength(1)
    expect(calls).not.toContain('collect')
  })

  it("default timeout is Voyager's 300s", async () => {
    const { deps } = rig({ goneAtMs: null })
    const r = await killMob(deps, { mobName: 'skeleton' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TIMEOUT')
      expect(r.costMs).toBe(KILL_MOB_DEFAULT_TIMEOUT_MS)
    }
  })

  it('pvpAttack rejection -> INTERNAL with the cause, engagement stopped', async () => {
    const { deps, calls } = rig({ attackRejects: true })
    const r = await killMob(deps, { mobName: 'zombie' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('pvp plugin exploded')
    }
    expect(calls).toContain('stop')
    expect(calls).not.toContain('collect')
  })

  it('drop-sweep rejection after the kill -> INTERNAL, still disengaged', async () => {
    const { deps, calls } = rig({ collectRejects: true })
    const r = await killMob(deps, { mobName: 'zombie' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('collector exploded')
    }
    expect(calls.filter((c) => c === 'stop').length).toBeGreaterThanOrEqual(1)
  })

  it('property: pvp is stopped on EVERY exit path', async () => {
    const scenarios: Array<{ name: string; opts: RigOptions; params: KillMobParams }> = [
      { name: 'success', opts: { goneAtMs: 250 }, params: { mobName: 'zombie' } },
      { name: 'target lost', opts: { mobPresent: false }, params: { mobName: 'zombie' } },
      {
        name: 'timeout',
        opts: { goneAtMs: null },
        params: { mobName: 'zombie', timeoutMs: 500 },
      },
      { name: 'attack throws', opts: { attackRejects: true }, params: { mobName: 'zombie' } },
      { name: 'collect throws', opts: { collectRejects: true }, params: { mobName: 'zombie' } },
    ]
    for (const s of scenarios) {
      const { deps, calls } = rig(s.opts)
      await killMob(deps, s.params, ctx)
      expect(calls, `exit path "${s.name}" leaked the pvp engagement`).toContain('stop')
    }
  })
})
