import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import pino from 'pino'
import type { EventEnvelope } from '@civ/events/ts'
import { OrphanSweepError, OrphanSweeper, type OrphanSweeperDeps } from '../src/attempt/orphanSweep.ts'

// The sweep publishes AttemptEnded through the normal producer, so what it
// builds is validated against the REAL committed contracts (contract-first):
// the payload against AttemptEnded.v1, the whole event against the envelope.
const ajv = new Ajv2020({ allErrors: true })
addFormats(ajv)
const loadSchema = (rel: string) =>
  ajv.compile(JSON.parse(readFileSync(new URL(`../../../packages/events/schemas/${rel}`, import.meta.url), 'utf8')))
const validPayload = loadSchema('world/AttemptEnded.v1.schema.json')
const validEnvelope = loadSchema('envelope.schema.json')

const NOW_MS = Date.parse('2026-07-23T12:00:00Z')
// The real orphan this hardening exists for (2026-07-22, closed by hand).
const ORPHAN = '019f8b48-9940-703c-9ae0-fd1f5ad93a9d'
const FINISHED = '019f8b48-0000-7000-8000-000000000001'

let uuidSeq = 0
const uuid = () => `019f8b48-1111-7000-8000-${String((uuidSeq += 1)).padStart(12, '0')}`

interface StoredEvent {
  eventId: string
  eventType: string
  occurredAt: string
  aggregateId: string
  correlationId: string | null
  payload: Record<string, unknown> | null
}
interface Page {
  data: StoredEvent[]
  nextCursor: string | null
}

function started(attemptId: string, over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    eventId: uuid(),
    eventType: 'AttemptStarted',
    occurredAt: '2026-07-23T11:00:00Z',
    aggregateId: attemptId,
    correlationId: uuid(),
    payload: { attemptId, label: 'soak-2', difficulty: 'normal', teams: [] },
    ...over,
  }
}

function ended(attemptId: string, over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    eventId: uuid(),
    eventType: 'AttemptEnded',
    occurredAt: '2026-07-23T11:30:00Z',
    aggregateId: attemptId,
    correlationId: uuid(),
    payload: { attemptId, outcome: 'won' },
    ...over,
  }
}

/** Fake ledger: serves `pages` in fetch order (repeating the last page for
 *  extra calls), records every requested URL, and captures every publish. */
function harness(pages: Page[] | ((url: string) => Page), over: Partial<OrphanSweeperDeps> = {}) {
  const urls: string[] = []
  const published: EventEnvelope[] = []
  const closed = new Set<string>()
  const fetchFn = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const body = Array.isArray(pages) ? pages[Math.min(urls.length - 1, pages.length - 1)] : pages(url)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const sweeper = new OrphanSweeper({
    eventServiceUrl: 'http://event-service:8081',
    windowHours: 24,
    publish: async (envelope) => {
      published.push(envelope)
    },
    isKnownLocally: (attemptId) => closed.has(attemptId),
    noteClosed: (attemptId) => closed.add(attemptId),
    log: pino({ level: 'silent' }),
    fetchFn,
    nowMs: () => NOW_MS,
    ...over,
  })
  return { sweeper, urls, published, closed }
}

