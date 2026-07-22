import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { handlePositionsRoute } from '../src/world/positionsRoute.ts'

function fakeRes() {
  const chunks: string[] = []
  let status = 0
  const res = {
    writeHead: (code: number) => {
      status = code
    },
    end: (body?: string) => {
      if (body) chunks.push(body)
    },
  } as unknown as http.ServerResponse
  return { res, status: () => status, body: () => JSON.parse(chunks.join('') || 'null') }
}

const req = (method: string, url: string) => ({ method, url }) as http.IncomingMessage

describe('/internal/positions', () => {
  it('ignores unrelated urls so the composed route chain falls through', async () => {
    const { res } = fakeRes()
    expect(await handlePositionsRoute(req('GET', '/internal/attempt'), res, () => [])).toBe(false)
    expect(await handlePositionsRoute(req('GET', '/metrics'), res, () => [])).toBe(false)
  })

  it('returns the snapshot with a capturedAt stamp', async () => {
    const { res, status, body } = fakeRes()
    const handled = await handlePositionsRoute(req('GET', '/internal/positions'), res, () => [
      { username: 'Wren', x: -8.2, y: 64, z: -20.7 },
      { username: 'Petra', x: 60, y: 63, z: 8 },
    ])
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    const parsed = body()
    expect(parsed.positions).toEqual([
      { username: 'Wren', x: -8.2, y: 64, z: -20.7 },
      { username: 'Petra', x: 60, y: 63, z: 8 },
    ])
    expect(Number.isNaN(Date.parse(parsed.capturedAt))).toBe(false)
  })

  it('an empty fleet is an empty list, not an error', async () => {
    const { res, status, body } = fakeRes()
    expect(await handlePositionsRoute(req('GET', '/internal/positions'), res, () => [])).toBe(true)
    expect(status()).toBe(200)
    expect(body().positions).toEqual([])
  })

  it('rejects non-GET methods', async () => {
    const { res, status } = fakeRes()
    expect(await handlePositionsRoute(req('POST', '/internal/positions'), res, () => [])).toBe(true)
    expect(status()).toBe(405)
  })
})
