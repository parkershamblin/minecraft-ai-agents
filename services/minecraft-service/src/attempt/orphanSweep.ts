import type { Logger } from 'pino'
import type { EventEnvelope } from '@civ/events/ts'
import { buildEnvelope } from '../events/envelope.ts'
import { attemptOrphansSwept } from '../metrics.ts'

/**
 * Orphaned-attempt sweep (RB-2 hardening).
 *
 * The AttemptTracker holds the live attempt in memory, so a container restart
 * mid-attempt forgets it: the AttemptStarted stays open in the ledger forever
 * (the 019f8b48 orphan of 2026-07-22, closed by hand via rpk a day later).
 * An open start is poison downstream — Mission Control shows a phantom live
 * attempt, and a booting agent-service brain resurrects any orphan inside its
 * rehydration window as the live race in every prompt.
 *
 * The sweep makes the ledger self-healing: read every AttemptStarted /
 * AttemptEnded in the window (cursor-paged, oldest-first — the ledger's only
 * order), pair them by attemptId, and publish AttemptEnded{outcome: aborted}
 * for every start left unmatched — through the normal producer, so the abort
 * is an ordinary contract event (AttemptEnded.v1: all fields present,
 * winning* null, honestRace zeros). It runs at boot (eager cleanup, retried
 * until the ledger answers) and as the AttemptTracker's pre-start guard —
 * the structural guarantee: no new AttemptStarted is published over a
 * dangling one, and a sweep that cannot complete refuses the start instead
 * of racing it.
 *
 * The ledger read is eventually consistent (event-service consumes the same
 * topics it serves), so an AttemptEnded published moments ago can be missing
 * from the page that holds its start. The process-local memory
 * (isKnownLocally / noteClosed, backed by the AttemptTracker) is the defence:
 * an attempt this process saw end — or already aborted in an earlier sweep —
 * is never aborted again, whatever a lagging page says.
 */

const PAGE_LIMIT = 100 // the ledger's hard cap per page (EventFilter.MAX_LIMIT)
const DEFAULT_MAX_PAGES = 50 // a window holds dozens of attempt events, not thousands
const FETCH_TIMEOUT_MS = 5000

/** Route-visible failure class: the start handler maps this to 503. */
export class OrphanSweepError extends Error {}

interface OpenAttempt {
  attemptId: string
  /** eventId of the orphaned AttemptStarted — the abort's causationId. */
  startedEventId: string
  /** The attempt's original correlation chain; the abort joins it. */
  correlationId: string | null
  occurredAt: string
  label: string | null
}

export interface SweepResult {
  /** Attempt-lifecycle events read from the ledger. */
  scanned: number
  /** attemptIds closed with AttemptEnded{aborted}, oldest first. */
  swept: string[]
}

export interface OrphanSweeperDeps {
  /** Base URL of the event-service ledger, e.g. http://event-service:8081. */
  eventServiceUrl: string
  /** How far back to look for unmatched AttemptStarted. Must cover
   *  agent-service's rehydration window (6h) or an orphan can still be
   *  resurrected as a live race. 0 disables the sweep entirely. */
  windowHours: number
  publish: (envelope: EventEnvelope) => Promise<void>
  /** True when this process already knows the attempt's fate — it is the
   *  active attempt, or one this process ended or swept. Such attempts are
   *  never aborted: the consumer-lag double-abort guard. */
  isKnownLocally: (attemptId: string) => boolean
  /** Record a swept attemptId into the same process-local memory. */
  noteClosed: (attemptId: string) => void
  log: Logger
  fetchFn?: typeof fetch
  nowMs?: () => number
  maxPages?: number
}

export class OrphanSweeper {
  /** Serializes sweeps: boot and pre-start must never race a double abort. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: OrphanSweeperDeps) {}

  /** Run one sweep. Rejects with OrphanSweepError when the window could not
   *  be read completely or an abort could not be published — callers decide
   *  whether that blocks (pre-start guard) or merely warns (boot). */
  sweep(trigger: 'boot' | 'pre-start'): Promise<SweepResult> {
    const run = this.chain.then(
      () => this.run(trigger),
      () => this.run(trigger),
    )
    this.chain = run.catch(() => undefined)
    return run
  }

