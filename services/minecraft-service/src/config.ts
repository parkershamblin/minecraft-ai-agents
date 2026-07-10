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
  MOVE_THROTTLE_MS: z.coerce.number().int().min(500).default(5000),
  // Village-scale earshot: vanilla spawn scatter alone is ~20 blocks, and a
  // village is ~64 across. 16 made villagers deaf to neighbors in practice.
  CHAT_EARSHOT_BLOCKS: z.coerce.number().min(1).default(48),
  SPAWN_TIMEOUT_MS: z.coerce.number().int().default(30000),
  // Freshness guard on commands.minecraft (same failure class as the percept
  // guard): a stale committed offset must never replay the past into the world.
  COMMAND_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(600),
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
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.message}`)
  }
  return parsed.data
}
