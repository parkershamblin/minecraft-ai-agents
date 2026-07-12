import { describe, expect, it, vi } from 'vitest'
import {
  runGatherSession,
  type GatherBlockResult,
  type GatherSessionDeps,
} from '../src/world/gatherSession.ts'

/** Harness: harvestOne serves scripted per-block results (or throws). */
function harness(
  script: Array<GatherBlockResult | Error>,
  overrides: Partial<GatherSessionDeps> = {},
): GatherSessionDeps & {
  emitted: GatherBlockResult[]
  announced: Array<Record<string, number>>
  startFlags: boolean[]
} {
  const emitted: GatherBlockResult[] = []
  const announced: Array<Record<string, number>> = []
  const startFlags: boolean[] = []
  let i = 0
  return {
    emitted,
    announced,
    startFlags,
    harvestOne: vi.fn(async (announceStart: boolean) => {
      startFlags.push(announceStart)
      const next = script[i++]
      if (next === undefined) {
        throw new Error('script exhausted — the test asked for more blocks than it scripted')
      }
      if (next instanceof Error) {
        throw next
      }
      return next
    }),
    bodyStillOurs: () => true,
    emitBlock: (result) => emitted.push(result),
    announceHaul: (byType) => announced.push(byType),
    ...overrides,
  }
}

function block(blockType: string, collected: number, x = 0): GatherBlockResult {
  return { blockType, position: { x, y: 64, z: 0 }, collected }
}

describe('runGatherSession', () => {
  it('count=1 is the classic single-block gather: one attempt, one emission, one announcement', async () => {
    const h = harness([block('spruce_log', 1)])
    const result = await runGatherSession(1, h)
    expect(result).toMatchObject({ collected: 1, blocksDug: 1, attempts: 1, blockType: 'spruce_log', stoppedEarly: null })
    expect(h.emitted).toHaveLength(1)
    expect(h.announced).toEqual([{ spruce_log: 1 }])
  })

  it('runs the full count, emits per block, but announces the haul exactly once', async () => {
    const h = harness([block('spruce_log', 1), block('spruce_log', 2), block('oak_log', 1)])
    const result = await runGatherSession(3, h)
    expect(result.collected).toBe(4)
    expect(result.blocksDug).toBe(3)
    expect(result.attempts).toBe(3)
    expect(result.byType).toEqual({ spruce_log: 3, oak_log: 1 })
    expect(h.emitted).toHaveLength(3) // one ResourceGathered per block — facts survive a timeout
    expect(h.announced).toEqual([{ spruce_log: 3, oak_log: 1 }]) // ONE haul line per trip
  })

  it('speaks the departure line only for the first block of the trip', async () => {
    const h = harness([block('spruce_log', 1), block('spruce_log', 1)])
    await runGatherSession(2, h)
    expect(h.startFlags).toEqual([true, false])
  })

  it('a first-block failure fails the whole session — the coded error propagates untouched', async () => {
    const notFound = new Error('no wood within 48 blocks — move somewhere new and try again')
    ;(notFound as Error & { code?: string }).code = 'RESOURCE_NOT_FOUND'
    const h = harness([notFound])
    await expect(runGatherSession(3, h)).rejects.toBe(notFound)
    expect(h.emitted).toHaveLength(0)
    expect(h.announced).toHaveLength(0) // nothing gathered, nothing to brag about
  })

  it('a mid-session failure ends the trip with an honest partial haul, not an error', async () => {
    const exhausted = new Error('the wood in sight keeps defeating you from this spot — move somewhere new before trying again')
    const h = harness([block('spruce_log', 1), block('spruce_log', 1), exhausted])
    const result = await runGatherSession(5, h)
    expect(result.collected).toBe(2)
    expect(result.attempts).toBe(2)
    expect(result.stoppedEarly).toBe(exhausted.message) // the mind reads why the trip cut short
    expect(h.announced).toEqual([{ spruce_log: 2 }]) // the partial haul is still announced
  })

  it('ghost blocks (zero-collect completions) are emitted but never announced', async () => {
    const h = harness([block('spruce_log', 0), block('spruce_log', 0)])
    const result = await runGatherSession(2, h)
    expect(result.collected).toBe(0)
    expect(result.blocksDug).toBe(0)
    expect(result.attempts).toBe(2)
    expect(h.emitted).toHaveLength(2) // the ghost-block record is world history
    expect(h.announced).toHaveLength(0) // announcing a zero would be a lie
  })

  it('a mixed session announces only the blocks that yielded', async () => {
    const h = harness([block('spruce_log', 1), block('spruce_log', 0), block('oak_log', 2)])
    const result = await runGatherSession(3, h)
    expect(result.byType).toEqual({ spruce_log: 1, oak_log: 2 }) // no zero entries
    expect(result.blocksDug).toBe(2)
    expect(result.attempts).toBe(3)
  })

  it('watchdog abandonment stops the loop between blocks and silences the announcement', async () => {
    // busy flips away after the first block — the executor cleared the seam
    // when the watchdog emitted TIMEOUT; the zombie must go quiet.
    let ours = true
    const h = harness([block('spruce_log', 1), block('spruce_log', 1)], {
      bodyStillOurs: () => ours,
    })
    ;(h.harvestOne as ReturnType<typeof vi.fn>).mockImplementation(async (announceStart: boolean) => {
      h.startFlags.push(announceStart)
      ours = false // the watchdog fires while this block is being dug
      return block('spruce_log', 1)
    })
    const result = await runGatherSession(4, h)
    expect(result.attempts).toBe(1) // no second block for a zombie
    expect(result.stoppedEarly).toContain('abandoned')
    expect(h.emitted).toHaveLength(1) // the fact landed before abandonment
    expect(h.announced).toHaveLength(0) // the mind already heard TIMEOUT — no cheerful chat after it
  })

  it('abandonment before any attempt throws — the latch has already suppressed this promise', async () => {
    const h = harness([], { bodyStillOurs: () => false })
    await expect(runGatherSession(3, h)).rejects.toThrow('abandoned before any attempt')
  })
})
