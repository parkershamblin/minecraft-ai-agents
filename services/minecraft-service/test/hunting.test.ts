import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  HUNT_FAMILIES,
  type HuntBot,
  type HuntableEntity,
  allHuntTargetsBlacklistedMessage,
  groupAnimalSightings,
  huntNotFoundMessage,
  huntStartAnnouncement,
  huntSuccessAnnouncement,
  isHuntYield,
  pickHuntTarget,
  runKillLoop,
  targetEscapedMessage,
} from '../src/world/hunting.ts'

const cow = (over: Partial<HuntableEntity> = {}): HuntableEntity => ({
  id: 11,
  name: 'cow',
  position: { x: 10, y: 64, z: 0 },
  distance: 10,
  baby: false,
  ...over,
})

describe('contract tripwire', () => {
  it('the body handles exactly the HuntParams animal enum', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../../packages/events/schemas/commands/ActionRequested.v1.schema.json', import.meta.url), 'utf8'),
    )
    expect(Object.keys(HUNT_FAMILIES)).toEqual(schema.$defs.HuntParams.properties.animal.enum)
    expect(schema.properties.action.enum).toContain('hunt')
  })
})

describe('pickHuntTarget', () => {
  it('nearest adult of the family wins', () => {
    const target = pickHuntTarget(
      [cow({ id: 1, distance: 20 }), cow({ id: 2, distance: 8 }), cow({ id: 3, name: 'pig', distance: 2 })],
      'cow',
      32,
      new Map(),
      0,
    )
    expect(target?.id).toBe(2)
  })

  it("'any' takes the nearest across all families", () => {
    const target = pickHuntTarget([cow({ id: 1, distance: 20 }), cow({ id: 3, name: 'pig', distance: 2 })], 'any', 32, new Map(), 0)
    expect(target?.id).toBe(3)
  })

  it('babies are NEVER targeted (the metadata flag — heights lie)', () => {
    expect(pickHuntTarget([cow({ baby: true, distance: 2 })], 'cow', 32, new Map(), 0)).toBeNull()
  })

  it('beyond the chase budget is out of the hunt', () => {
    expect(pickHuntTarget([cow({ distance: 40 })], 'cow', 32, new Map(), 0)).toBeNull()
  })

  it('recent escapees stay off the menu until the blacklist expires', () => {
    const blacklist = new Map([[11, 5_000]])
    expect(pickHuntTarget([cow()], 'cow', 32, blacklist, 4_000)).toBeNull()
    expect(pickHuntTarget([cow()], 'cow', 32, blacklist, 6_000)?.id).toBe(11)
  })
})

describe('yields and sightings', () => {
  it('family yields include the meat and the extras; sheep wool matches by suffix', () => {
    expect(isHuntYield('cow', 'beef')).toBe(true)
    expect(isHuntYield('cow', 'leather')).toBe(true)
    expect(isHuntYield('sheep', 'white_wool')).toBe(true)
    expect(isHuntYield('cow', 'porkchop')).toBe(false)
  })

  it('groupAnimalSightings groups adults by family, nearest-first data intact', () => {
    const sightings = groupAnimalSightings(
      [cow({ id: 1, distance: 21.66 }), cow({ id: 2, distance: 30 }), cow({ id: 3, name: 'chicken', distance: 9.2 }), cow({ id: 4, baby: true, distance: 1 })],
      48,
    )
    expect(sightings).toContainEqual({ family: 'cow', nearestDistance: 21.7, count: 2 })
    expect(sightings).toContainEqual({ family: 'chicken', nearestDistance: 9.2, count: 1 })
    expect(sightings.find((s) => s.family === 'cow')?.count).toBe(2) // the calf never counts
  })

  it('prose teaches: not-found points at the herds, escaped teaches persistence, announcements stay honest', () => {
    expect(huntNotFoundMessage('cow', 32)).toContain('move toward grassland')
    expect(allHuntTargetsBlacklistedMessage('any')).toContain('move somewhere new')
    expect(targetEscapedMessage('cow', 14)).toContain('wounded game keeps its wounds')
    expect(huntStartAnnouncement(cow({ distance: 17.8 }))).toBe('Off hunting — a cow, 18 blocks out.')
    expect(huntSuccessAnnouncement('cow', { beef: 2, leather: 1 })).toBe('Hunted a cow — 2 beef and 1 leather in the pack!')
    expect(huntSuccessAnnouncement('cow', {})).toBeNull() // never announce a lie
  })
})

interface LoopState {
  target: { position: { x: number; y: number; z: number }; distance: number } | null
  botPosition: { x: number; y: number; z: number }
  generation: number
  attacks: number
  goals: string[]
}

