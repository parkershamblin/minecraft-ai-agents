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

export const hazardEscapes = new Counter({
  name: 'civ_hazard_escapes_total',
  help: 'Powder-snow trap episodes resolved, by outcome (escaped | escape_failed)',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

// Per-player material tracking (post-M2). `player` is the in-game username —
// the repo's first entity-level label, bounded by MAX_PLAYERS (30) × item
// types actually touched. kind: villager (bot) | player (human via RCON).
export const playerInventoryItems = new Gauge({
  name: 'civ_player_inventory_items',
  help: 'Current inventory count per player and item',
  labelNames: ['player', 'item', 'kind'] as const,
  registers: [registry],
})

export const materialsCollected = new Counter({
  name: 'civ_materials_collected_total',
  help: 'Items gained per player and item (positive inventory deltas between polls)',
  labelNames: ['player', 'item', 'kind'] as const,
  registers: [registry],
})

export const inventoryPolls = new Counter({
  name: 'civ_inventory_polls_total',
  help: 'Inventory poll cycles by source (bots = in-memory, rcon = human players)',
  labelNames: ['source', 'outcome'] as const,
  registers: [registry],
})

// civ_player_inventory_items only has series for held items, so it undercounts
// empty-handed players — this gauge is the honest "who is being watched" count.
export const playersTracked = new Gauge({
  name: 'civ_players_tracked',
  help: 'Players currently tracked by the inventory poller',
  labelNames: ['kind'] as const,
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
