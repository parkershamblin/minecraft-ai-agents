import { z } from 'zod'

// Fail-fast, typed config (12-factor): process env > defaults. MC_VERSION is
// THE pin — see docs/architecture/05-repository-devops.md §3.
const schema = z.object({
  MC_HOST: z.string().default('localhost'),
  MC_PORT: z.coerce.number().int().default(25565),
  MC_VERSION: z.string().default('1.21.6'),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().int().default(8003),
  LOG_LEVEL: z.string().default('info'),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(250).default(1000),
  SNAPSHOT_TTL_SECONDS: z.coerce.number().int().min(2).default(10),
  // nearbyResources survey (M2-2). Its own cadence, slower than the snapshot:
  // findBlocks sweeps are the cost, and "what's around me" changes on foot
  // speed, not tick speed. 0 disables the scan (snapshot omits the field).
  RESOURCE_SCAN_INTERVAL_MS: z.coerce.number().int().min(0).default(5000),
  // Radius matches GatherParams' default 48 — "in sight" must mean "gatherable".
  RESOURCE_SCAN_DISTANCE: z.coerce.number().int().min(4).max(64).default(48),
  RESOURCE_SCAN_COUNT_CAP: z.coerce.number().int().min(1).default(32),
  RESOURCE_SCAN_Y_BAND: z.coerce.number().int().min(1).default(16),
  // Skip gate (measured: ungated 5s scans pin a core at 20 bots — the event
  // loop that executes commands). A bot rescans only after moving this far…
  RESOURCE_SCAN_MOVE_BLOCKS: z.coerce.number().min(1).default(8),
  // …or when the survey is this stale (neighbors dig; one refresh per tick).
  RESOURCE_SCAN_MAX_AGE_MS: z.coerce.number().int().min(1000).default(60000),
  // Hard spacing floor between sweeps, whatever the gates say: a bot mid-trip
  // re-trips the movement gate on EVERY 5s check and swept continuously
  // (profiled 2026-07-17: 14% of the pinned core at night). The survey feeds
  // deliberation (30s+ cadence), not reflexes — 15s staleness is free.
  RESOURCE_SCAN_MIN_SWEEP_MS: z.coerce.number().int().min(0).default(15000),
  MOVE_THROTTLE_MS: z.coerce.number().int().min(500).default(5000),
  // POV film rig (RB-3, ADR 10) — SIDECAR-ONLY since the pov-rig extraction:
  // read exclusively by src/pov/sidecar.ts, which runs in its own container
  // (compose profile `pov`) with its own spectator cam bots. The fleet
  // process NEVER reads these and never loads any viewer code
  // (test/noPovInFleet.test.ts enforces that). Enabling/disabling the rig
  // is a pov-rig container start/stop — the fleet is never recreated for it.
  POV_VIEWER: z.coerce.number().int().min(0).max(1).default(0),
  POV_PORT_BASE: z.coerce.number().int().min(1024).default(3100),
  POV_VIEWER_COUNT: z.coerce.number().int().min(1).max(16).default(6),
  POV_VIEW_DISTANCE: z.coerce.number().int().min(1).max(8).default(4),
  // Cam→racer assignment, in tile order (PovGrid.tsx / film/pov-grid.html
  // hardcode 3100..3105 in villagers.json seed order). Deterministic: tile N
  // always shows racer N, unlike the old spawn-order port pool.
  POV_ROSTER: z.string().default('Elara,Bram,Wren,Ansel,Petra,Fen'),
  POV_HEALTH_PORT: z.coerce.number().int().min(1024).default(8004),
  // Powder-snow hazard watch (post-M2): per-bot O(1) probe — two blockAt
  // reads, never a sweep. 0 disables the reflex entirely.
  HAZARD_WATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(1500),
  // Backoff between escape attempts while a trap episode stays open.
  HAZARD_ESCAPE_RETRY_MS: z.coerce.number().int().min(1000).default(15000),
  // Powder snow blocks one attempt may dig before giving up (drops nothing,
  // instantly hand-diggable — the budget bounds effort, not resources).
  HAZARD_DIG_BUDGET: z.coerce.number().int().min(1).default(12),
  // The whole attempt races this deadline (corollary 3: never await a
  // mineflayer promise un-raced) — a timed-out attempt is escape_failed.
  HAZARD_ESCAPE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(25000),
  // Eat reflex (SV-6): a 4th sibling interval mirroring the hazard watch.
  // 0 disables the reflex entirely. Thresholds are food points (0..20).
  EAT_CHECK_INTERVAL_MS: z.coerce.number().int().min(0).default(2000),
  EAT_FOOD_THRESHOLD: z.coerce.number().int().min(1).max(20).default(14),
  EAT_CRITICAL_FOOD: z.coerce.number().int().min(0).max(20).default(6),
  EAT_RECOVER_FOOD: z.coerce.number().int().min(1).max(20).default(10),
  // Hurt modifier: also eat when health ≤ this and food is below the regen
  // gate (18, a game constant) — eating restarts natural healing. 0 disables.
  EAT_HURT_HEALTH_THRESHOLD: z.coerce.number().int().min(0).max(20).default(14),
  EAT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),
  EAT_RETRY_MS: z.coerce.number().int().min(1000).default(10000),
  EAT_BANNED_FOODS: z.string().default('pufferfish,spider_eye,poisonous_potato,chorus_fruit'),
  EAT_DESPERATION_FOODS: z.string().default('rotten_flesh'),
  // Threat watcher + maneuvers (SV-12a/b): the 5th sibling interval. 0
  // disables detection (and with it fight/flee) entirely.
  THREAT_WATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(1000),
  // Fleet-wide concurrent fight cap — spike-measured: pursuit event-loop p99
  // 141.8ms at 20 concurrent, 38.8ms at 5. 0 = flee-only fleet (rollout
  // stage 1); overflow downgrades to flee, never queues.
  THREAT_MAX_CONCURRENT_FIGHTS: z.coerce.number().int().min(0).default(4),
  THREAT_FIGHT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  THREAT_FLEE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(12000),
  // Backoff between maneuvers within one episode (the hazard escapeRetryMs
  // pattern): the first runs immediately; a failed one waits. Bounds the
  // fleet's night-flee duty cycle — 20 back-to-back flee cycles pinned the
  // event loop on the first night. 0 restores the hot loop.
  THREAT_MANEUVER_COOLDOWN_MS: z.coerce.number().int().min(0).default(5000),
  // Flee buddy bias: steer toward the nearest villager inside a 60° cone of
  // the away-vector (fleeing INTO the village is story). 0 disables.
  THREAT_FLEE_BUDDY_RADIUS: z.coerce.number().int().min(0).default(32),
  // Default stance until the brain's stance rider ships (SV-13): cautious =
  // armed villagers still flee melee mobs; brave = they stand and fight;
  // guard (the guard arc) = brave's courage + the wider ranged window +
  // the post tether. NEVER flip mid-race — stance is read live but the
  // tether re-anchors only on spawn.
  THREAT_DEFAULT_STANCE: z.enum(['brave', 'cautious', 'guard']).default('cautious'),
  // Guard tether: beyond postRadius an idle guard walks home; 12 clears a
  // flee hop's leftover drift and sits above the melee danger radius (10)
  // so post-holding and episode-opening don't fight. repathMs re-sets a
  // stalled homeward goal.
  THREAT_GUARD_POST_RADIUS: z.coerce.number().int().min(4).default(12),
  THREAT_GUARD_REPATH_MS: z.coerce.number().int().min(1000).default(15000),
  // Armor auto-equip reflex (SV-14-lite): 0 disables entirely; the equip
  // is raced against its timeout (never trust a mineflayer promise).
  ARMOR_CHECK_INTERVAL_MS: z.coerce.number().int().min(0).default(5000),
  ARMOR_EQUIP_TIMEOUT_MS: z.coerce.number().int().min(1000).default(5000),
  // Hunt (SV-8): the chase deadline must stay under hunt's per-verb timeout
  // (30s) minus a ~8s collection reserve.
  HUNT_CHASE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20000),
  // Pathfinder budgets: tickTimeout is the SYNCHRONOUS per-physics-tick A*
  // slice on the shared event loop (default 40ms × 20 pathing bots pins it);
  // thinkTimeout is the total wall-clock path budget, raised to compensate.
  PATHFINDER_TICK_TIMEOUT_MS: z.coerce.number().int().min(1).default(10),
  PATHFINDER_THINK_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  // A* frontier bound: path cost allowed beyond the straight-line estimate.
  // The library default (-1, unlimited) lets an UNREACHABLE goal — a cornered
  // flee hop, a target across a ravine — explore the whole loaded world for
  // the full think budget before conceding (profiled 2026-07-17: A* was 44%
  // of the pinned core during the night siege, much of it exactly these).
  // 80 clears every legitimate trip (gather caps at 64) and an out-of-budget
  // goal still yields the same best-effort partial path, just sooner.
  PATHFINDER_SEARCH_RADIUS: z.coerce.number().int().min(16).default(80),
  // Turn-scoped block cache under physics SIMULATIONS (physicsSimCache.ts):
  // the pathfinder's per-tick sprint/jump gating re-simulates over the same
  // handful of blocks hundreds of times per gate chain — ~40% of the daytime
  // core before the cache. 0 disables the wrap (the one-tick rollback lever).
  PHYSICS_SIM_BLOCK_CACHE: z.coerce.number().int().min(0).max(1).default(1),
  // Village-scale earshot: vanilla spawn scatter alone is ~20 blocks, and a
  // village is ~64 across. 16 made villagers deaf to neighbors in practice.
  CHAT_EARSHOT_BLOCKS: z.coerce.number().min(1).default(48),
  SPAWN_TIMEOUT_MS: z.coerce.number().int().default(30000),
  // Orphan-attempt sweep (RB-2 hardening): the ledger the boot/pre-start
  // sweeps read to close AttemptStarted left dangling by a mid-attempt
  // restart. The window must cover agent-service's race-rehydration lookback
  // (6h) or an orphan can still be resurrected as a live race; 0 disables
  // the sweep entirely (the rollback lever).
  EVENT_SERVICE_URL: z.string().default('http://localhost:8081'),
  ATTEMPT_ORPHAN_WINDOW_HOURS: z.coerce.number().min(0).default(24),
  // Freshness guard on commands.minecraft (same failure class as the percept
  // guard): a stale committed offset must never replay the past into the world.
  COMMAND_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(600),
  // Watchdog ceiling: payload.timeoutMs arrives off the wire — unclamped, one
  // oversized value pins its partition (and every partition-mate) for the
  // duration. Matches the contract's per-verb ceiling (TIMEOUT_TABLE_MAX_MS).
  COMMAND_TIMEOUT_MAX_MS: z.coerce.number().int().min(1000).default(60000),
  // Per-player inventory metrics: one process-wide poll — in-memory reads for
  // bots, per-slot RCON `data get` for humans. 0 disables the poller entirely.
  INVENTORY_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(15000),
  // RCON on the Paper container (compose-internal minecraft:25575, never
  // published to the host). Empty host = human-inventory polling disabled;
  // bots don't need RCON. Must match the minecraft service's RCON_PASSWORD.
  RCON_HOST: z.string().default(''),
  RCON_PORT: z.coerce.number().int().default(25575),
  RCON_PASSWORD: z.string().default('civ_rcon'),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema
    .refine((c) => c.EAT_CRITICAL_FOOD < c.EAT_RECOVER_FOOD && c.EAT_RECOVER_FOOD <= c.EAT_FOOD_THRESHOLD, {
      message: 'eat thresholds must satisfy EAT_CRITICAL_FOOD < EAT_RECOVER_FOOD <= EAT_FOOD_THRESHOLD',
    })
    .safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.message}`)
  }
  return parsed.data
}