function huntBot(state: LoopState): HuntBot {
  return {
    alive: true,
    position: () => state.botPosition,
    targetById: () => state.target,
    setGoalFollow: (id, range) => state.goals.push(`follow:${id}:${range}`),
    clearGoal: () => state.goals.push('clear'),
    lookAt: () => {},
    attack: () => {
      state.attacks += 1
    },
    goTo: async () => {},
    generation: () => state.generation,
  }
}

describe('runKillLoop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const opts = (ctx = { abandoned: false }) => ({ chaseTimeoutMs: 20_000, leashBlocks: 48, ctx })

  it('kills: swings in reach, presumes the kill when the entity vanishes close-in', async () => {
    const state: LoopState = {
      target: { position: { x: 2, y: 64, z: 0 }, distance: 2 },
      botPosition: { x: 0, y: 64, z: 0 },
      generation: 1,
      attacks: 0,
      goals: [],
    }
    const loop = runKillLoop(huntBot(state), 11, opts())
    await vi.advanceTimersByTimeAsync(700)
    state.target = null // it died at our feet
    await vi.advanceTimersByTimeAsync(300)
    const outcome = await loop
    expect(outcome.kind).toBe('killed')
    expect(state.attacks).toBeGreaterThanOrEqual(1)
    expect(state.goals[0]).toBe('follow:11:2')
    expect(state.goals.at(-1)).toBe('clear')
  })

  it('a vanish at range without swings is an escape, not a kill (presumption stays honest)', async () => {
    const state: LoopState = {
      target: { position: { x: 30, y: 64, z: 0 }, distance: 30 },
      botPosition: { x: 0, y: 64, z: 0 },
      generation: 1,
      attacks: 0,
      goals: [],
    }
    const loop = runKillLoop(huntBot(state), 11, opts())
    await vi.advanceTimersByTimeAsync(300)
    state.target = null // wandered out of tracking
    await vi.advanceTimersByTimeAsync(300)
    expect((await loop).kind).toBe('escaped')
  })

  it('the chase deadline ends it as escaped', async () => {
    const state: LoopState = {
      target: { position: { x: 30, y: 64, z: 0 }, distance: 30 },
      botPosition: { x: 0, y: 64, z: 0 },
      generation: 1,
      attacks: 0,
      goals: [],
    }
    const loop = runKillLoop(huntBot(state), 11, opts())
    await vi.advanceTimersByTimeAsync(20_100)
    expect((await loop).kind).toBe('escaped')
  })

  it('the leash ends a chase that dragged the hunter too far from where it started', async () => {
    const state: LoopState = {
      target: { position: { x: 60, y: 64, z: 0 }, distance: 5 },
      botPosition: { x: 0, y: 64, z: 0 },
      generation: 1,
      attacks: 0,
      goals: [],
    }
    const loop = runKillLoop(huntBot(state), 11, { chaseTimeoutMs: 20_000, leashBlocks: 20, ctx: { abandoned: false } })
    await vi.advanceTimersByTimeAsync(300)
    state.botPosition = { x: 25, y: 64, z: 0 } // dragged past the leash
    await vi.advanceTimersByTimeAsync(300)
    expect((await loop).kind).toBe('escaped')
  })

  it('abandonment (stopMoving, the watchdog lever) silences the loop within one poll', async () => {
    const ctx = { abandoned: false }
    const state: LoopState = {
      target: { position: { x: 10, y: 64, z: 0 }, distance: 10 },
      botPosition: { x: 0, y: 64, z: 0 },
      generation: 1,
      attacks: 0,
      goals: [],
    }
    const loop = runKillLoop(huntBot(state), 11, opts(ctx))
    await vi.advanceTimersByTimeAsync(300)
    ctx.abandoned = true
    await vi.advanceTimersByTimeAsync(300)
    expect((await loop).kind).toBe('abandoned')
  })

  it('a death mid-chase abandons — the respawned body books no kill', async () => {
    const state: LoopState = {
      target: { position: { x: 2, y: 64, z: 0 }, distance: 2 },
      botPosition: { x: 0, y: 64, z: 0 },
      generation: 1,
      attacks: 0,
      goals: [],
    }
    const loop = runKillLoop(huntBot(state), 11, opts())
    await vi.advanceTimersByTimeAsync(700)
    state.generation = 2 // died (a creeper found the hunter)
    state.target = null
    await vi.advanceTimersByTimeAsync(300)
    expect((await loop).kind).toBe('abandoned')
  })
})
