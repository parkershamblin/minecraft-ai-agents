import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { buildEnvelope } from '../src/events/envelope.ts'

// The envelope builder is validated against the REAL contract schema — if
// packages/events changes, this is the producer-side tripwire.
const schema = JSON.parse(
  readFileSync(new URL('../../../packages/events/schemas/envelope.schema.json', import.meta.url), 'utf8'),
)
const ajv = new Ajv2020({ allErrors: true })
addFormats(ajv)
const validate = ajv.compile(schema)

describe('buildEnvelope', () => {
  it('produces envelopes that validate against the contract schema', () => {
    const envelope = buildEnvelope({
      eventType: 'VillagerSpawned',
      aggregateId: '019f8e2a-0000-7000-8000-0000000e1a2a',
      payload: { villagerId: '019f8e2a-0000-7000-8000-0000000e1a2a', name: 'Elara' },
    })

    const valid = validate(envelope)
    expect(validate.errors ?? []).toEqual([])
    expect(valid).toBe(true)
  })

  it('generates time-ordered UUIDv7 eventIds', () => {
    const a = buildEnvelope({ eventType: 'X', aggregateId: '019f8e2a-0000-7000-8000-0000000e1a2a', payload: {} })
    const b = buildEnvelope({ eventType: 'X', aggregateId: '019f8e2a-0000-7000-8000-0000000e1a2a', payload: {} })
    expect(a.eventId < b.eventId).toBe(true) // v7 = lexicographically time-sortable
  })

  it('propagates correlation and causation when given', () => {
    const envelope = buildEnvelope({
      eventType: 'ActionCompleted',
      aggregateId: '019f8e2a-0000-7000-8000-0000000e1a2a',
      correlationId: '019f8e2b-0001-7000-8000-c0de00000001',
      causationId: '019f8e2b-0003-7000-8000-00000000a003',
      payload: {},
    })
    expect(envelope.correlationId).toBe('019f8e2b-0001-7000-8000-c0de00000001')
    expect(envelope.causationId).toBe('019f8e2b-0003-7000-8000-00000000a003')
  })
})
