import http from 'node:http'
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client'
import { logger } from './logging.ts'

export const registry = new Registry()
collectDefaultMetrics({ register: registry })

export const botSessions = new Gauge({
  name: 'civ_bot_sessions',
  help: 'Live Mineflayer bot sessions',
  registers: [registry],
})

export const worldEventsEmitted = new Counter({
  name: 'civ_world_events_emitted_total',
  help: 'world.events facts published',
  labelNames: ['type'] as const,
  registers: [registry],
})

export const commandsProcessed = new Counter({
  name: 'civ_commands_processed_total',
  help: 'ActionRequested commands handled',
  labelNames: ['action', 'outcome'] as const,
  registers: [registry],
})

export const reconnects = new Counter({
  name: 'civ_bot_reconnects_total',
  help: 'Bot auto-reconnect attempts',
  registers: [registry],
})

/** /healthz + /metrics on the canonical minecraft-service port (8003). */
export function startAdminServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"UP"}')
      return
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': registry.contentType })
      res.end(await registry.metrics())
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(port, () => logger.info({ port }, 'admin server listening'))
  return server
}
