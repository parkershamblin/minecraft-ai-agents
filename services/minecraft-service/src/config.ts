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
  MOVE_THROTTLE_MS: z.coerce.number().int().min(500).default(5000),
  // Village-scale earshot: vanilla spawn scatter alone is ~20 blocks, and a
  // village is ~64 across. 16 made villagers deaf to neighbors in practice.
  CHAT_EARSHOT_BLOCKS: z.coerce.number().min(1).default(48),
  SPAWN_TIMEOUT_MS: z.coerce.number().int().default(30000),
  // Freshness guard on commands.minecraft (same failure class as the percept
  // guard): a stale committed offset must never replay the past into the world.
  COMMAND_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(600),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.message}`)
  }
  return parsed.data
}
