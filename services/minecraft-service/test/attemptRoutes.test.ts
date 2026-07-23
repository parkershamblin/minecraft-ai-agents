import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { AttemptTracker } from '../src/attempt/attemptTracker.ts'
import { OrphanSweepError } from '../src/attempt/orphanSweep.ts'
import { handleAttemptRoute } from '../src/attempt/attemptRoutes.ts'

function fakeReq(method: string, url: string, body?: unknown): http.IncomingMessage {
  async function* chunks() {
    if (body !== undefined) {
      yield Buffer.from(JSON.stringify(body))
    }
  }
  return Object.assign(chunks(), { method, url }) as unknown as http.IncomingMessage
}

function fakeRes() {
  const state = { status: 0, body: '' }
  const res = {
    writeHead: (status: number) => {
      state.status = status
    },
    end: (payload?: string) => {
      state.body = payload ?? ''
    },
  } as unknown as http.ServerResponse
  return { res, state }
}

const TEAMS = [{ teamId: 'red', villagerIds: ['019f8b48-0000-7000-8000-00000000000a'] }]
const startBody = { difficulty: 'normal', teams: TEAMS }

describe('handleAttemptRoute /internal/attempt/start', () => {
  it('opens the attempt when the pre-start sweep passes', async () => {
    let guarded = 0
    const tracker = new AttemptTracker(() => undefined, {
      preStartGuard: async () => {
        guarded += 1
      },
    })
    const { res, state } = fakeRes()
    const handled = await handleAttemptRoute(fakeReq('POST', '/internal/attempt/start', startBody), res, tracker)
    expect(handled).toBe(true)
    expect(guarded).toBe(1)
    expect(state.status).toBe(201)
  })

  it('maps a failed pre-start sweep to 503 — the start is refused, not half-run', async () => {
    const tracker = new AttemptTracker(() => undefined, {
      preStartGuard: async () => {
        throw new OrphanSweepError('ledger read failed (http://event-service:8081/events): fetch failed')
      },
    })
    const { res, state } = fakeRes()
    await handleAttemptRoute(fakeReq('POST', '/internal/attempt/start', startBody), res, tracker)
    expect(state.status).toBe(503)
    expect(JSON.parse(state.body).error).toMatch(/start refused — .*ledger read failed/)
    expect(tracker.status()).toEqual({ active: false })
  })
})
