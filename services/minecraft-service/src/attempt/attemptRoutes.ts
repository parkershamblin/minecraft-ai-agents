import type http from 'node:http'
import type { AttemptTracker, StartAttemptInput, EndAttemptInput, TeamRoster } from './attemptTracker.ts'
import { OrphanSweepError } from './orphanSweep.ts'

/**
 * The harness's control surface (RB-1): the attempt lifecycle is driven over
 * localhost HTTP by the race scripts, mirroring agent-service's /internal
 * seed endpoint. Everything else about an attempt (milestones, win) flows
 * through the ledger; these routes only open, inspect, and close it.
 *
 *   POST /internal/attempt/start {label?, difficulty, teams:[{teamId,villagerIds}]}
 *        — 503 when the pre-start orphan sweep cannot reach the ledger
 *   GET  /internal/attempt                     — status incl. recorded win
 *   POST /internal/attempt/end   {outcome, honestRace:{budgetTrippedDelta,fakeProviderDelta}}
 */
export async function handleAttemptRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  tracker: AttemptTracker,
): Promise<boolean> {
  const url = req.url ?? ''
  if (!url.startsWith('/internal/attempt')) {
    return false
  }
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (req.method === 'GET' && url === '/internal/attempt') {
    reply(200, tracker.status())
    return true
  }

  if (req.method === 'POST' && (url === '/internal/attempt/start' || url === '/internal/attempt/end')) {
    let body: Record<string, unknown>
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      reply(400, { error: 'body is not JSON' })
      return true
    }

    try {
      if (url === '/internal/attempt/start') {
        const teams = body.teams as TeamRoster[] | undefined
        if (
          !Array.isArray(teams) ||
          teams.length === 0 ||
          teams.some((t) => typeof t?.teamId !== 'string' || !Array.isArray(t?.villagerIds) || t.villagerIds.length === 0)
        ) {
          reply(400, { error: 'teams must be a non-empty array of {teamId, villagerIds[]}' })
          return true
        }
        if (typeof body.difficulty !== 'string' || body.difficulty.length === 0) {
          reply(400, { error: 'difficulty is required — verify it via RCON and pass what the server really runs' })
          return true
        }
        const input: StartAttemptInput = {
          label: typeof body.label === 'string' ? body.label : null,
          difficulty: body.difficulty,
          teams,
        }
        const envelope = await tracker.start(input)
        reply(201, { attemptId: (envelope.payload as { attemptId: string }).attemptId, eventId: envelope.eventId })
        return true
      }

      // /internal/attempt/end
      const outcome = body.outcome
      if (outcome !== 'won' && outcome !== 'stalled' && outcome !== 'aborted') {
        reply(400, { error: "outcome must be 'won' | 'stalled' | 'aborted'" })
        return true
      }
      const honest = body.honestRace as { budgetTrippedDelta?: unknown; fakeProviderDelta?: unknown } | undefined
      if (
        typeof honest?.budgetTrippedDelta !== 'number' ||
        typeof honest?.fakeProviderDelta !== 'number' ||
        honest.budgetTrippedDelta < 0 ||
        honest.fakeProviderDelta < 0
      ) {
        reply(400, {
          error: 'honestRace{budgetTrippedDelta, fakeProviderDelta} is required — read the deltas from Prometheus; the assertion is recorded, never assumed',
        })
        return true
      }
      const input: EndAttemptInput = {
        outcome,
        honestRace: { budgetTrippedDelta: honest.budgetTrippedDelta, fakeProviderDelta: honest.fakeProviderDelta },
      }
      const envelope = tracker.end(input)
      reply(200, { eventId: envelope.eventId, payload: envelope.payload })
      return true
    } catch (err) {
      if (err instanceof OrphanSweepError) {
        // The pre-start sweep could not clear (or even read) older attempts —
        // refusing the start is the orphan guarantee, not an internal error.
        reply(503, { error: `start refused — ${err.message}` })
        return true
      }
      reply(409, { error: err instanceof Error ? err.message : String(err) })
      return true
    }
  }

  reply(405, { error: 'method not allowed' })
  return true
}
