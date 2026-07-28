import { describe, expect, it } from 'vitest'
import {
  WAIT_FOR_MOB_REMOVED_DEFAULT_TIMEOUT_MS,
  WAIT_FOR_MOB_REMOVED_POLL_INTERVAL_MS,
  waitForMobRemoved,
  type WaitForMobRemovedDeps,
} from '../src/skills/primitives/waitForMobRemoved.ts'
import type { SkillInvocationContext } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'taiga',
  timeOfDay: 18000,
  heldTool: null,
  hostileCount: 0,
  position: { x: 0, y: 64, z: 0 },
}

/** goneAtMs: virtual ms after start at which the mob leaves the world; null = never */
function rig(goneAtMs: number | null, sleepRejects = false) {
  let t = 0
  const sleeps: number[] = []
  const deps: WaitForMobRemovedDeps = {
    mobGone: () => goneAtMs !== null && t >= goneAtMs,
    now: () => t,
    sleep: async (ms) => {
      if (sleepRejects) throw new Error('clock exploded')
      sleeps.push(ms)
      t += ms
    },
  }
  return { deps, sleeps, clock: () => t }
}

describe('waitForMobRemoved (poll loop)', () => {
  it('already gone -> ok at 0ms without a single sleep', async () => {
    const { deps, sleeps } = rig(0)
    const r = await waitForMobRemoved(deps, { mobId: 7 }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ waitedMs: 0 })
      expect(r.costMs).toBe(0)
      expect(r.context).toBe(ctx)
    }
    expect(sleeps).toEqual([])
  })

  it('gone after three polls -> ok with the measured wait', async () => {
    const { deps, sleeps } = rig(750)
    const r = await waitForMobRemoved(deps, { mobId: 7 }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome.waitedMs).toBe(750)
      expect(r.costMs).toBe(750)
    }
    expect(sleeps).toEqual([
      WAIT_FOR_MOB_REMOVED_POLL_INTERVAL_MS,
      WAIT_FOR_MOB_REMOVED_POLL_INTERVAL_MS,
      WAIT_FOR_MOB_REMOVED_POLL_INTERVAL_MS,
    ])
  })

  it('never gone -> TIMEOUT at exactly the budget', async () => {
    const { deps, clock } = rig(null)
    const r = await waitForMobRemoved(deps, { mobId: 9, timeoutMs: 1_000 }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TIMEOUT')
      expect(r.detail).toContain('9')
      expect(r.costMs).toBe(1_000)
    }
    expect(clock()).toBe(1_000)
  })

  it('the final sleep is clamped to the remaining budget, never past it', async () => {
    const { deps, sleeps } = rig(null)
    await waitForMobRemoved(deps, { mobId: 7, timeoutMs: 1_000, pollIntervalMs: 300 }, ctx)
    expect(sleeps).toEqual([300, 300, 300, 100])
  })

  it("default timeout is Voyager's 300s", async () => {
    const { deps } = rig(null)
    const r = await waitForMobRemoved(deps, { mobId: 7 }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('TIMEOUT')
      expect(r.costMs).toBe(WAIT_FOR_MOB_REMOVED_DEFAULT_TIMEOUT_MS)
    }
  })

  it('gone-before-timeout check order: dead mob wins even on a 0ms budget', async () => {
    const { deps } = rig(0)
    const r = await waitForMobRemoved(deps, { mobId: 7, timeoutMs: 0 }, ctx)
    expect(r.ok).toBe(true)
  })

  it('0ms budget with a live mob -> immediate TIMEOUT', async () => {
    const { deps, sleeps } = rig(null)
    const r = await waitForMobRemoved(deps, { mobId: 7, timeoutMs: 0 }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('TIMEOUT')
    expect(sleeps).toEqual([])
  })

  it('a zero poll interval is floored to 1ms so the loop always terminates', async () => {
    const { deps, sleeps } = rig(null)
    const r = await waitForMobRemoved(deps, { mobId: 7, timeoutMs: 5, pollIntervalMs: 0 }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureCode).toBe('TIMEOUT')
    expect(sleeps).toEqual([1, 1, 1, 1, 1])
  })

  it('a throwing dep -> INTERNAL, never an unhandled rejection', async () => {
    const { deps } = rig(null, true)
    const r = await waitForMobRemoved(deps, { mobId: 7, timeoutMs: 1_000 }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('clock exploded')
    }
  })
})
