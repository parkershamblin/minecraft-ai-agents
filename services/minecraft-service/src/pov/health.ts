import http from 'node:http'
import { logger } from '../logging.ts'

const log = logger.child({ module: 'pov-health' })

/**
 * Deliberately NOT startAdminServer: that carries the fleet's prom registry
 * (civ_bot_sessions etc.) and would advertise a zero-bot fleet from the
 * rig's port. The rig's health is "process up" + per-tile states.
 */
export interface TileStatus {
  cam: string
  racer: string
  port: number
  state: string
  lastMoveTs: string | null
}

export function startHealthServer(port: number, tiles: () => TileStatus[]): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"UP"}')
      return
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tiles: tiles(), capturedAt: new Date().toISOString() }))
      return
    }
    res.writeHead(404).end()
  })
  server.listen(port, () => log.info({ port }, 'pov health server listening'))
  return server
}
