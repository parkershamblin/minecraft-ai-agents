import mineflayer, { type Bot } from 'mineflayer'
import type Redis from 'ioredis'
import type { Config } from '../config.ts'
import { logger } from '../logging.ts'
import { botSessions, reconnects } from '../metrics.ts'
import { buildEnvelope } from '../events/envelope.ts'
import type { EventProducer } from '../kafka/producer.ts'
import { MovementTracker } from '../world/movementTracker.ts'
import { buildSnapshot, type NearbyVillager } from '../world/snapshot.ts'
import type { Position } from '../world/position.ts'

type SpawnReason = 'seed' | 'respawn' | 'reconnect'

interface SessionDeps {
  config: Config
  producer: EventProducer
  redis: Redis
  /** the registry routes chat lines through the ChatRouter */
  onChat: (session: BotSession, speakerUsername: string, message: string) => void
  /** positions of all other sessions, for the snapshot's nearbyVillagers */
  others: () => NearbyVillager[]
}

/**
 * One villager's body: a Mineflayer connection plus its observers. Ephemeral
 * by design — no personality, no persistence. Owns auto-reconnect with
 * exponential backoff; intentional despawn() wins over reconnection.
 */
export class BotSession {
  bot: Bot | null = null

  private despawned = false
  private nextSpawnReason: SpawnReason = 'seed'
  private reconnectDelayMs = 1_000
  private reconnectTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private movement: MovementTracker
  private spawnWaiters: Array<(reason: SpawnReason) => void> = []
  private log

  constructor(
    readonly villagerId: string,
    readonly username: string,
    private readonly deps: SessionDeps,
  ) {
    this.movement = new MovementTracker(deps.config.MOVE_THROTTLE_MS)
    this.log = logger.child({ villagerId, username })
  }

  get position(): Position | null {
    const p = this.bot?.entity?.position
    return p ? { x: p.x, y: p.y, z: p.z } : null
  }

  get active(): boolean {
    return this.bot?.entity !== undefined && !this.despawned
  }

  /** Resolves with the spawn reason once the bot is standing in the world. */
  awaitSpawn(timeoutMs: number): Promise<SpawnReason> {
    if (this.active) {
      return Promise.resolve(this.nextSpawnReason)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('spawn timeout')), timeoutMs)
      this.spawnWaiters.push((reason) => {
        clearTimeout(timer)
        resolve(reason)
      })
    })
  }

  connect(): void {
    if (this.despawned) {
      return
    }
    const { config } = this.deps
    this.log.info({ host: config.MC_HOST, version: config.MC_VERSION }, 'connecting bot')
    this.bot = mineflayer.createBot({
      host: config.MC_HOST,
      port: config.MC_PORT,
      version: config.MC_VERSION,
      username: this.username,
      auth: 'offline',
      // Bots navigate by pathfinder, not by sight — 'tiny' keeps 20 bots from
      // holding 20 copies of the world (the single biggest RAM lever).
      viewDistance: 'tiny',
    })
    this.wire(this.bot)
  }

  private wire(bot: Bot): void {
    bot.once('spawn', () => this.onSpawn())
    bot.on('death', () => {
      this.nextSpawnReason = 'respawn'
    })
    bot.on('end', (reason) => this.onEnd(reason))
    bot.on('error', (err) => this.log.warn({ err: err.message }, 'bot error'))
    bot.on('chat', (username, message) => this.deps.onChat(this, username, message))
    bot.on('move', () => this.onMove())
  }

  private onSpawn(): void {
    const reason = this.nextSpawnReason
    this.log.info({ reason }, 'bot spawned')
    this.reconnectDelayMs = 1_000
    botSessions.inc()

    void this.deps.producer.publish(
      'world.events',
      buildEnvelope({
        eventType: 'VillagerSpawned',
        aggregateId: this.villagerId,
        payload: {
          villagerId: this.villagerId,
          name: this.username,
          position: this.position ?? { x: 0, y: 0, z: 0 },
          spawnReason: reason,
        },
      }),
    )

    this.nextSpawnReason = 'reconnect' // any future spawn that isn't a death is a reconnect
    this.startSnapshots()

    for (const waiter of this.spawnWaiters.splice(0)) {
      waiter(reason)
    }
  }

  private onEnd(reason: string): void {
    this.stopSnapshots()
    if (this.bot?.entity) {
      botSessions.dec()
    }
    if (this.despawned) {
      return
    }
    this.log.warn({ reason, retryInMs: this.reconnectDelayMs }, 'bot disconnected — scheduling reconnect')
    reconnects.inc()
    this.nextSpawnReason = 'reconnect'
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs)
    // Exponential backoff with jitter, capped at 60s.
    this.reconnectDelayMs = Math.min(60_000, this.reconnectDelayMs * 2) + Math.floor(Math.random() * 250)
  }

  private onMove(): void {
    const position = this.position
    if (!position) {
      return
    }
    const emission = this.movement.check(position, Date.now())
    if (!emission) {
      return
    }
    void this.deps.producer.publish(
      'world.events',
      buildEnvelope({
        eventType: 'VillagerMoved',
        aggregateId: this.villagerId,
        payload: { villagerId: this.villagerId, ...emission },
      }),
    )
  }

  private startSnapshots(): void {
    this.stopSnapshots()
    const { config, redis } = this.deps
    this.snapshotTimer = setInterval(() => {
      if (!this.bot) {
        return
      }
      const snapshot = buildSnapshot(this.villagerId, this.bot, this.deps.others())
      if (snapshot) {
        void redis
          .set(`world:${this.villagerId}`, JSON.stringify(snapshot), 'EX', config.SNAPSHOT_TTL_SECONDS)
          .catch((err: Error) => this.log.warn({ err: err.message }, 'snapshot write failed'))
      }
    }, config.SNAPSHOT_INTERVAL_MS)
  }

  private stopSnapshots(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }
  }

  /** Intentional teardown — wins over auto-reconnect. */
  async despawn(): Promise<void> {
    this.despawned = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.stopSnapshots()
    this.bot?.quit()
    await this.deps.redis.del(`world:${this.villagerId}`)
    this.log.info('bot despawned')
  }
}
