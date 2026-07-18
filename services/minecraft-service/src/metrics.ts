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

// Survival reflexes (SV-6/8/12). no_effect = post-consume food delta ≤ 0 —
// the ghost-dig honesty rule applied to eating.
export const eatReflex = new Counter({
  name: 'civ_eat_reflex_total',
  help: 'Eat reflex attempts by outcome (ate | ate_desperate | no_effect | failed | timeout)',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

export const threatEpisodes = new Counter({
  name: 'civ_threat_episodes_total',
  help: 'Threat episodes closed, by outcome (killed | escaped | aborted)',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

export const threatResponses = new Counter({
  name: 'civ_threat_responses_total',
  help: 'Fight/flee maneuvers run, by response and outcome',
  labelNames: ['response', 'outcome'] as const,
  registers: [registry],
})

// A slot leak is visible in one scrape: the gauge should idle at 0.
export const threatFightsActive = new Gauge({
  name: 'civ_threat_fights_active',
  help: 'Concurrent fights currently holding a fleet fight slot',
  registers: [registry],
})

export const armorEquips = new Counter({
  name: 'civ_armor_equips_total',
  help: 'Armor auto-equip reflex outcomes (equipped | failed | timeout) by slot',
  labelNames: ['slot', 'outcome'] as const,
  registers: [registry],
})

export const hunts = new Counter({
  name: 'civ_hunts_total',
  help: 'Hunt commands by family and outcome (killed | empty | escaped | not_found | aborted) — the herd depletion curve',
  labelNames: ['family', 'outcome'] as const,
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

// RB-2: commands admitted to per-villager lanes but not yet finished — the
// backlog the kafka fetch cycle used to hide. Idles at 0; sustained >6 at a
// 6-bot race means the world is falling behind the brains.
export const commandLaneDepth = new Gauge({
  name: 'civ_command_lane_depth',
  help: 'Commands enqueued or executing in per-villager dispatch lanes',
  registers: [registry],
})

// RB-1: race telemetry — one increment per (team, milestone) per attempt.
export const progressionMilestones = new Counter({
  name: 'civ_progression_milestones_total',
  help: 'ProgressionMilestone events emitted, by milestone and team',
  labelNames: ['milestone', 'team'] as const,
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

/** /healthz + /metrics on the canonical minecraft-service port (8003).
 *  `extraRoutes` (RB-1) lets feature modules mount /internal handlers —
 *  return true when the request was handled. */
export function startAdminServer(
  port: number,
  extraRoutes?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>,
): http.Server {
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
    if (extraRoutes && (await extraRoutes(req, res))) {
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(port, () => logger.info({ port }, 'admin server listening'))
  return server
}
