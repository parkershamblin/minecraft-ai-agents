import './kafka/codecs.ts' // register Snappy before any Kafka client exists
import { Redis } from 'ioredis'
import { loadConfig } from './config.ts'
import { logger } from './logging.ts'
import { startAdminServer } from './metrics.ts'
import { EventProducer } from './kafka/producer.ts'
import { CommandConsumer } from './kafka/commandConsumer.ts'
import { BotRegistry } from './bots/BotRegistry.ts'

const config = loadConfig()
logger.info(
  { mc: `${config.MC_HOST}:${config.MC_PORT}`, version: config.MC_VERSION, kafka: config.KAFKA_BROKERS },
  'minecraft-service starting',
)

const redis = new Redis(config.REDIS_URL, { lazyConnect: true })
const producer = new EventProducer(config.KAFKA_BROKERS.split(','))
const registry = new BotRegistry(config, producer, redis)
const consumer = new CommandConsumer(config.KAFKA_BROKERS.split(','), registry, producer)
const admin = startAdminServer(config.PORT)

await redis.connect()
await registry.roster.load()
await producer.connect()
await consumer.start()
logger.info('minecraft-service ready — awaiting spawn commands')

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down')
  try {
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
