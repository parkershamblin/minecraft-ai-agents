import { describe, expect, it } from 'vitest'
import {
  GOTO_PLACE_TIMEOUT_MS,
  placeItem,
  type PlaceItemDeps,
} from '../src/skills/primitives/placeItem.ts'
import type { SkillInvocationContext, SkillPosition } from '../src/skills/types.ts'

const ctx: SkillInvocationContext = {
  biome: 'plains',
  timeOfDay: 13000,
  heldTool: 'crafting_table',
  hostileCount: 1,
  position: { x: -3, y: 70, z: 22 },
}

const TABLE = { id: 9, name: 'crafting_table' }
const target: SkillPosition = { x: -1, y: 70, z: 24 }
const reference = {
  ref: { x: -1, y: 69, z: 24 },
  face: { x: 0, y: 1, z: 0 },
}

interface FakeWorld {
  deps: PlaceItemDeps
  gotoCalls: Array<{ pos: SkillPosition; timeoutMs: number }>
  placeCalls: Array<{ ref: SkillPosition; face: SkillPosition }>
  verifyCalls: Array<{ name: string; near: SkillPosition }>
}

function makeWorld(overrides: Partial<PlaceItemDeps> = {}): FakeWorld {
  const gotoCalls: FakeWorld['gotoCalls'] = []
  const placeCalls: FakeWorld['placeCalls'] = []
  const verifyCalls: FakeWorld['verifyCalls'] = []
  let clock = 0
  const deps: PlaceItemDeps = {
    resolveItem: (name) => {
      if (name !== TABLE.name) {
        return { ok: false, failureCode: 'UNSUPPORTED_NAME', detail: `item "${name}" not in minecraft-data for this version` }
      }
      return { ok: true, value: TABLE }
    },
    hasItem: () => true,
    findReferenceBlock: () => reference,
    place: async (ref, face) => {
      placeCalls.push({ ref, face })
      return 'placed'
    },
    verifyPlaced: async (name, near) => {
      verifyCalls.push({ name, near })
      return false
    },
    gotoNear: async (pos, timeoutMs) => {
      gotoCalls.push({ pos, timeoutMs })
      return 'arrived'
    },
    now: () => (clock += 25),
    ...overrides,
  }
  return { deps, gotoCalls, placeCalls, verifyCalls }
}

describe('placeItem primitive', () => {
  it('walks, places against the reference block, and reports the position', async () => {
    const world = makeWorld()
    const r = await placeItem(world.deps, { name: 'crafting_table', position: target }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outcome).toEqual({ placed: true, position: target })
      expect(r.costMs).toBeGreaterThan(0)
      expect(r.context).toBe(ctx)
    }
    expect(world.gotoCalls).toEqual([{ pos: target, timeoutMs: GOTO_PLACE_TIMEOUT_MS }])
    expect(world.placeCalls).toEqual([reference])
    // no extra world reads when the place already reported success
    expect(world.verifyCalls).toHaveLength(0)
  })

  it('unknown names fail UNSUPPORTED_NAME straight from the guarded lookup', async () => {
    const world = makeWorld()
    const r = await placeItem(world.deps, { name: 'chunkium_block', position: target }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('UNSUPPORTED_NAME')
      expect(r.detail).toContain('chunkium_block')
    }
    expect(world.placeCalls).toHaveLength(0)
  })

  it('nothing carried to place: MISSING_MATERIALS before any walking', async () => {
    const world = makeWorld({ hasItem: () => false })
    const r = await placeItem(world.deps, { name: 'crafting_table', position: target }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('MISSING_MATERIALS')
      expect(r.detail).toContain('crafting_table')
    }
    expect(world.gotoCalls).toHaveLength(0)
  })

  it('an unreachable site fails PATH_NOT_FOUND before any world reads', async () => {
    const world = makeWorld({ gotoNear: async () => 'failed' })
    const r = await placeItem(world.deps, { name: 'crafting_table', position: target }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PATH_NOT_FOUND')
      expect(r.detail).toContain('(-1, 70, 24)')
    }
    expect(world.placeCalls).toHaveLength(0)
  })

  it('all-air neighbors fail PLACE_FAILED as a floating block, scanned only after arriving', async () => {
    const calls: string[] = []
    const world = makeWorld({
      findReferenceBlock: () => {
        calls.push('scan')
        return null
      },
    })
    const baseGoto = world.deps.gotoNear
    world.deps.gotoNear = async (pos, timeoutMs) => {
      calls.push('walk')
      return baseGoto(pos, timeoutMs)
    }
    const r = await placeItem(world.deps, { name: 'crafting_table', position: target }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PLACE_FAILED')
      expect(r.detail).toContain('floating block')
    }
    // the scan must read loaded chunks: walk first (Voyager scanned from afar)
    expect(calls).toEqual(['walk', 'scan'])
  })

  it("the blockUpdate flake: place says 'failed' but the world shows the block — ok:true", async () => {
    const world = makeWorld({
      place: async () => 'failed',
      verifyPlaced: async () => true,
    })
    const r = await placeItem(world.deps, { name: 'crafting_table', position: target }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outcome).toEqual({ placed: true, position: target })
  })

  it("place says 'failed' and the world agrees: PLACE_FAILED", async () => {
    const world = makeWorld({ place: async () => 'failed' })
    const r = await placeItem(world.deps, { name: 'crafting_table', position: target }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('PLACE_FAILED')
      expect(r.detail).toContain('another position')
    }
    expect(world.verifyCalls).toEqual([{ name: 'crafting_table', near: target }])
  })

  it('a throwing dep maps to INTERNAL with the message carried, never an escaped exception', async () => {
    const world = makeWorld({
      place: async () => {
        throw new Error('pathfinder promise never settled')
      },
    })
    const r = await placeItem(world.deps, { name: 'crafting_table', position: target }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failureCode).toBe('INTERNAL')
      expect(r.detail).toContain('pathfinder promise never settled')
    }
  })
})
