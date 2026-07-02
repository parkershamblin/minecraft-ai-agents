import { describe, expect, it } from 'vitest'
import { MovementTracker } from '../src/world/movementTracker.ts'

const at = (x: number) => ({ x, y: 64, z: 0 })

describe('MovementTracker', () => {
  it('emits at most once per throttle window while moving', () => {
    const tracker = new MovementTracker(5_000)
    expect(tracker.check(at(0), 0)).toBeNull() // baseline
    expect(tracker.check(at(2), 1_000)).toBeNull() // inside window
    expect(tracker.check(at(4), 4_999)).toBeNull() // still inside

    const emission = tracker.check(at(6), 5_000)
    expect(emission).not.toBeNull()
    expect(emission?.from).toEqual(at(0))
    expect(emission?.to).toEqual(at(6))
    expect(emission?.distance).toBe(6)

    expect(tracker.check(at(8), 7_000)).toBeNull() // new window started at 5s
    expect(tracker.check(at(10), 10_001)).not.toBeNull()
  })

  it('never emits while stationary, regardless of elapsed time', () => {
    const tracker = new MovementTracker(5_000)
    tracker.check(at(0), 0)
    expect(tracker.check(at(0.2), 60_000)).toBeNull() // sub-block jitter
    expect(tracker.check(at(0.1), 120_000)).toBeNull()
  })

  it('flush emits pending displacement immediately (path completion)', () => {
    const tracker = new MovementTracker(5_000)
    tracker.check(at(0), 0)
    expect(tracker.check(at(3), 1_000)).toBeNull() // throttled
    const emission = tracker.flush(at(3), 1_001)
    expect(emission?.distance).toBe(3)
    expect(tracker.flush(at(3), 1_002)).toBeNull() // nothing pending twice
  })
})
