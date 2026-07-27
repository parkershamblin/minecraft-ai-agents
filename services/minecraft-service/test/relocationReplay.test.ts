import { describe, expect, it } from 'vitest'
import {
  blacklistRegion,
  clearRegionMarks,
  pickGatherTarget,
  targetKey,
} from '../src/world/resources.ts'

/**
 * Replay of the v5 muteness halt (2026-07-27), from the real coordinates the
 * running executor logged.
 *
 * The v5 relocation was supposed to walk a stranded body toward workable
 * ground. Across a whole sweep it fired ZERO times and two villagers went mute
 * anyway, because it asked the SAME blacklist that had just emptied the picker
 * — so the escape hatch was locked with the key that jammed the door.
 *
 * Coordinates below are Fen's and Ansel's actual logged gather targets from
 * bench-llama3.1-8b-v5-r3 / r3b, with the cluster marks their zero-movement
 * trips produced.
 */
describe('v5 relocation replay — real mute-run coordinates', () => {
  // Fen stood at the blue post and cycled these two oak logs.
  const FEN_STANDPOINT = { x: 358, y: 71, z: -580 }
  const FEN_TARGETS = [
    { x: 363, y: 75, z: -580 },
    { x: 357, y: 71, z: -586 },
  ]
  // Wider-radius candidates that existed but were never walked to.
  const FURTHER_WOOD = [
    { x: 392, y: 70, z: -560 },
    { x: 330, y: 68, z: -604 },
  ]

  function blacklistAfterFailedTrips(now: number) {
    const blacklist = new Map<string, number>()
    for (const t of FEN_TARGETS) {
      blacklist.set(targetKey(t), now + 600_000)
      // each zero-movement trip also marked the cluster (radius 8)
      blacklistRegion(blacklist, t, 8, now + 600_000)
    }
    return blacklist
  }

  it('reproduces the failure: every candidate in the wider sweep is rejected', () => {
    const now = 1_000
    const blacklist = blacklistAfterFailedTrips(now)
    // The wider search still finds the same cluster near the post...
    const withinRegions = pickGatherTarget(FEN_TARGETS, FEN_STANDPOINT, blacklist, now)
    expect(withinRegions).toBeNull()
    // ...and that is precisely what made v5's relocation return null and the
    // body stand still for the whole race.
  })

  it('the fallback picks a target when the blacklist-respecting pick is empty', () => {
    const now = 1_000
    const blacklist = blacklistAfterFailedTrips(now)
    const clean = pickGatherTarget(FEN_TARGETS, FEN_STANDPOINT, blacklist, now)
    const fallback = clean ?? pickGatherTarget(FEN_TARGETS, FEN_STANDPOINT, new Map(), now)
    expect(clean).toBeNull()
    expect(fallback).not.toBeNull()
    expect(FEN_TARGETS).toContain(fallback)
  })

  it('prefers clean ground when any exists, and only then falls back', () => {
    const now = 1_000
    const blacklist = blacklistAfterFailedTrips(now)
    const candidates = [...FEN_TARGETS, ...FURTHER_WOOD]
    const clean = pickGatherTarget(candidates, FEN_STANDPOINT, blacklist, now)
    expect(clean).not.toBeNull()
    // the clean pick must be one of the untouched further trees, never the
    // cluster that just defeated the body
    expect(FURTHER_WOOD).toContain(clean)
  })

  it('clearing region marks after a move re-opens the clusters, keeping block marks', () => {
    const now = 1_000
    const blacklist = blacklistAfterFailedTrips(now)
    const cleared = clearRegionMarks(blacklist)
    expect(cleared).toBe(FEN_TARGETS.length)
    // the individual blocks that ate attempts stay suspect...
    for (const t of FEN_TARGETS) {
      expect(blacklist.has(targetKey(t))).toBe(true)
    }
    // ...but a neighbouring log of the same tree is workable again from the
    // new standpoint, which is the whole point of relocating.
    const neighbour = { x: 363, y: 76, z: -580 }
    expect(pickGatherTarget([neighbour], FEN_STANDPOINT, blacklist, now)).toBe(neighbour)
  })
})
