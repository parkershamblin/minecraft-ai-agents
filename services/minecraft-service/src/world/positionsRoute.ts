import type http from 'node:http'

export interface PositionSnapshotEntry {
  username: string
  x: number
  y: number
  z: number
}

/**
 * Read-only positions feed for the Mission Control world map (dashboard PR
 * pairs with this): GET /internal/positions → { positions, capturedAt }.
 *
 * Contract: villagers with no live bot session are OMITTED — never emitted
 * with null coordinates — so the dashboard's trail ring buffer stays clean.
 * `y` is included for completeness; the 2D isometric map projects x/z only.
 */
export async function handlePositionsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  snapshot: () => PositionSnapshotEntry[],
): Promise<boolean> {
  if (req.url !== '/internal/positions') {
    return false
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return true
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ positions: snapshot(), capturedAt: new Date().toISOString() }))
  return true
}
