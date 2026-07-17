import { describe, expect, it } from 'vitest'
import {
  type SimCapableBot,
  type SimWorld,
  type SimulatePlayerFn,
  installSimBlockCache,
  wrapSimulatePlayer,
} from '../src/bots/physicsSimCache.ts'

/** A world that counts underlying reads and returns a distinct object per call. */
function countingWorld() {
  const reads: string[] = []
  const world: SimWorld = {
    getBlock(pos) {
      reads.push(`${pos.x},${pos.y},${pos.z}`)
      return { name: 'stone', at: `${pos.x},${pos.y},${pos.z}` }
    },
  }
  return { world, reads }
}

/** An "engine" whose simulate call reads the given positions once each. */
function readingSimulate(positions: Array<{ x: number; y: number; z: number }>): SimulatePlayerFn {
  return (_state, world) => positions.map((p) => world.getBlock(p))
}

describe('wrapSimulatePlayer (the turn-scoped sim block cache)', () => {
  it('serves repeat reads of one cell from the cache within a turn', () => {
    const { world, reads } = countingWorld()
    const clears: Array<() => void> = []
    const sim = wrapSimulatePlayer(readingSimulate([{ x: 1, y: 64, z: 2 }]), (c) => clears.push(c))

    sim({}, world)
    sim({}, world)
    sim({}, world)

    expect(reads).toEqual(['1,64,2']) // 3 simulated ticks, ONE construction
  })

  it('floors fractional positions onto the block cell they resolve to', () => {
    const { world, reads } = countingWorld()
    const sim = wrapSimulatePlayer(
      readingSimulate([
        { x: 1.2, y: 64.9, z: 2.01 },
        { x: 1.7, y: 64.1, z: 2.99 },
      ]),
      () => {},
    )

    const [a, b] = sim({}, world) as unknown[]

    expect(reads).toHaveLength(1) // same cell either way
    expect(a).toBe(b)
  })

  it('caches null (unloaded chunk) instead of re-probing it', () => {
    const reads: string[] = []
    const world: SimWorld = {
      getBlock(pos) {
        reads.push(`${pos.x}`)
        return null
      },
    }
    const sim = wrapSimulatePlayer(readingSimulate([{ x: 5, y: 0, z: 5 }]), () => {})

    expect(sim({}, world)).toEqual([null])
    expect(sim({}, world)).toEqual([null])
    expect(reads).toHaveLength(1)
  })

  it('never serves one world view blocks cached from another', () => {
    const a = countingWorld()
    const b = countingWorld()
    const sim = wrapSimulatePlayer(readingSimulate([{ x: 0, y: 0, z: 0 }]), () => {})

    sim({}, a.world)
    sim({}, b.world) // the pathfinder sim world vs the real-tick world
    sim({}, a.world)

    expect(a.reads).toHaveLength(2) // switching views dropped the cache
    expect(b.reads).toHaveLength(1)
  })

  it('clears at the scheduled turn boundary and re-arms the schedule', () => {
    const { world, reads } = countingWorld()
    const clears: Array<() => void> = []
    const sim = wrapSimulatePlayer(readingSimulate([{ x: 9, y: 9, z: 9 }]), (c) => clears.push(c))

    sim({}, world)
    sim({}, world)
    expect(clears).toHaveLength(1) // one pending clear per turn, however many sims

    clears[0]!() // the "next turn" arrives
    sim({}, world)

    expect(reads).toHaveLength(2) // fresh read after the boundary
    expect(clears).toHaveLength(2) // and the next turn's clear is armed
  })

  it('installSimBlockCache patches the engine in place (real tick and sims share it)', () => {
    const { world, reads } = countingWorld()
    const bot: SimCapableBot = {
      physics: { simulatePlayer: readingSimulate([{ x: 3, y: 70, z: 3 }]) },
    }
    installSimBlockCache(bot)

    bot.physics.simulatePlayer({}, world)
    bot.physics.simulatePlayer({}, world)

    expect(reads).toHaveLength(1)
  })
})
