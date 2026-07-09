import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { buildSnapshot, type BotLike } from '../src/world/snapshot.ts'

// The Redis world:{villagerId} contract is validated against the REAL schema —
// exactly the drift the design review said shared state suffers without one.
const schema = JSON.parse(
  readFileSync(
    new URL('../../../packages/events/schemas/state/WorldSnapshot.v1.schema.json', import.meta.url),
    'utf8',
  ),
)
const ajv = new Ajv2020({ allErrors: true })
addFormats(ajv)
const validate = ajv.compile(schema)

const ELARA_ID = '019f8e2a-0000-7000-8000-0000000e1a2a'
const BRAM_ID = '019f8e2a-0000-7000-8000-0000000b2a44'

const bot: BotLike = {
  entity: { position: { x: 100.5123, y: 64, z: -340.4999 } },
  health: 19.5,
  food: 18,
  inventory: {
    items: () => [
      { name: 'oak_log', count: 32 },
      { name: 'oak_log', count: 12 }, // second stack — must be summed
      { name: 'bread', count: 3 },
    ],
  },
  time: { timeOfDay: 1000.7 },
}

describe('buildSnapshot', () => {
  it('produces a snapshot that validates against the WorldSnapshot contract', () => {
    const snapshot = buildSnapshot(ELARA_ID, bot, [
      { villagerId: BRAM_ID, name: 'Bram', position: { x: 105, y: 64, z: -340 } },
    ])

    const valid = validate(snapshot)
    expect(validate.errors ?? []).toEqual([])
    expect(valid).toBe(true)
  })

  it('groups inventory stacks and computes nearby distances', () => {
    const snapshot = buildSnapshot(ELARA_ID, bot, [
      { villagerId: BRAM_ID, name: 'Bram', position: { x: 105, y: 64, z: -340 } },
      { villagerId: 'x', name: 'Ghost', position: null }, // disconnected — excluded
    ])!

    expect(snapshot.inventory).toContainEqual({ item: 'oak_log', count: 44 })
    expect(snapshot.inventory).toContainEqual({ item: 'bread', count: 3 })
    expect(snapshot.nearbyVillagers).toHaveLength(1)
    expect(snapshot.nearbyVillagers[0]!.name).toBe('Bram')
    expect(snapshot.nearbyVillagers[0]!.distance).toBeCloseTo(4.5, 0)
  })

  it('returns null before the bot has an entity (not spawned)', () => {
    expect(buildSnapshot(ELARA_ID, { ...bot, entity: undefined }, [])).toBeNull()
  })

  it('merges the resource survey and still validates against the contract', () => {
    const snapshot = buildSnapshot(ELARA_ID, bot, [], [
      { family: 'wood', nearestDistance: 12.4, count: 32 },
    ])!

    expect(snapshot.nearbyResources).toEqual([{ family: 'wood', nearestDistance: 12.4, count: 32 }])
    expect(validate(snapshot)).toBe(true)
    expect(validate.errors ?? []).toEqual([])
  })

  it('omits nearbyResources before any scan (null) but keeps a scanned-empty [] — and both validate', () => {
    const unscanned = buildSnapshot(ELARA_ID, bot, [], null)!
    expect('nearbyResources' in unscanned).toBe(false)
    expect(validate(unscanned)).toBe(true)

    const scannedEmpty = buildSnapshot(ELARA_ID, bot, [], [])!
    expect(scannedEmpty.nearbyResources).toEqual([])
    expect(validate(scannedEmpty)).toBe(true)
  })
})