describe('OrphanSweeper', () => {
  it('closes each AttemptStarted without a matching AttemptEnded — and the abort honors the committed contract', async () => {
    const orphanStart = started(ORPHAN)
    const h = harness([{ data: [started(FINISHED), ended(FINISHED), orphanStart], nextCursor: null }])

    const result = await h.sweeper.sweep('boot')

    expect(result.swept).toEqual([ORPHAN])
    expect(result.scanned).toBe(3)
    expect(h.published).toHaveLength(1)
    const abort = h.published[0]!
    expect(abort.eventType).toBe('AttemptEnded')
    expect(abort.aggregateType).toBe('Attempt')
    expect(abort.aggregateId).toBe(ORPHAN)
    expect(abort.correlationId).toBe(orphanStart.correlationId) // the abort joins the attempt's chain…
    expect(abort.causationId).toBe(orphanStart.eventId) // …and points at the start it closes
    expect(abort.payload).toEqual({
      attemptId: ORPHAN,
      outcome: 'aborted',
      winningTeamId: null,
      winningVillagerId: null,
      winningEventId: null,
      durationSeconds: 3600, // started 11:00Z, swept at the injected 12:00Z now
      honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 },
    })
    validPayload(abort.payload)
    expect(validPayload.errors ?? []).toEqual([])
    validEnvelope(abort)
    expect(validEnvelope.errors ?? []).toEqual([])
    expect(h.closed.has(ORPHAN)).toBe(true) // recorded into the process-local memory
  })

  it('pages the window with the ledger contract: both type filters, since, limit 100, then the cursor', async () => {
    const a = started(FINISHED)
    const b = started(ORPHAN)
    const h = harness([
      { data: [a, b], nextCursor: 'c1' },
      { data: [ended(FINISHED)], nextCursor: null }, // the end pairs across the page boundary
    ])

    const result = await h.sweeper.sweep('boot')

    expect(h.urls).toHaveLength(2)
    const first = new URL(h.urls[0]!)
    expect(first.pathname).toBe('/events')
    expect(first.searchParams.getAll('type')).toEqual(['AttemptStarted', 'AttemptEnded'])
    expect(first.searchParams.get('since')).toBe('2026-07-22T12:00:00.000Z') // now − 24h window
    expect(first.searchParams.get('limit')).toBe('100')
    expect(first.searchParams.get('cursor')).toBeNull()
    expect(new URL(h.urls[1]!).searchParams.get('cursor')).toBe('c1')
    expect(result.swept).toEqual([ORPHAN])
    expect(h.published.map((e) => e.aggregateId)).toEqual([ORPHAN])
  })

  it('an AttemptEnded with no payload still clears its start via aggregateId (operator rpk cleanups)', async () => {
    const h = harness([{ data: [started(FINISHED), ended(FINISHED, { payload: null })], nextCursor: null }])
    expect((await h.sweeper.sweep('boot')).swept).toEqual([])
    expect(h.published).toEqual([])
  })

  it('never aborts an attempt this process already knows — the consumer-lag guard', async () => {
    const h = harness([{ data: [started(ORPHAN)], nextCursor: null }])
    h.closed.add(ORPHAN) // e.g. the tracker just ended it; the ledger page lags
    expect((await h.sweeper.sweep('pre-start')).swept).toEqual([])
    expect(h.published).toEqual([])
  })

  it('a second sweep over the same lagging page stays silent (noteClosed feeds isKnownLocally)', async () => {
    const h = harness([{ data: [started(ORPHAN)], nextCursor: null }])
    expect((await h.sweeper.sweep('boot')).swept).toEqual([ORPHAN])
    expect((await h.sweeper.sweep('pre-start')).swept).toEqual([])
    expect(h.published).toHaveLength(1)
  })

  it('concurrent sweeps serialize — one orphan, one abort', async () => {
    const h = harness([{ data: [started(ORPHAN)], nextCursor: null }])
    const [boot, preStart] = await Promise.all([h.sweeper.sweep('boot'), h.sweeper.sweep('pre-start')])
    expect(boot.swept).toEqual([ORPHAN])
    expect(preStart.swept).toEqual([])
    expect(h.published).toHaveLength(1)
  })

  it('an unreachable ledger rejects with OrphanSweepError and publishes nothing', async () => {
    const h = harness([], {
      fetchFn: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    await expect(h.sweeper.sweep('pre-start')).rejects.toThrow(OrphanSweepError)
    expect(h.published).toEqual([])
  })

  it('a non-200 ledger answer rejects with OrphanSweepError', async () => {
    const h = harness([], {
      fetchFn: (async () => new Response('boom', { status: 503 })) as typeof fetch,
    })
    await expect(h.sweeper.sweep('boot')).rejects.toThrow(/ledger answered 503/)
  })

  it('a truncated window read refuses to judge — an unread page could hold the missing end', async () => {
    const h = harness(() => ({ data: [started(uuid())], nextCursor: 'more' }), { maxPages: 3 })
    await expect(h.sweeper.sweep('boot')).rejects.toThrow(/truncated at 3 pages/)
    expect(h.published).toEqual([]) // saw orphans on every page, concluded nothing
    expect(h.urls).toHaveLength(3)
  })

  it('windowHours 0 disables the sweep entirely (the rollback lever)', async () => {
    const h = harness([{ data: [started(ORPHAN)], nextCursor: null }], { windowHours: 0 })
    expect(await h.sweeper.sweep('boot')).toEqual({ scanned: 0, swept: [] })
    expect(h.urls).toEqual([])
    expect(h.published).toEqual([])
  })
})
