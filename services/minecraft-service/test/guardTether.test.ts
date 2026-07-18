import { describe, expect, it } from 'vitest'
import { GuardTether, type GuardTetherDeps, type TetherBot } from '../src/bots/guardTether.ts'
import type { Position } from '../src/world/position.ts'

interface State {
  position: Position
  anchor: Position | null
  stance: string
  busy: string | null
  threatOpen: boolean
  hazardOpen: boolean
  goals: string[]
}

function rig(over: Partial<State> = {}) {
  const state: State = {
    position: { x: 0, y: 64, z: 0 },
    anchor: { x: 0, y: 64, z: 0 },
    stance: 'guard',
    busy: null,
    threatOpen: false,
    hazardOpen: false,
    goals: [],
    ...over,
  }
  const bot: TetherBot = {
    alive: true,
    position: () => state.position,
    setGoalNear: (pos, range) => state.goals.push(`near:${pos.x},${pos.z}:${range}`),
    clearGoal: () => state.goals.push('clear'),
  }
  const deps: GuardTetherDeps = {
    bot: () => bot,
    anchor: () => state.anchor,
    stance: () => state.stance,
    getBusy: () => state.busy,
    threatOpen: () => state.threatOpen,
    hazardOpen: () => state.hazardOpen,
    log: { info: () => {} },
    config: { postRadius: 12, repathMs: 15000 },
  }
  return { state, tether: new GuardTether(deps) }
}

describe('GuardTether (the return-to-post walk)', () => {
  it('walks home beyond the post radius, once, and clears on arrival', () => {
    const { state, tether } = rig({ position: { x: 20, y: 64, z: 0 } })
    tether.check(1000)
    expect(state.goals).toEqual(['near:0,0:2'])
    tether.check(2000) // still walking — no re-set inside the throttle
    expect(state.goals).toEqual(['near:0,0:2'])
    state.position = { x: 2, y: 64, z: 0 } // arrived
    tether.check(3000)
    expect(state.goals).toEqual(['near:0,0:2', 'clear'])
    tether.check(4000) // idle at post — nothing more
    expect(state.goals).toEqual(['near:0,0:2', 'clear'])
  })

  it('re-paths a stalled walk after repathMs', () => {
    const { state, tether } = rig({ position: { x: 20, y: 64, z: 0 } })
    tether.check(1000)
    tether.check(17000)
    expect(state.goals).toEqual(['near:0,0:2', 'near:0,0:2'])
  })

  it('forfeits WITHOUT clearGoal when the body is claimed or an episode opens', () => {
    const { state, tether } = rig({ position: { x: 20, y: 64, z: 0 } })
    tether.check(1000)
    state.busy = 'action' // a command claimed the body mid-walk
    tether.check(2000)
    expect(state.goals).toEqual(['near:0,0:2']) // no clear — the claimant owns the goal now
    state.busy = null
    state.position = { x: 3, y: 64, z: 0 } // the command delivered us home
    tether.check(3000)
    expect(state.goals).toEqual(['near:0,0:2']) // ownership was forfeited — still no clear
  })

  it('stays inert during threat and hazard episodes', () => {
    const { state: threat, tether: t1 } = rig({ position: { x: 20, y: 64, z: 0 }, threatOpen: true })
    t1.check(1000)
    expect(threat.goals).toEqual([])
    const { state: hazard, tether: t2 } = rig({ position: { x: 20, y: 64, z: 0 }, hazardOpen: true })
    t2.check(1000)
    expect(hazard.goals).toEqual([])
  })

  it('inert under cautious/brave stances and without an anchor', () => {
    const { state: s1, tether: t1 } = rig({ position: { x: 20, y: 64, z: 0 }, stance: 'cautious' })
    t1.check(1000)
    expect(s1.goals).toEqual([])
    const { state: s2, tether: t2 } = rig({ position: { x: 20, y: 64, z: 0 }, stance: 'brave' })
    t2.check(1000)
    expect(s2.goals).toEqual([])
    const { state: s3, tether: t3 } = rig({ position: { x: 20, y: 64, z: 0 }, anchor: null })
    t3.check(1000)
    expect(s3.goals).toEqual([])
  })

  it('the hysteresis band (arrive..postRadius) neither walks nor clears', () => {
    const { state, tether } = rig({ position: { x: 8, y: 64, z: 0 } })
    tether.check(1000)
    expect(state.goals).toEqual([])
  })
})
