import './kafka/codecs.ts' // register Snappy before any Kafka client exists
import { Redis } from 'ioredis'
import { loadConfig } from './config.ts'
import { logger } from './logging.ts'
import { inventoryPolls, materialsCollected, playerInventoryItems, playersTracked, startAdminServer } from './metrics.ts'
import { buildEnvelope } from './events/envelope.ts'
import { EventProducer } from './kafka/producer.ts'
import { CommandConsumer } from './kafka/commandConsumer.ts'
import { CommandExecutor } from './actions/executor.ts'
import { CommandDedupe } from './redis/dedupe.ts'
import { BotRegistry } from './bots/BotRegistry.ts'
import { AttemptTracker } from './attempt/attemptTracker.ts'
import { OrphanSweeper } from './attempt/orphanSweep.ts'
import { handleAttemptRoute } from './attempt/attemptRoutes.ts'
import { handlePositionsRoute } from './world/positionsRoute.ts'
import { RconClient } from './rcon/rcon.ts'
import { InventoryTracker } from './world/inventoryTracker.ts'
import { InventoryPoller } from './world/inventoryPoller.ts'

const config = loadConfig()
logger.info(
  { mc: `${config.MC_HOST}:${config.MC_PORT}`, version: config.MC_VERSION, kafka: config.KAFKA_BROKERS },
  'minecraft-service starting',
)

const redis = new Redis(config.REDIS_URL, { lazyConnect: true })
const producer = new EventProducer(config.KAFKA_BROKERS.split(','))
const registry = new BotRegistry(config, producer, redis)
const dedupe = new CommandDedupe(redis)

const executor = new CommandExecutor({
  getSession: (villagerId) => registry.get(villagerId),
  spawn: (villagerId, username) => registry.spawn(villagerId, username),
  despawn: (villagerId) => registry.despawn(villagerId),
  isFresh: (commandId) => dedupe.isFresh(commandId),
  maxCommandAgeMs: config.COMMAND_MAX_AGE_SECONDS * 1_000,
  maxTimeoutMs: config.COMMAND_TIMEOUT_MAX_MS,
  publishOutcome: (command, eventType, extra) =>
    producer.publish(
      'world.events',
      buildEnvelope({
        eventType,
        aggregateId: command.aggregateId,
        correlationId: command.correlationId,
        causationId: command.eventId,
        payload: extra,
      }),
    ),
})

// RB-1 race machinery: the tracker watches every world.events publish and
// maps outcomes to ProgressionMilestone; the harness drives the attempt
// lifecycle over /internal/attempt. The orphan sweep closes AttemptStarted
// left dangling by a mid-attempt restart: eagerly at boot, and as the
// tracker's pre-start guard so a new attempt is never stamped over one.
const orphanSweeper = new OrphanSweeper({
  eventServiceUrl: config.EVENT_SERVICE_URL,
  windowHours: config.ATTEMPT_ORPHAN_WINDOW_HOURS,
  publish: (envelope) => producer.publish('world.events', envelope),
  isKnownLocally: (attemptId) => attempts.isCurrentOrClosed(attemptId),
  noteClosed: (attemptId) => attempts.noteClosed(attemptId),
  log: logger.child({ module: 'orphan-sweep' }),
})
const attempts = new AttemptTracker((envelope) => void producer.publish('world.events', envelope), {
  preStartGuard: async () => {
    await orphanSweeper.sweep('pre-start')
  },
})
producer.onWorldEvent((envelope) => attempts.observe(envelope))

// Boot cleanup, off the boot critical path: retry until the ledger answers
// (event-service may still be starting) so Mission Control phantoms clear
// without waiting for the next attempt. The pre-start guard stays the
// blocking enforcement point either way.
const BOOT_SWEEP_RETRY_MS = 60_000
function runBootSweep(): void {
  orphanSweeper.sweep('boot').catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), retryInMs: BOOT_SWEEP_RETRY_MS },
      'boot orphan sweep failed — will retry',
    )
    setTimeout(runBootSweep, BOOT_SWEEP_RETRY_MS)
  })
}

const consumer = new CommandConsumer(config.KAFKA_BROKERS.split(','), executor)
// extraRoutes takes ONE callback — compose handlers; each returns true when
// it owned the request.
const admin = startAdminServer(
  config.PORT,
  async (req, res) =>
    (await handleAttemptRoute(req, res, attempts)) ||
    (await handlePositionsRoute(req, res, () => registry.positionsSnapshot())),
)

const inventoryPoller = new InventoryPoller({
  intervalMs: config.INVENTORY_POLL_INTERVAL_MS,
  botViews: () => registry.inventoryViews(),
  humanNames: () => registry.humanPlayerNames(),
  connectRcon: config.RCON_HOST
    ? () => RconClient.connect(config.RCON_HOST, config.RCON_PORT, config.RCON_PASSWORD)
    : undefined,
  tracker: new InventoryTracker({ gauge: playerInventoryItems, counter: materialsCollected }),
  polls: inventoryPolls,
  trackedGauge: playersTracked,
  log: logger.child({ module: 'inventory' }),
})
inventoryPoller.start()

await redis.connect()
await registry.roster.load()
await producer.connect()
runBootSweep()
await consumer.start()
logger.info('minecraft-service ready — awaiting spawn commands')

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down')
  try {
    inventoryPoller.stop()
    await consumer.stop()
    await registry.shutdown()
    await producer.disconnect()
    redis.disconnect()
    admin.close()
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