  private async run(trigger: string): Promise<SweepResult> {
    const { windowHours, log } = this.deps
    if (windowHours <= 0) {
      return { scanned: 0, swept: [] }
    }
    try {
      const { scanned, open } = await this.readOpenAttempts()
      const swept: string[] = []
      for (const orphan of open) {
        if (this.deps.isKnownLocally(orphan.attemptId)) {
          continue // this process saw it end (or is running it) — the ledger page is just lagging
        }
        await this.deps.publish(this.abortEnvelope(orphan))
        this.deps.noteClosed(orphan.attemptId)
        attemptOrphansSwept.inc()
        swept.push(orphan.attemptId)
        log.warn(
          {
            trigger,
            attemptId: orphan.attemptId,
            correlationId: orphan.correlationId,
            label: orphan.label,
            startedAt: orphan.occurredAt,
            ageSeconds: this.ageSeconds(orphan),
          },
          'orphaned attempt closed — AttemptEnded{aborted} published',
        )
      }
      log.info({ trigger, scanned, swept: swept.length, windowHours }, 'orphan sweep complete')
      return { scanned, swept }
    } catch (err) {
      if (err instanceof OrphanSweepError) {
        throw err
      }
      throw new OrphanSweepError(`orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Page the window oldest-first and pair starts with ends by attemptId.
   *  A truncated read throws: concluding "orphan" from a partial view could
   *  abort an attempt whose AttemptEnded sits on an unread page. */
  private async readOpenAttempts(): Promise<{ scanned: number; open: OpenAttempt[] }> {
    const { eventServiceUrl, windowHours, maxPages = DEFAULT_MAX_PAGES, nowMs = Date.now } = this.deps
    const fetchFn = this.deps.fetchFn ?? fetch
    const base = eventServiceUrl.replace(/\/+$/, '')
    const search = new URLSearchParams()
    search.append('type', 'AttemptStarted')
    search.append('type', 'AttemptEnded')
    search.set('since', new Date(nowMs() - windowHours * 3_600_000).toISOString())
    search.set('limit', String(PAGE_LIMIT))

    const open = new Map<string, OpenAttempt>()
    let scanned = 0
    for (let page = 0; page < maxPages; page += 1) {
      let body: {
        data?: Array<{
          eventId: string
          eventType: string
          occurredAt: string
          aggregateId: string
          correlationId: string | null
          payload: Record<string, unknown> | null
        }>
        nextCursor?: string | null
      }
      try {
        const response = await fetchFn(`${base}/events?${search}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!response.ok) {
          throw new Error(`ledger answered ${response.status}`)
        }
        body = (await response.json()) as typeof body
      } catch (err) {
        throw new OrphanSweepError(
          `ledger read failed (${base}/events): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      for (const event of body.data ?? []) {
        const payload = event.payload ?? {}
        const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : event.aggregateId
        if (event.eventType === 'AttemptStarted') {
          open.set(attemptId, {
            attemptId,
            startedEventId: event.eventId,
            correlationId: event.correlationId,
            occurredAt: event.occurredAt,
            label: typeof payload.label === 'string' ? payload.label : null,
          })
        } else if (event.eventType === 'AttemptEnded') {
          open.delete(attemptId)
        }
        scanned += 1
      }
      if (!body.nextCursor) {
        return { scanned, open: [...open.values()] }
      }
      search.set('cursor', body.nextCursor)
    }
    throw new OrphanSweepError(`window read truncated at ${maxPages} pages — refusing to judge orphans from a partial view`)
  }

  private abortEnvelope(orphan: OpenAttempt): EventEnvelope {
    return buildEnvelope({
      eventType: 'AttemptEnded',
      aggregateType: 'Attempt',
      aggregateId: orphan.attemptId,
      correlationId: orphan.correlationId ?? undefined,
      causationId: orphan.startedEventId,
      payload: {
        attemptId: orphan.attemptId,
        outcome: 'aborted',
        winningTeamId: null,
        winningVillagerId: null,
        winningEventId: null,
        durationSeconds: this.ageSeconds(orphan),
        honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 },
      },
    })
  }

  /** Start→now, 0.1s precision like the tracker; 0 when occurredAt is unparseable. */
  private ageSeconds(orphan: OpenAttempt): number {
    const startedMs = Date.parse(orphan.occurredAt)
    const nowMs = this.deps.nowMs ?? Date.now
    if (!Number.isFinite(startedMs)) {
      return 0
    }
    return Math.max(0, Math.round((nowMs() - startedMs) / 100) / 10)
  }
}
