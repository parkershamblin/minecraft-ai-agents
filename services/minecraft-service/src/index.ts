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

const consumer = new CommandConsumer(config.KAFKA_BROKERS.split(','), executor)
const admin = startAdminServer(config.PORT)

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
